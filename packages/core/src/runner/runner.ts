import { Cause, Clock, Crypto, DateTime, Deferred, Effect, Exit, Option, Schema } from "effect"
import { strictQuietParseOptions } from "../domain/decode.js"
import type { RunStage } from "../domain/errors.js"
import { RunFailure } from "../domain/errors.js"
import type { ModelRole } from "../domain/events.js"
import type { ArtifactId, AttemptId, RunId } from "../domain/ids.js"
import type {
  ArtifactRecord,
  AttemptResult,
  CriterionResult,
  Manifest,
  ModelAccounting,
  RunResult
} from "../domain/result.js"
import type { ResolvedConfig } from "../domain/config.js"
import type { Criterion, InputsRecord, LoadedSpec, ScenarioContract } from "../domain/spec.js"
import type { ObserveResult, ToolErrorCode, ToolErrorResult, ToolName } from "../domain/tools.js"
import { toolParamSchemas } from "../domain/tools.js"
import { resolveInputPrecedence } from "../config/index.js"
import { resolveInputs } from "../interpolate/index.js"
import { aggregate } from "../policy/aggregate.js"
import { makeActionGuidance, recordAction } from "../policy/actions.js"
import type { BudgetState } from "../policy/budgets.js"
import { canStartModelCall, chargeTokens, makeBudgetState, recordModelCall } from "../policy/budgets.js"
import { enforceEvidenceIntegrity } from "../policy/evidence.js"
import { checkNavigationOrigin } from "../policy/origins.js"
import type { Registries } from "../registry/index.js"
import { verifyCriterionBinding } from "../registry/index.js"
import { BrowserDriver } from "../services/browser.js"
import type { BrowserSession, CaptureOutcome } from "../services/browser.js"
import { FixtureManager } from "../services/fixture.js"
import type { FixtureSession } from "../services/fixture.js"
import { ModelProvider } from "../services/model.js"
import type { PromptMessage, PromptPart } from "../services/model.js"
import { Verifier } from "../services/verifier.js"
import type { EvidenceItem } from "../services/verifier.js"
import { RunStore } from "../store/runStore.js"
import { freezeContract } from "./contract.js"
import { systemPrompt, toolDefinitions } from "./prompt.js"

export interface RunScenarioRequest {
  readonly spec: LoadedSpec
  /** Path recorded in the contract, relative to the config root. */
  readonly specPath: string
  readonly config: ResolvedConfig
  readonly registries: Registries
  readonly runId: RunId
  readonly attemptId: AttemptId
  readonly harnessVersion: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly configSource?: string
  readonly fileInputs?: InputsRecord
  readonly cliInputs?: Readonly<Record<string, string>>
  /** Completing this deferred requests a clean cancellation. */
  readonly cancellation?: Deferred.Deferred<string>
}

interface AttemptOutcome {
  readonly criteria: ReadonlyArray<CriterionResult>
  readonly artifacts: ReadonlyArray<ArtifactId>
  readonly model: ModelAccounting
  readonly actionsUsed: number
  readonly guidanceExceeded: boolean
  readonly cancellation?: { readonly reason: string }
  readonly executionError?: { readonly stage: RunStage; readonly reason: string }
  readonly budgetExhausted?: boolean
  readonly budgetDetail?: string
}

const browserTools = new Set<ToolName>(["observe", "navigate", "click", "fill", "press", "scroll", "screenshot"])

const pendingResult = (criterion: Criterion, hash: string): CriterionResult => ({
  criterionId: criterion.id,
  criterionHash: hash,
  status: "pending",
  method: criterion.method,
  evaluator: criterion.method === "code"
    ? { kind: "code", checkName: criterion.checkName ?? "unknown" }
    : { kind: "model", provider: "unknown", model: "unknown" },
  expected: criterion.text,
  observed: "",
  evidence: [],
  evaluatedAtSeq: 0
})

/**
 * spec.md §6, steps 1-9, in order. Everything is wired through the service seams in
 * src/services — the runner knows nothing about Playwright, a model SDK or React.
 */
export const runScenario = (request: RunScenarioRequest): Effect.Effect<
  RunResult,
  RunFailure,
  RunStore | BrowserDriver | ModelProvider | Verifier | FixtureManager | Crypto.Crypto
> =>
  Effect.gen(function*() {
    const store = yield* RunStore
    const driver = yield* BrowserDriver
    const provider = yield* ModelProvider
    const verifier = yield* Verifier
    const fixtures = yield* FixtureManager

    const { attemptId, config, registries, spec } = request
    const startedAtMs = yield* Clock.currentTimeMillis
    const startedAt = DateTime.formatIso(yield* DateTime.now)

    const storeFailure = (stage: RunStage) => (cause: { readonly message: string }) =>
      new RunFailure({ stage, reason: cause.message })

    yield* store.emit({
      type: "runStarted",
      attemptId,
      specPath: request.specPath,
      scenarioId: spec.frontmatter.id,
      harnessVersion: request.harnessVersion
    }).pipe(Effect.mapError(storeFailure("manifest")))

    yield* store.emit({
      type: "configResolved",
      config,
      ...(request.configSource === undefined ? {} : { configPath: request.configSource })
    }).pipe(Effect.mapError(storeFailure("validate")))

    yield* store.writeSpecCopy(spec.source).pipe(Effect.mapError(storeFailure("manifest")))
    yield* store.ensureAttemptDirs(attemptId).pipe(Effect.mapError(storeFailure("manifest")))

    const emit = (event: Parameters<typeof store.emit>[0]) => store.emit(event).pipe(Effect.ignore)

    const finish = (outcome: AttemptOutcome, contract: ScenarioContract | undefined) =>
      finalize({ request, store, outcome, contract, startedAt, startedAtMs })

    // --- step 1: inputs and references -------------------------------------------------------
    const declaredInputs = yield* resolveInputPrecedence({
      source: request.configSource ?? spec.specPath,
      configInputs: config.inputs,
      specInputs: spec.frontmatter.inputs ?? {},
      ...(request.fileInputs === undefined ? {} : { fileInputs: request.fileInputs }),
      ...(request.cliInputs === undefined ? {} : { cliInputs: request.cliInputs })
    }).pipe(Effect.result)
    if (declaredInputs._tag === "Failure") {
      return yield* finish(
        emptyOutcome({ stage: "validate", reason: declaredInputs.failure.message }),
        undefined
      )
    }

    const resolvedInputs = yield* resolveInputs({
      declared: declaredInputs.success,
      source: spec.specPath,
      run: { id: request.runId },
      attempt: { id: attemptId },
      anchors: spec.fieldLines
    }).pipe(Effect.result)
    if (resolvedInputs._tag === "Failure") {
      return yield* finish(emptyOutcome({ stage: "validate", reason: resolvedInputs.failure.message }), undefined)
    }
    const inputs = resolvedInputs.success

    // --- step 3a: optional fixture ------------------------------------------------------------
    let fixtureSession: FixtureSession | undefined
    const fixtureName = spec.frontmatter.fixture
    if (fixtureName !== undefined) {
      const known = registries.fixtures.has(fixtureName)
      if (!known) {
        const lookup = yield* registries.fixtures.lookup(fixtureName).pipe(Effect.result)
        const reason = lookup._tag === "Failure" ? lookup.failure.message : "unknown fixture"
        return yield* finish(emptyOutcome({ stage: "fixture-setup", reason }), undefined)
      }
      const setup = yield* fixtures.setup({
        fixtureName,
        runId: request.runId,
        attemptId,
        inputs,
        baseUrl: config.baseUrl
      }).pipe(Effect.result)
      if (setup._tag === "Failure") {
        return yield* finish(emptyOutcome({ stage: "fixture-setup", reason: setup.failure.message }), undefined)
      }
      fixtureSession = setup.success
      yield* emit({
        type: "fixtureReady",
        attemptId,
        fixtureName,
        publicValues: fixtureSession.publicValues
      })
    }

    const cleanupFixture = Effect.suspend(() => {
      if (fixtureSession === undefined) return Effect.void
      const session = fixtureSession
      return session.cleanup({ timeoutMs: config.budgets.fixtureCleanupTimeoutMs }).pipe(
        Effect.flatMap((report) =>
          emit({
            type: "fixtureCleaned",
            attemptId,
            fixtureName: session.fixtureName,
            cleanupsRun: report.cleanupsRun,
            timedOut: report.timedOut
          })
        )
      )
    })

    // --- step 3b: freeze the contract BEFORE any navigation -----------------------------------
    const frozen = yield* freezeContract({
      spec,
      specPath: request.specPath,
      config,
      runId: request.runId,
      attemptId,
      inputs,
      ...(fixtureSession === undefined ? {} : { fixturePublic: fixtureSession.publicValues })
    }).pipe(Effect.result)
    if (frozen._tag === "Failure") {
      yield* cleanupFixture
      return yield* finish(emptyOutcome({ stage: "contract", reason: frozen.failure.message }), undefined)
    }
    const contract = frozen.success

    yield* store.writeContract(contract).pipe(Effect.mapError(storeFailure("contract")))
    yield* emit({
      type: "contractFrozen",
      attemptId,
      contractHash: contract.hashes.contract,
      specHash: contract.hashes.spec,
      criterionIds: contract.criteria.map((c) => c.id)
    })

    const manifest: Manifest = {
      schemaVersion: 1,
      runId: request.runId,
      createdAt: startedAt,
      specPath: request.specPath,
      scenarioId: contract.id,
      harnessVersion: request.harnessVersion,
      nodeVersion: typeof process === "undefined" ? "unknown" : process.version,
      dependencies: { ...request.dependencies },
      model: { provider: provider.id, modelId: provider.modelId, adapterId: provider.id },
      config,
      hashes: contract.hashes
    }
    yield* store.writeManifest(manifest).pipe(Effect.mapError(storeFailure("manifest")))

    // --- steps 4-8 ----------------------------------------------------------------------------
    const outcome = yield* runAttempt({
      request,
      contract,
      store,
      driver,
      provider,
      verifier,
      registries,
      ...(fixtureSession === undefined ? {} : { fixtureSession }),
      startedAtMs
    }).pipe(Effect.onExit(() => cleanupFixture))

    return yield* finish(outcome, contract)
  })

const emptyOutcome = (executionError: { stage: RunStage; reason: string }): AttemptOutcome => ({
  criteria: [],
  artifacts: [],
  model: { calls: 0, inputTokens: 0, outputTokens: 0, verifierTokens: 0 },
  actionsUsed: 0,
  guidanceExceeded: false,
  executionError
})

interface AttemptDeps {
  readonly request: RunScenarioRequest
  readonly contract: ScenarioContract
  readonly store: RunStore["Service"]
  readonly driver: BrowserDriver["Service"]
  readonly provider: ModelProvider["Service"]
  readonly verifier: Verifier["Service"]
  readonly registries: Registries
  readonly fixtureSession?: FixtureSession
  readonly startedAtMs: number
}

const runAttempt = (deps: AttemptDeps): Effect.Effect<AttemptOutcome, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const { contract, driver, provider, registries, request, store, verifier } = deps
    const { attemptId, config } = request
    const layout = store.layout
    const emit = (event: Parameters<typeof store.emit>[0]) => store.emit(event).pipe(Effect.ignore)

    let guidance = makeActionGuidance(contract.maxActions)
    let budget: BudgetState = makeBudgetState(deps.startedAtMs)
    let budgetDetail: string | undefined
    let executionError: { stage: RunStage; reason: string } | undefined
    let cancellation: { reason: string } | undefined
    let verifierTokens = 0
    let stallNotified = false
    const actionHistory: Array<string> = []

    const results = new Map<string, CriterionResult>()
    for (const criterion of contract.criteria) {
      results.set(criterion.id, pendingResult(criterion, contract.hashes.criteria[criterion.id] ?? ""))
    }
    const evidenceIndex = new Map<string, EvidenceItem>()

    const outcome = (): AttemptOutcome => ({
      criteria: contract.criteria.map((c) => results.get(c.id)!),
      artifacts: [...evidenceIndex.keys()] as ReadonlyArray<ArtifactId>,
      model: {
        calls: budget.modelCalls,
        inputTokens: budget.inputTokens,
        outputTokens: budget.outputTokens,
        verifierTokens
      },
      actionsUsed: guidance.used,
      guidanceExceeded: guidance.used > guidance.guidance,
      ...(cancellation === undefined ? {} : { cancellation }),
      ...(executionError === undefined ? {} : { executionError }),
      ...(budgetDetail === undefined ? {} : { budgetExhausted: true, budgetDetail })
    })

    /** Poll the cancellation signal without blocking the loop. */
    const cancelReason = Effect.suspend(() => {
      if (request.cancellation === undefined) return Effect.succeed(Option.none<string>())
      return Deferred.poll(request.cancellation).pipe(
        Effect.flatMap((maybe) =>
          Option.isNone(maybe)
            ? Effect.succeed(Option.none<string>())
            : maybe.value.pipe(Effect.map(Option.some), Effect.catchCause(() => Effect.succeed(Option.some("cancelled"))))
        )
      )
    })

    const registerArtifact = (capture: CaptureOutcome, options?: {
      readonly summary?: string
      readonly data?: unknown
      readonly sourceSeq?: number
    }) =>
      Effect.gen(function*() {
        const id = yield* store.mintArtifactId(attemptId)
        const now = DateTime.formatIso(yield* DateTime.now)
        const record: ArtifactRecord = {
          artifactId: id,
          attemptId,
          kind: capture.kind,
          ...(capture.label === undefined ? {} : { label: capture.label }),
          ...(capture.path === undefined ? {} : { path: layout.relative(capture.path) }),
          state: capture.state,
          ...(capture.reason === undefined ? {} : { reason: capture.reason }),
          ...(capture.bytes === undefined ? {} : { bytes: capture.bytes }),
          ts: now,
          ...(options?.sourceSeq === undefined ? {} : { sourceSeq: options.sourceSeq })
        }
        yield* store.recordArtifact(record).pipe(Effect.ignore)
        if (capture.state === "present") {
          evidenceIndex.set(id, {
            artifactId: id,
            kind: capture.kind,
            ...(capture.label === undefined ? {} : { label: capture.label }),
            capturedAt: now,
            ...(options?.sourceSeq === undefined ? {} : { sourceSeq: options.sourceSeq }),
            summary: options?.summary ?? `${capture.kind} ${capture.label ?? ""}`.trim(),
            ...(options?.data === undefined ? {} : { data: options.data })
          })
        }
        return id
      })

    const takeScreenshot = (session: BrowserSession, label: string, fullPage?: boolean) =>
      Effect.gen(function*() {
        const id = yield* store.mintArtifactId(attemptId)
        const capture = yield* session.screenshot({
          fileName: `${id}.png`,
          label,
          ...(fullPage === undefined ? {} : { fullPage })
        })
        const now = DateTime.formatIso(yield* DateTime.now)
        const record: ArtifactRecord = {
          artifactId: id,
          attemptId,
          kind: "screenshot",
          label,
          ...(capture.path === undefined ? {} : { path: layout.relative(capture.path) }),
          state: capture.state,
          ...(capture.reason === undefined ? {} : { reason: capture.reason }),
          ...(capture.bytes === undefined ? {} : { bytes: capture.bytes }),
          ts: now
        }
        yield* store.recordArtifact(record).pipe(Effect.ignore)
        if (capture.state === "present") {
          evidenceIndex.set(id, {
            artifactId: id,
            kind: "screenshot",
            label,
            capturedAt: now,
            summary: `screenshot "${label}"`
          })
        }
        return { artifactId: id, state: capture.state, reason: capture.reason }
      })

    const recordObservation = (observation: ObserveResult, seq: number) =>
      Effect.gen(function*() {
        const id = yield* store.mintArtifactId(attemptId)
        const relative = `attempts/${attemptId}/observations/${id}.txt`
        const body = `url: ${observation.url}\ntitle: ${observation.title}\n\n${observation.snapshot}`
        const written = yield* store.writeRunFile(relative, body).pipe(Effect.result)
        const now = DateTime.formatIso(yield* DateTime.now)
        const failed = written._tag === "Failure"
        const record: ArtifactRecord = {
          artifactId: id,
          attemptId,
          kind: "aria-snapshot",
          label: observation.observationId,
          ...(failed ? {} : { path: relative }),
          state: failed ? "failed" : "present",
          ...(failed ? { reason: written.failure.message } : {}),
          ts: now,
          sourceSeq: seq
        }
        yield* store.recordArtifact(record).pipe(Effect.ignore)
        if (!failed) {
          evidenceIndex.set(id, {
            artifactId: id,
            kind: "aria-snapshot",
            label: observation.observationId,
            capturedAt: now,
            sourceSeq: seq,
            summary: `page observation ${observation.observationId} at ${observation.url} (${observation.title})\n${observation.snapshot}`,
            data: { url: observation.url, title: observation.title, elements: observation.elements }
          })
        }
        return id
      })

    const evidenceItems = (): ReadonlyArray<EvidenceItem> => [...evidenceIndex.values()]

    const verifyCriterion = (
      session: BrowserSession,
      criterionId: string,
      requestedBy: "agent" | "runner"
    ): Effect.Effect<void, never, Crypto.Crypto> =>
      Effect.gen(function*() {
        const criterion = contract.criteria.find((c) => c.id === criterionId)
        if (criterion === undefined) return
        const current = results.get(criterionId)
        if (current !== undefined && current.status !== "pending" && requestedBy === "runner") return

        const requested = yield* store.emit({
          type: "evidenceRequested",
          attemptId,
          criterionId,
          requestedBy
        }).pipe(Effect.result)
        const seq = requested._tag === "Success" ? requested.success.seq : 0

        if (config.capture.screenshots !== "off") {
          yield* takeScreenshot(session, `checkpoint-${criterionId}`)
        }

        const hash = contract.hashes.criteria[criterionId] ?? ""
        const attemptArtifacts = yield* store.attemptArtifacts(attemptId)

        let produced: CriterionResult
        if (criterion.method === "code") {
          produced = yield* runCodeCheck({ criterion, hash, seq, attemptArtifacts })
        } else {
          const decision = canStartModelCall({
            budgets: contract.budgets,
            state: budget,
            role: "verifier",
            nowMs: yield* Clock.currentTimeMillis
          })
          if (decision._tag === "deny") {
            budgetDetail = decision.error.message
            yield* emit({
              type: "budgetExhausted",
              attemptId,
              budget: decision.error.budget,
              limit: decision.error.limit,
              used: decision.error.used,
              detail: decision.error.detail ?? decision.error.message
            })
            produced = {
              ...pendingResult(criterion, hash),
              evaluator: { kind: "model", provider: provider.id, model: provider.modelId },
              status: "inconclusive",
              observed: "the token budget was exhausted before this criterion could be evaluated",
              limitations: decision.error.message,
              evaluatedAtSeq: seq
            }
          } else {
            const response = yield* verifier.verify({
              attemptId,
              criterion,
              criterionHash: hash,
              evidence: evidenceItems(),
              scenario: {
                id: contract.id,
                body: contract.body,
                inputs: contract.inputs,
                fixturePublic: deps.fixtureSession?.publicValues ?? {}
              },
              baseUrl: config.baseUrl,
              seq
            }).pipe(Effect.result)

            if (response._tag === "Failure") {
              produced = {
                ...pendingResult(criterion, hash),
                status: "error",
                observed: response.failure.message,
                evaluatedAtSeq: seq
              }
            } else {
              budget = recordModelCall(budget)
              budget = chargeTokens(budget, "verifier", response.success.usage ?? {})
              verifierTokens = budget.verifierTokens
              const outcomeValue = response.success.outcome
              if (outcomeValue._tag === "needsEvidence") {
                // The expectation is NOT rewritten: the loop may keep navigating within budget.
                yield* emit({
                  type: "evidenceRequested",
                  attemptId,
                  criterionId,
                  requestedBy: "verifier",
                  note: outcomeValue.hint
                })
                // ... but the final pass IS the last chance. Leaving the criterion `pending` would
                // record "never looked at" for something that was looked at and could not be
                // settled: it resolves to `inconclusive`, naming what was missing.
                if (requestedBy !== "runner") return
                produced = {
                  ...pendingResult(criterion, hash),
                  evaluator: { kind: "model", provider: provider.id, model: provider.modelId },
                  status: "inconclusive",
                  observed: `the available evidence does not settle this criterion: ${
                    outcomeValue.missing.join("; ")
                  }`,
                  limitations: outcomeValue.hint,
                  evaluatedAtSeq: seq
                }
              } else {
                produced = outcomeValue.result
              }
            }
          }
        }

        // Re-read the inventory: a code check mints its own probe evidence WHILE it runs, so the
        // snapshot taken before the evaluation would reject the very artifact it just produced.
        // The integrity rule is unchanged — the id must exist and belong to this attempt.
        const knownArtifacts = yield* store.attemptArtifacts(attemptId)
        const guarded = enforceEvidenceIntegrity({ result: produced, attemptArtifacts: knownArtifacts })
        results.set(criterionId, guarded)
        yield* emit({ type: "verificationFinished", attemptId, criterionId, result: guarded })
      })

    const runCodeCheck = (options: {
      readonly criterion: Criterion
      readonly hash: string
      readonly seq: number
      readonly attemptArtifacts: ReadonlySet<string>
    }): Effect.Effect<CriterionResult, never, Crypto.Crypto> =>
      Effect.gen(function*() {
        const { criterion, hash, seq } = options
        const checkName = criterion.checkName ?? ""
        const base = pendingResult(criterion, hash)
        const lookup = yield* registries.checks.lookup(checkName).pipe(Effect.result)
        if (lookup._tag === "Failure") {
          return { ...base, status: "error", observed: lookup.failure.message, evaluatedAtSeq: seq }
        }
        const binding = yield* verifyCriterionBinding({
          checkName,
          criterionId: criterion.id,
          text: criterion.text,
          contractHash: hash
        }).pipe(Effect.result)
        if (binding._tag === "Failure") {
          executionError = { stage: "verification", reason: binding.failure.message }
          return { ...base, status: "error", observed: binding.failure.message, evaluatedAtSeq: seq }
        }

        // A check's probe output is journalled AND persisted: an artifact the report can cite must
        // have something behind it, so the payload is written next to the attempt's other evidence.
        const recordEvidence = (e: { readonly label: string; readonly data: unknown }): Promise<string> =>
          Effect.runPromise(Effect.gen(function*() {
            const id = yield* store.mintArtifactId(attemptId)
            const relative = `attempts/${attemptId}/evidence/${id}.json`
            const body = `${JSON.stringify({ label: e.label, data: e.data }, null, 2)}\n`
            const written = yield* store.writeRunFile(relative, body).pipe(Effect.result)
            const now = DateTime.formatIso(yield* DateTime.now)
            const failed = written._tag === "Failure"
            yield* store.recordArtifact({
              artifactId: id,
              attemptId,
              kind: "check-evidence",
              label: e.label,
              ...(failed ? {} : { path: relative }),
              state: failed ? "failed" : "present",
              ...(failed ? { reason: written.failure.message } : {}),
              ts: now,
              sourceSeq: seq
            }).pipe(Effect.ignore)
            if (!failed) {
              evidenceIndex.set(id, {
                artifactId: id,
                kind: "check-evidence",
                label: e.label,
                capturedAt: now,
                sourceSeq: seq,
                summary: `check evidence "${e.label}"`,
                data: e.data
              })
            }
            return id
          }))

        const executed = yield* Effect.tryPromise({
          try: () =>
            lookup.success({
              runId: request.runId,
              attemptId,
              criterion: { id: criterion.id, text: criterion.text, hash },
              inputs: contract.inputs,
              fixture: { public: deps.fixtureSession?.publicValues ?? {} },
              baseUrl: config.baseUrl,
              recordEvidence
            }),
          catch: (cause) => (cause instanceof Error ? cause.message : String(cause))
        }).pipe(
          Effect.timeoutOrElse({
            duration: contract.budgets.operationTimeoutMs,
            orElse: () => Effect.fail(`check "${checkName}" exceeded the per-operation timeout`)
          }),
          Effect.result
        )

        if (executed._tag === "Failure") {
          return { ...base, status: "error", observed: String(executed.failure), evaluatedAtSeq: seq }
        }
        const value = executed.success
        return {
          ...base,
          status: value.status,
          evaluator: { kind: "code", checkName },
          expected: value.expected,
          observed: value.observed,
          evidence: value.evidence as ReadonlyArray<string>,
          evaluatedAtSeq: seq
        }
      })

    // --- tool dispatch -------------------------------------------------------------------------

    let currentObservation: ObserveResult | undefined
    let finishRequested = false
    /** One short nudge, injected into the next turn after the indicative threshold is crossed. */
    let pendingNudge: string | undefined

    const toolError = (code: ToolErrorCode, message: string, remedy: ToolErrorResult["remedy"]): ToolErrorResult => ({
      error: true,
      code,
      message,
      remedy
    })

    const dispatch = (
      session: BrowserSession,
      call: { readonly id: string; readonly name: string; readonly params: unknown }
    ): Effect.Effect<{ readonly result: unknown; readonly isError: boolean }, never, Crypto.Crypto> =>
      Effect.gen(function*() {
        const name = call.name as ToolName
        if (!(name in toolParamSchemas)) {
          return {
            result: toolError("invalid-params", `unknown tool "${call.name}"`, "choose-another-action"),
            isError: true
          }
        }
        const actionId = yield* store.mintActionId(attemptId)

        // The counter increments here, BEFORE policy validation: an observation, a screenshot,
        // a stale reference and a blocked navigation all count. `check` and `finish` are not
        // browser tools and never count. Nothing is ever refused because of this counter.
        if (browserTools.has(name)) {
          const step = recordAction(guidance)
          guidance = step.state
          if (step.notice !== undefined) {
            yield* emit({
              type: "actionGuidanceExceeded",
              attemptId,
              used: step.notice.used,
              guidance: step.notice.guidance,
              rendering: step.notice.rendering
            })
            pendingNudge = step.notice.nudge
          }
        }

        const decoded = yield* Schema.decodeUnknownEffect(toolParamSchemas[name], strictQuietParseOptions)(
          call.params ?? {}
        ).pipe(Effect.result)

        const intent = decoded._tag === "Success" && "intent" in decoded.success
          ? (decoded.success as { intent?: string }).intent
          : undefined

        yield* emit({
          type: "actionStarted",
          attemptId,
          actionId,
          tool: name,
          params: (typeof call.params === "object" && call.params !== null
            ? call.params
            : {}) as Record<string, unknown>,
          ...(intent === undefined ? {} : { intent })
        })

        const finishAction = (result: unknown, isError: boolean, code?: ToolErrorCode, message?: string) =>
          emit({
            type: "actionFinished",
            attemptId,
            actionId,
            tool: name,
            outcome: isError ? "error" : "ok",
            ...(code === undefined ? {} : { code }),
            ...(message === undefined ? {} : { message })
          }).pipe(Effect.as({ result, isError }))

        if (decoded._tag === "Failure") {
          const error = toolError("invalid-params", decoded.failure.message, "choose-another-action")
          return yield* finishAction(error, true, error.code, error.message)
        }
        const params = decoded.success as Record<string, unknown>

        const staleCheck = (observationId: unknown): ToolErrorResult | undefined => {
          if (observationId === undefined) return undefined
          if (currentObservation === undefined) {
            return toolError("stale-observation", "no observation has been taken yet", "re-observe")
          }
          if (observationId !== currentObservation.observationId) {
            return toolError(
              "stale-observation",
              `observation ${String(observationId)} is no longer live (current: ${currentObservation.observationId})`,
              "re-observe"
            )
          }
          return undefined
        }

        const refCheck = (ref: unknown): ToolErrorResult | undefined => {
          if (ref === undefined || currentObservation === undefined) return undefined
          const matches = currentObservation.elements.filter((e) => e.ref === ref)
          if (matches.length === 0) {
            return toolError("unknown-reference", `reference ${String(ref)} is not in the current observation`, "re-observe")
          }
          if (matches.length > 1) {
            return toolError("ambiguous-reference", `reference ${String(ref)} is ambiguous`, "re-observe")
          }
          return undefined
        }

        const operation = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: contract.budgets.operationTimeoutMs,
              orElse: () => Effect.fail({ message: `${name} exceeded the per-operation timeout` })
            }),
            Effect.result
          )

        switch (name) {
          case "observe": {
            const observationId = yield* store.mintObservationId(attemptId)
            const observed = yield* operation(session.observe(observationId))
            if (observed._tag === "Failure") {
              const error = toolError("operation-failed", observed.failure.message, "choose-another-action")
              return yield* finishAction(error, true, error.code, error.message)
            }
            currentObservation = observed.success
            const event = yield* store.emit({
              type: "observationTaken",
              attemptId,
              observationId: observed.success.observationId,
              url: observed.success.url,
              title: observed.success.title,
              elementCount: observed.success.elements.length
            }).pipe(Effect.result)
            yield* recordObservation(observed.success, event._tag === "Success" ? event.success.seq : 0)
            return yield* finishAction(observed.success, false)
          }
          case "navigate": {
            const allowed = yield* checkNavigationOrigin(String(params["url"]), config.allowedOrigins).pipe(
              Effect.result
            )
            if (allowed._tag === "Failure") {
              const error = toolError("origin-not-allowed", allowed.failure.message, "choose-another-action")
              return yield* finishAction(error, true, error.code, error.message)
            }
            const navigated = yield* operation(session.navigate({ url: allowed.success }))
            if (navigated._tag === "Failure") {
              const error = toolError("operation-failed", navigated.failure.message, "choose-another-action")
              return yield* finishAction(error, true, error.code, error.message)
            }
            currentObservation = undefined
            return yield* finishAction(navigated.success, false)
          }
          case "click":
          case "fill": {
            const stale = staleCheck(params["observationId"]) ?? refCheck(params["ref"])
            if (stale !== undefined) return yield* finishAction(stale, true, stale.code, stale.message)
            const acted = yield* operation(
              name === "click"
                ? session.click({ observationId: String(params["observationId"]), ref: String(params["ref"]) })
                : session.fill({
                  observationId: String(params["observationId"]),
                  ref: String(params["ref"]),
                  value: String(params["value"])
                })
            )
            if (acted._tag === "Failure") {
              const error = toolError("operation-failed", acted.failure.message, "re-observe")
              return yield* finishAction(error, true, error.code, error.message)
            }
            if (acted.success.navigated) currentObservation = undefined
            return yield* finishAction(acted.success, false)
          }
          case "press": {
            const stale = params["observationId"] === undefined
              ? undefined
              : staleCheck(params["observationId"]) ?? refCheck(params["ref"])
            if (stale !== undefined) return yield* finishAction(stale, true, stale.code, stale.message)
            const acted = yield* operation(
              session.press({
                ...(params["observationId"] === undefined ? {} : { observationId: String(params["observationId"]) }),
                ...(params["ref"] === undefined ? {} : { ref: String(params["ref"]) }),
                key: String(params["key"])
              })
            )
            if (acted._tag === "Failure") {
              const error = toolError("operation-failed", acted.failure.message, "re-observe")
              return yield* finishAction(error, true, error.code, error.message)
            }
            if (acted.success.navigated) currentObservation = undefined
            return yield* finishAction(acted.success, false)
          }
          case "scroll": {
            const acted = yield* operation(
              session.scroll({
                direction: params["direction"] as "up" | "down",
                ...(params["amount"] === undefined ? {} : { amount: Number(params["amount"]) })
              })
            )
            if (acted._tag === "Failure") {
              const error = toolError("operation-failed", acted.failure.message, "choose-another-action")
              return yield* finishAction(error, true, error.code, error.message)
            }
            return yield* finishAction(acted.success, false)
          }
          case "screenshot": {
            const label = params["label"] === undefined ? "agent" : String(params["label"])
            const shot = yield* takeScreenshot(
              session,
              label,
              params["fullPage"] === undefined ? undefined : Boolean(params["fullPage"])
            )
            if (shot.state !== "present") {
              const error = toolError("operation-failed", shot.reason ?? "screenshot capture failed", "choose-another-action")
              return yield* finishAction(error, true, error.code, error.message)
            }
            return yield* finishAction({ artifactId: shot.artifactId, label }, false)
          }
          case "check": {
            const criterionId = String(params["criterionId"])
            if (!results.has(criterionId)) {
              const error = toolError(
                "unknown-criterion",
                `${criterionId} is not a criterion of this contract (${[...results.keys()].join(", ")})`,
                "choose-another-action"
              )
              return yield* finishAction(error, true, error.code, error.message)
            }
            yield* verifyCriterion(session, criterionId, "agent")
            return yield* finishAction({ criterionId, accepted: true }, false)
          }
          case "finish": {
            finishRequested = true
            return yield* finishAction(
              {
                accepted: true,
                note: "final verification will run; `finish` never decides the verdict"
              },
              false
            )
          }
        }
      })

    // --- the agent loop ------------------------------------------------------------------------

    const messages: Array<PromptMessage> = [
      {
        role: "system",
        parts: [{
          type: "text",
          text: systemPrompt(contract, { baseUrl: config.baseUrl, allowedOrigins: config.allowedOrigins })
        }]
      },
      {
        role: "user",
        parts: [{
          type: "text",
          text: "Commence par `observe` pour voir la page, puis agis. Termine par `finish` quand le parcours est fait."
        }]
      }
    ]
    const tools = toolDefinitions()

    const agentLoop = (session: BrowserSession): Effect.Effect<void, never, Crypto.Crypto> =>
      Effect.gen(function*() {
        let idleTurns = 0
        while (true) {
          const cancelled = yield* cancelReason
          if (Option.isSome(cancelled)) {
            cancellation = { reason: cancelled.value }
            yield* emit({ type: "cancellationRequested", attemptId, reason: cancelled.value, source: "api" })
            return
          }
          if (finishRequested) return

          const nowMs = yield* Clock.currentTimeMillis
          const decision = canStartModelCall({
            budgets: contract.budgets,
            state: budget,
            role: "browser",
            nowMs
          })
          if (decision._tag === "deny") {
            budgetDetail = decision.error.message
            yield* emit({
              type: "budgetExhausted",
              attemptId,
              budget: decision.error.budget,
              limit: decision.error.limit,
              used: decision.error.used,
              detail: decision.error.detail ?? decision.error.message
            })
            return
          }

          if (pendingNudge !== undefined) {
            messages.push({ role: "user", parts: [{ type: "text", text: pendingNudge }] })
            pendingNudge = undefined
          }

          const callId = `mc_${budget.modelCalls + 1}`
          yield* emit({
            type: "modelCallStarted",
            attemptId,
            role: "browser" as ModelRole,
            callId,
            provider: provider.id,
            model: provider.modelId
          })
          const response = yield* provider.generate({ role: "browser", prompt: { messages }, tools }).pipe(
            Effect.result
          )
          budget = recordModelCall(budget)
          if (response._tag === "Failure") {
            executionError = { stage: "agent-loop", reason: response.failure.message }
            yield* emit({
              type: "error",
              attemptId,
              stage: "agent-loop",
              reason: response.failure.message,
              fatal: true
            })
            return
          }
          budget = chargeTokens(budget, "browser", response.success.usage ?? {})
          yield* emit({
            type: "modelCallFinished",
            attemptId,
            role: "browser" as ModelRole,
            callId,
            ...(response.success.usage?.inputTokens === undefined
              ? {}
              : { inputTokens: response.success.usage.inputTokens }),
            ...(response.success.usage?.outputTokens === undefined
              ? {}
              : { outputTokens: response.success.usage.outputTokens }),
            toolCalls: response.success.toolCalls.length,
            ...(response.success.finishReason === undefined ? {} : { finishReason: response.success.finishReason })
          })

          const assistantParts: Array<PromptPart> = []
          if (response.success.text !== undefined && response.success.text !== "") {
            assistantParts.push({ type: "text", text: response.success.text })
          }
          for (const call of response.success.toolCalls) {
            assistantParts.push({ type: "toolCall", id: call.id, name: call.name, params: call.params })
          }
          if (assistantParts.length > 0) messages.push({ role: "assistant", parts: assistantParts })

          if (response.success.toolCalls.length === 0) {
            idleTurns += 1
            if (idleTurns >= 3) {
              yield* emit({
                type: "progressStalled",
                attemptId,
                reason: "the model produced three consecutive turns without a tool call",
                repeatedActions: idleTurns
              })
              return
            }
            messages.push({
              role: "user",
              parts: [{ type: "text", text: "Utilise un outil pour progresser, ou appelle `finish`." }]
            })
            continue
          }
          idleTurns = 0

          const resultParts: Array<PromptPart> = []
          for (const call of response.success.toolCalls) {
            const signature = `${call.name}:${JSON.stringify(call.params ?? {})}`
            actionHistory.push(signature)
            if (
              !stallNotified && actionHistory.length >= 3 &&
              actionHistory.slice(-3).every((s) => s === signature)
            ) {
              stallNotified = true
              yield* emit({
                type: "progressStalled",
                attemptId,
                reason: `the same action was repeated three times: ${call.name}`,
                repeatedActions: 3
              })
            }
            const dispatched = yield* dispatch(session, call)
            resultParts.push({
              type: "toolResult",
              id: call.id,
              name: call.name,
              result: dispatched.result,
              isError: dispatched.isError
            })
            if (config.capture.screenshots === "every-action" && browserTools.has(call.name as ToolName)) {
              yield* takeScreenshot(session, `after-${call.name}`)
            }
            if (finishRequested) break
          }
          messages.push({ role: "user", parts: resultParts })
        }
      })

    // --- the attempt body, scoped so cancellation closes the browser -----------------------------

    const attemptBody = Effect.gen(function*() {
      const session = yield* driver.openContext({
        attemptId,
        baseUrl: config.baseUrl,
        ...(deps.fixtureSession?.storageState === undefined
          ? {}
          : { storageState: deps.fixtureSession.storageState }),
        capture: config.capture,
        attemptDir: layout.attemptDir(attemptId),
        screenshotsDir: layout.screenshotsDir(attemptId),
        operationTimeoutMs: contract.budgets.operationTimeoutMs
      })
      yield* emit({
        type: "browserContextOpened",
        attemptId,
        baseUrl: config.baseUrl,
        usedStorageState: deps.fixtureSession?.storageState !== undefined,
        capture: config.capture
      })

      // Step 4: captures are live before any scenario action; step 5-6: the agent loop.
      const initial = yield* session.navigate({ url: config.baseUrl }).pipe(Effect.result)
      if (initial._tag === "Failure") {
        executionError = { stage: "browser", reason: initial.failure.message }
      } else {
        yield* agentLoop(session)
      }

      // Steps 7-8: every criterion still unresolved is evaluated before aggregation.
      if (cancellation === undefined && executionError === undefined) {
        for (const criterion of contract.criteria) {
          const current = results.get(criterion.id)
          if (current !== undefined && current.status === "pending") {
            yield* verifyCriterion(session, criterion.id, "runner")
          }
        }
      }

      // Step 9: settle the evidence. A failed capture is recorded, never hidden.
      const retainTrace = config.capture.retainTraceOn === "all" ||
        contract.criteria.some((c) => results.get(c.id)?.status !== "passed")
      const captures = yield* session.finalize({ retainTrace })
      for (const capture of captures) {
        yield* registerArtifact(capture)
      }
    })

    const exit = yield* Effect.scoped(attemptBody).pipe(
      Effect.timeoutOrElse({
        duration: contract.budgets.attemptTimeoutMs,
        orElse: () =>
          Effect.sync(() => {
            budgetDetail = `blocking budget attemptTimeout exhausted (${contract.budgets.attemptTimeoutMs} ms)`
          })
      }),
      Effect.exit
    )
    if (Exit.isFailure(exit) && executionError === undefined && cancellation === undefined) {
      executionError = { stage: "browser", reason: Cause.pretty(exit.cause) }
    }

    return outcome()
  })

const finalize = (options: {
  readonly request: RunScenarioRequest
  readonly store: RunStore["Service"]
  readonly outcome: AttemptOutcome
  readonly contract: ScenarioContract | undefined
  readonly startedAt: string
  readonly startedAtMs: number
}): Effect.Effect<RunResult, RunFailure> =>
  Effect.gen(function*() {
    const { contract, outcome, request, store } = options
    const finishedAtMs = yield* Clock.currentTimeMillis
    const finishedAt = DateTime.formatIso(yield* DateTime.now)
    const durationMs = finishedAtMs - options.startedAtMs

    const verdict = aggregate({
      ...(outcome.cancellation === undefined ? {} : { cancellation: outcome.cancellation }),
      ...(outcome.executionError === undefined ? {} : { executionError: outcome.executionError }),
      criteria: outcome.criteria,
      ...(outcome.budgetExhausted === undefined ? {} : { budgetExhausted: outcome.budgetExhausted }),
      ...(outcome.budgetDetail === undefined ? {} : { budgetDetail: outcome.budgetDetail })
    })

    const attemptCommon = {
      attemptId: request.attemptId,
      startedAt: options.startedAt,
      finishedAt,
      durationMs,
      criteria: outcome.criteria,
      actions: {
        used: outcome.actionsUsed,
        guidance: contract?.maxActions ?? request.config.maxActions,
        guidanceExceeded: outcome.guidanceExceeded
      },
      model: outcome.model,
      artifacts: outcome.artifacts
    }

    const attempt: AttemptResult = verdict.status === "cancelled"
      ? { ...attemptCommon, status: "cancelled", reason: verdict.reason }
      : verdict.status === "error"
      ? { ...attemptCommon, status: "error", stage: verdict.stage, reason: verdict.reason }
      : verdict.status === "failed"
      ? { ...attemptCommon, status: "failed", failedCriteria: verdict.failedCriteria }
      : verdict.status === "inconclusive"
      ? {
        ...attemptCommon,
        status: "inconclusive",
        reason: verdict.reason,
        ...(verdict.detail === undefined ? {} : { detail: verdict.detail })
      }
      : { ...attemptCommon, status: "passed" }

    const runCommon = {
      schemaVersion: 1 as const,
      runId: request.runId,
      specPath: request.specPath,
      scenarioId: contract?.id ?? request.spec.frontmatter.id,
      contractHash: contract?.hashes.contract ?? "",
      startedAt: options.startedAt,
      finishedAt,
      durationMs,
      attempts: [attempt],
      finalized: true
    }

    const result: RunResult = verdict.status === "cancelled"
      ? { ...runCommon, status: "cancelled", reason: verdict.reason }
      : verdict.status === "error"
      ? { ...runCommon, status: "error", stage: verdict.stage, reason: verdict.reason }
      : verdict.status === "failed"
      ? { ...runCommon, status: "failed", failedCriteria: verdict.failedCriteria }
      : verdict.status === "inconclusive"
      ? {
        ...runCommon,
        status: "inconclusive",
        reason: verdict.reason,
        ...(verdict.detail === undefined ? {} : { detail: verdict.detail })
      }
      : { ...runCommon, status: "passed" }

    yield* store.writeResult(result).pipe(
      Effect.mapError((cause) => new RunFailure({ stage: "aggregate", reason: cause.message }))
    )
    yield* store.emit({
      type: "runFinished",
      attemptId: request.attemptId,
      durationMs,
      status: result.status,
      criteriaCount: outcome.criteria.length,
      failedCriteria: outcome.criteria.filter((c) => c.status === "failed").map((c) => c.criterionId)
    }).pipe(Effect.ignore)

    return result
  })
