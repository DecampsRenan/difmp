import {
  Cause,
  Clock,
  Crypto,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberSet,
  Option,
} from "effect";
import type { Result } from "effect/Result";
import type { Scope } from "effect/Scope";
import type { RunStage } from "../domain/errors.js";
import { BudgetExhaustedError, RunFailure } from "../domain/errors.js";
import type { ModelRole } from "../domain/events.js";
import type { ArtifactId, AttemptId, RunId } from "../domain/ids.js";
import type {
  AttemptResult,
  CriterionResult,
  Evaluator,
  Manifest,
  ModelAccounting,
  RunResult,
} from "../domain/result.js";
import type { ResolvedConfig } from "../domain/config.js";
import type { Criterion, InputsRecord, LoadedSpec, ScenarioContract } from "../domain/spec.js";
import { resolveInputPrecedence } from "../config/index.js";
import { resolveInputs } from "../interpolate/index.js";
import { aggregate } from "../policy/aggregate.js";
import type { BudgetState } from "../policy/budgets.js";
import {
  canStartModelCall,
  chargeTokens,
  makeBudgetState,
  recordModelCall,
} from "../policy/budgets.js";
import { adjudicate } from "../policy/adjudicate.js";
import type { Redactor } from "../policy/redact.js";
import { collectSensitiveValues, makeRedactor, sanitizeConfig } from "../policy/redact.js";
import type { Registries } from "../registry/index.js";
import { validateSpecRegistries, verifyCriterionBinding } from "../registry/index.js";
import { BrowserDriver } from "../services/browser.js";
import type { BrowserSession, CaptureOutcome } from "../services/browser.js";
import { FixtureManager } from "../services/fixture.js";
import type { FixtureCleanupReport, FixtureSession } from "../services/fixture.js";
import { ModelProvider, ProviderError } from "../services/model.js";
import type { PromptMessage, PromptPart } from "../services/model.js";
import { Verifier, VerifierError } from "../services/verifier.js";
import { RunStore } from "../store/runStore.js";
import { makeDispatcher } from "./dispatcher.js";
import { freezeContract } from "./contract.js";
import { makeEvidenceRecorder } from "./evidence.js";
import { systemPrompt, toolDefinitions } from "./prompt.js";

export interface RunScenarioRequest {
  readonly spec: LoadedSpec;
  /** Path recorded in the contract, relative to the config root. */
  readonly specPath: string;
  readonly config: ResolvedConfig;
  readonly registries: Registries;
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly harnessVersion: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly configSource?: string;
  readonly fileInputs?: InputsRecord;
  readonly cliInputs?: Readonly<Record<string, string>>;
  /** Completing this deferred requests a clean cancellation. */
  readonly cancellation?: Deferred.Deferred<string>;
}

interface AttemptOutcome {
  readonly criteria: ReadonlyArray<CriterionResult>;
  readonly artifacts: ReadonlyArray<ArtifactId>;
  readonly model: ModelAccounting;
  readonly actionsUsed: number;
  readonly guidanceExceeded: boolean;
  readonly cancellation?: { readonly reason: string };
  readonly executionError?: { readonly stage: RunStage; readonly reason: string };
  readonly budgetExhausted?: boolean;
  readonly budgetDetail?: string;
}

const pendingResult = (criterion: Criterion, hash: string): CriterionResult => ({
  criterionId: criterion.id,
  criterionHash: hash,
  status: "pending",
  method: criterion.method,
  evaluator:
    criterion.method === "code"
      ? { kind: "code", checkName: criterion.checkName ?? "unknown" }
      : { kind: "model", provider: "unknown", model: "unknown" },
  expected: criterion.text,
  observed: "",
  evidence: [],
  evaluatedAtSeq: 0,
});

/**
 * spec.md §6, steps 1-9, in order. Everything is wired through the service seams in
 * src/services — the runner knows nothing about Playwright, a model SDK or React.
 */
/** Turns a store-write failure into the run-level failure for whichever stage was writing. */
const storeFailure = (stage: RunStage) => (cause: { readonly message: string }) =>
  new RunFailure({ stage, reason: cause.message });

/** Runs `f` in a fresh scope, handing it that scope's abort signal. */
const withAbortSignal = <A, E, R>(f: (signal: AbortSignal) => Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.flatMap(Effect.abortSignal, f));

export const runScenario = (
  request: RunScenarioRequest,
): Effect.Effect<
  RunResult,
  RunFailure,
  RunStore | BrowserDriver | ModelProvider | Verifier | FixtureManager | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const driver = yield* BrowserDriver;
    const provider = yield* ModelProvider;
    const verifier = yield* Verifier;
    const fixtures = yield* FixtureManager;

    const { attemptId, config, registries, spec } = request;
    const startedAtMs = yield* Clock.currentTimeMillis;
    const startedAt = DateTime.formatIso(yield* DateTime.now);

    yield* store
      .emit({
        type: "runStarted",
        attemptId,
        specPath: request.specPath,
        scenarioId: spec.frontmatter.id,
        harnessVersion: request.harnessVersion,
      })
      .pipe(Effect.mapError(storeFailure("manifest")));

    // design-contracts §3/§9 promise that what lands on disk is the resolved NON-SENSITIVE
    // config. `providerOptions` is an open record, so anything parked under a sensitive key is
    // blanked here instead of being trusted, and its value is redacted wherever else it appears.
    const secretValues: Array<string> = [...collectSensitiveValues(config.providerOptions)];
    let redactor: Redactor = makeRedactor(secretValues);
    const safeConfig = sanitizeConfig(config, redactor);

    yield* store
      .emit({
        type: "configResolved",
        config: safeConfig,
        ...(request.configSource === undefined ? {} : { configPath: request.configSource }),
      })
      .pipe(Effect.mapError(storeFailure("validate")));

    yield* store.writeSpecCopy(spec.source).pipe(Effect.mapError(storeFailure("manifest")));
    yield* store.ensureAttemptDirs(attemptId).pipe(Effect.mapError(storeFailure("manifest")));

    const emit = (event: Parameters<typeof store.emit>[0]) => store.emit(event).pipe(Effect.ignore);

    // --- step 2: persist the INITIAL manifest, before any setup can fail ----------------------
    // spec §6 step 2. design-contracts §9 makes manifest.json the sole record of which adapter
    // ran, so it has to exist before the fixture and the contract freeze: a run that dies in
    // infrastructure setup must still be attributable and reportable.
    const baseManifest = {
      schemaVersion: 1 as const,
      runId: request.runId,
      createdAt: startedAt,
      specPath: request.specPath,
      harnessVersion: request.harnessVersion,
      nodeVersion: typeof process === "undefined" ? "unknown" : process.version,
      dependencies: { ...request.dependencies },
      model: { provider: provider.id, modelId: provider.modelId, adapterId: provider.id },
      ...(verifier.identity === undefined ? {} : { evaluator: verifier.identity }),
      config: safeConfig,
    };
    yield* store
      .writeManifest({
        ...baseManifest,
        stage: "initial",
        scenarioId: spec.frontmatter.id,
      })
      .pipe(Effect.mapError(storeFailure("manifest")));

    const finish = (outcome: AttemptOutcome, contract: ScenarioContract | undefined) =>
      finalize({ request, store, outcome, contract, startedAt, startedAtMs });

    /**
     * Every early return journals an `error` event before it writes the result (spec §10). The
     * reason is redacted like any other journalled text: a fixture or config failure can quote
     * back the value that broke it.
     */
    const failEarly = (stage: RunStage, reason: string) =>
      Effect.gen(function* () {
        const safeReason = redactor.text(reason);
        yield* emit({ type: "error", attemptId, stage, reason: safeReason, fatal: true });
        return yield* finish(emptyOutcome({ stage, reason: safeReason }), undefined);
      });

    // --- step 1: inputs, references and REGISTRIES --------------------------------------------
    const declaredInputs = yield* resolveInputPrecedence({
      source: request.configSource ?? spec.specPath,
      configInputs: config.inputs,
      specInputs: spec.frontmatter.inputs ?? {},
      ...(request.fileInputs === undefined ? {} : { fileInputs: request.fileInputs }),
      ...(request.cliInputs === undefined ? {} : { cliInputs: request.cliInputs }),
    }).pipe(Effect.result);
    if (declaredInputs._tag === "Failure") {
      return yield* failEarly("validate", declaredInputs.failure.message);
    }

    const resolvedInputs = yield* resolveInputs({
      declared: declaredInputs.success,
      source: spec.specPath,
      run: { id: request.runId },
      attempt: { id: attemptId },
      anchors: spec.fieldLines,
    }).pipe(Effect.result);
    if (resolvedInputs._tag === "Failure") {
      return yield* failEarly("validate", resolvedInputs.failure.message);
    }
    const inputs = resolvedInputs.success;

    // Registries are validated HERE, not at verification time: a `checks: { c3: not-registered }`
    // mapping must be refused before a browser is opened, not discovered as a criterion `error`
    // once the whole walkthrough has already run.
    const references = yield* validateSpecRegistries({ spec, registries }).pipe(Effect.result);
    if (references._tag === "Failure") {
      return yield* failEarly("validate", references.failure.message);
    }

    // --- step 3a: optional fixture ------------------------------------------------------------
    let fixtureSession: FixtureSession | undefined;
    const fixtureName = spec.frontmatter.fixture;
    if (fixtureName !== undefined) {
      // Everything before `attemptBody` used to be unbounded: `attemptTimeoutMs` wraps the attempt
      // only, so a fixture that never returns hung the run forever with nothing to stop it.
      // `fixtureSetupTimeoutMs` is the blocking budget for this phase; exhausting it interrupts the
      // setup, which is what makes the manager run the cleanups it registered on the way in.
      const setup = yield* fixtures
        .setup({
          fixtureName,
          runId: request.runId,
          attemptId,
          inputs,
          baseUrl: config.baseUrl,
          cleanupTimeoutMs: config.budgets.fixtureCleanupTimeoutMs,
        })
        .pipe(Effect.result, Effect.timeoutOption(config.budgets.fixtureSetupTimeoutMs));
      if (Option.isNone(setup)) {
        const exhausted = new BudgetExhaustedError({
          budget: "fixtureSetupTimeout",
          limit: config.budgets.fixtureSetupTimeoutMs,
          used: config.budgets.fixtureSetupTimeoutMs,
          detail: `fixture "${fixtureName}" did not finish setting up`,
        });
        yield* emit({
          type: "budgetExhausted",
          attemptId,
          budget: exhausted.budget,
          limit: exhausted.limit,
          used: exhausted.used,
          detail: exhausted.detail ?? exhausted.message,
        });
        // A blocking budget is `inconclusive`, never `error` — design-contracts §7.
        return yield* finish(budgetOutcome(exhausted.message), undefined);
      }
      if (setup.value._tag === "Failure") {
        return yield* failEarly("fixture-setup", setup.value.failure.message);
      }
      fixtureSession = setup.value.success;
      // A fixture reports the secret VALUES it read through `ctx.secrets`; those are the only ones
      // the harness can strip (§13). From here on nothing — contract, prompt, journal or report —
      // carries them, not even if the fixture returned one under `public`.
      for (const value of fixtureSession.secretValues ?? []) secretValues.push(value);
      redactor = makeRedactor(secretValues);
      yield* emit({
        type: "fixtureReady",
        attemptId,
        fixtureName,
        publicValues: redactor.deep(fixtureSession.publicValues),
      });
    }

    // Released at most once: the ordered call sites below run it where the journal wants
    // `fixtureCleaned` (before `runFinished`), and the safety net attached to the rest of the run
    // then finds nothing left to do.
    let fixtureReleased = false;
    const cleanupFixture = Effect.suspend(() => {
      if (fixtureSession === undefined || fixtureReleased) return Effect.void;
      fixtureReleased = true;
      const session = fixtureSession;
      const timeoutMs = config.budgets.fixtureCleanupTimeoutMs;
      return session.cleanup({ timeoutMs }).pipe(
        // The manager is supposed to honour `timeoutMs` itself, and the one in apps/cli does. This
        // is the runner's OWN guard, and it is not redundant: cleanup runs in the uninterruptible
        // finalize tail, so a manager that ignored the deadline would wedge the process with
        // nothing left able to interrupt it. (A timeout still fires inside an uninterruptible
        // region — verified in .recon/critic-uninterruptible-timeout.ts.)
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.succeed({
              cleanupsRun: 0,
              timedOut: true,
              errors: [`fixture cleanup did not return within ${timeoutMs} ms`],
            } as FixtureCleanupReport),
        }),
        Effect.flatMap((report) =>
          emit({
            type: "fixtureCleaned",
            attemptId,
            fixtureName: session.fixtureName,
            cleanupsRun: report.cleanupsRun,
            timedOut: report.timedOut,
          }),
        ),
      );
    });

    // A fixture is a live RESOURCE from here on, so its release is attached to the whole
    // remainder of the run right where it is acquired. Attaching it later (it used to be bound
    // to the attempt only) leaked the fixture on every path that fails in between — a
    // `writeContract` or `writeManifest` store failure walks out of this gen without ever
    // reaching the attempt. `cleanupFixture` is idempotent, so the explicitly ordered call sites
    // inside still put `fixtureCleaned` in the journal before `runFinished`.
    return yield* Effect.gen(function* () {
      // --- step 3b: freeze the contract BEFORE any navigation -----------------------------------
      const frozen = yield* freezeContract({
        spec,
        specPath: request.specPath,
        config,
        runId: request.runId,
        attemptId,
        inputs,
        ...(fixtureSession === undefined
          ? {}
          : { fixturePublic: redactor.deep(fixtureSession.publicValues) }),
      }).pipe(Effect.result);
      if (frozen._tag === "Failure") {
        yield* cleanupFixture;
        return yield* failEarly("contract", frozen.failure.message);
      }
      const contract = frozen.success;

      yield* store.writeContract(contract).pipe(Effect.mapError(storeFailure("contract")));
      yield* emit({
        type: "contractFrozen",
        attemptId,
        contractHash: contract.hashes.contract,
        specHash: contract.hashes.spec,
        criterionIds: contract.criteria.map((c) => c.id),
      });

      // The manifest is now enriched with what the freeze produced; `stage` says which write this is.
      const manifest: Manifest = {
        ...baseManifest,
        stage: "final",
        scenarioId: contract.id,
        hashes: contract.hashes,
      };
      yield* store.writeManifest(manifest).pipe(Effect.mapError(storeFailure("manifest")));

      // --- steps 4-9 ----------------------------------------------------------------------------
      // `Effect.exit` does NOT catch interruption in v4 (.recon/critic-exit-interrupt2.ts): an
      // interrupted fiber dies where it stands and every statement after it is skipped, finalize
      // tail included — no `result.json`, no `runFinished`, so a cancellation could never be read
      // back as `cancelled` (design-contracts §8/§9/§12). The tail therefore runs inside ONE
      // uninterruptible region and only the attempt body stays interruptible, through `restore`.
      // Everything in that region is bounded: the attempt by `attemptTimeoutMs`, the browser
      // finalizer by the driver, fixture cleanup by `fixtureCleanupTimeoutMs`.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const outcome = yield* runAttempt({
            request,
            contract,
            store,
            driver,
            provider,
            verifier,
            registries,
            redactor,
            ...(fixtureSession === undefined ? {} : { fixtureSession }),
            startedAtMs,
            restore,
          }).pipe(Effect.onExit(() => cleanupFixture));

          return yield* finish(outcome, contract);
        }),
      );
    }).pipe(Effect.onExit(() => cleanupFixture));
  });

/** A blocking budget was exhausted before any criterion could be evaluated. */
const budgetOutcome = (detail: string): AttemptOutcome => ({
  criteria: [],
  artifacts: [],
  model: { calls: 0, inputTokens: 0, outputTokens: 0, verifierTokens: 0 },
  actionsUsed: 0,
  guidanceExceeded: false,
  budgetExhausted: true,
  budgetDetail: detail,
});

const emptyOutcome = (executionError: { stage: RunStage; reason: string }): AttemptOutcome => ({
  criteria: [],
  artifacts: [],
  model: { calls: 0, inputTokens: 0, outputTokens: 0, verifierTokens: 0 },
  actionsUsed: 0,
  guidanceExceeded: false,
  executionError,
});

interface AttemptDeps {
  readonly request: RunScenarioRequest;
  readonly contract: ScenarioContract;
  readonly store: RunStore["Service"];
  readonly driver: BrowserDriver["Service"];
  readonly provider: ModelProvider["Service"];
  readonly verifier: Verifier["Service"];
  readonly registries: Registries;
  /** Strips known secret values from everything the attempt journals or shows a model. */
  readonly redactor: Redactor;
  readonly fixtureSession?: FixtureSession;
  readonly startedAtMs: number;
  /**
   * Re-enables interruption for the attempt body only. The caller holds an uninterruptible mask so
   * that the finalize tail always runs; without this the attempt itself could not be cancelled.
   */
  readonly restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

const runAttempt = (deps: AttemptDeps): Effect.Effect<AttemptOutcome, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const { contract, driver, provider, redactor, registries, request, store, verifier } = deps;
    const { attemptId, config } = request;
    /** Budget and final-pass placeholders name the judge that would have run, not always the browser model. */
    const fallbackModelEvaluator = (): Evaluator =>
      verifier.identity === undefined
        ? { kind: "model", provider: provider.id, model: provider.modelId }
        : { kind: "model", provider: verifier.identity.provider, model: verifier.identity.modelId };
    const layout = store.layout;
    // Every journalled event goes through the redactor: the journal is the source of the report,
    // the live stream and `result.json`, so stripping known secrets here covers all three (§13).
    const journal = (event: Parameters<typeof store.emit>[0]) => store.emit(redactor.deep(event));
    const emit = (event: Parameters<typeof store.emit>[0]) => journal(event).pipe(Effect.ignore);

    /**
     * The attempt's Preuve recorder (runner/evidence.ts): the only thing that writes artifacts,
     * the owner of the evidence index, and the keeper of "mandatory evidence could not be
     * persisted" — spec §13 and design-contracts §8: a failure to save mandatory evidence must
     * not end in a silent success, so the criterion cannot be `passed` and the run resolves to
     * `error` (checked against `recorder.mandatoryFailures` at the end of the attempt).
     */
    const recorder = makeEvidenceRecorder({ store, attemptId, emitEvent: emit });

    /**
     * Transport-level retry for a model call the provider reports as RETRYABLE (a 429 with
     * `Retry-After`, a 5xx, a transport blip). This is the consumer `ProviderError.retryable`
     * existed for; the policy lives here, in the runner, next to the budgets it reads.
     *
     * `budgets.modelCallRetries` bounds how many times ONE call is re-attempted. Each retry
     * journals `modelCallRetried` and waits — 250 ms doubling, capped at 4 s, overridden by a
     * provider-reported `retryAfterMs`. The sleep is interruptible, so a cancellation or a
     * timeout of the surrounding attempt is honoured during the backoff, not after it. The input
     * is an `Effect.result` outcome, so the helper only ever inspects the failure channel: a
     * success passes through untouched and a non-retryable failure surfaces exactly as it would
     * have without the helper. Retries are TRANSPORT-level — they happen before any tool has run,
     * never replay a browser action, and the logical call still counts once against
     * `maxModelCalls`.
     */
    const withModelRetry =
      <
        E extends {
          readonly retryable?: boolean;
          readonly retryAfterMs?: number;
          readonly message: string;
        },
      >(options: {
        readonly role: ModelRole;
        readonly callId?: string;
      }) =>
      <A, R>(
        effect: Effect.Effect<Result<A, E>, never, R>,
      ): Effect.Effect<Result<A, E>, never, R> =>
        Effect.suspend(() =>
          Effect.gen(function* () {
            let outcome = yield* effect;
            let attempt = 0;
            while (
              outcome._tag === "Failure" &&
              outcome.failure.retryable === true &&
              attempt < contract.budgets.modelCallRetries
            ) {
              attempt += 1;
              const delayMs =
                outcome.failure.retryAfterMs ?? Math.min(250 * 2 ** (attempt - 1), 4_000);
              yield* emit({
                type: "modelCallRetried",
                attemptId,
                role: options.role,
                ...(options.callId === undefined ? {} : { callId: options.callId }),
                attempt,
                delayMs,
                reason: outcome.failure.message,
              });
              yield* Effect.sleep(Duration.millis(delayMs));
              outcome = yield* effect;
            }
            return outcome;
          }),
        );

    let budget: BudgetState = makeBudgetState(deps.startedAtMs);
    let budgetDetail: string | undefined;
    let executionError: { stage: RunStage; reason: string } | undefined;
    let cancellation: { reason: string } | undefined;
    let verifierTokens = 0;
    let stallNotified = false;
    const actionHistory: Array<string> = [];

    const results = new Map<string, CriterionResult>();
    for (const criterion of contract.criteria) {
      results.set(
        criterion.id,
        pendingResult(criterion, contract.hashes.criteria[criterion.id] ?? ""),
      );
    }

    const outcome = (): AttemptOutcome => ({
      criteria: contract.criteria.map((c) => results.get(c.id)!),
      artifacts: recorder.artifactIds(),
      model: {
        calls: budget.modelCalls,
        inputTokens: budget.inputTokens,
        outputTokens: budget.outputTokens,
        verifierTokens,
      },
      actionsUsed: dispatcher.actionsUsed(),
      guidanceExceeded: dispatcher.guidanceExceeded(),
      ...(cancellation === undefined ? {} : { cancellation }),
      ...(executionError === undefined ? {} : { executionError }),
      ...(budgetDetail === undefined ? {} : { budgetExhausted: true, budgetDetail }),
    });

    /** Poll the cancellation signal without blocking the loop. */
    const cancelReason = Effect.suspend(() => {
      if (request.cancellation === undefined) return Effect.succeed(Option.none<string>());
      return Deferred.poll(request.cancellation).pipe(
        Effect.flatMap((maybe) =>
          Option.isNone(maybe)
            ? Effect.succeed(Option.none<string>())
            : maybe.value.pipe(
                Effect.map(Option.some),
                Effect.catchCause(() => Effect.succeed(Option.some("cancelled"))),
              ),
        ),
      );
    });

    /** Completes only when a cancellation is requested. Something to RACE in-flight work against. */
    const cancelAwait: Effect.Effect<string> = Effect.suspend(() =>
      request.cancellation === undefined
        ? Effect.never
        : Deferred.await(request.cancellation).pipe(
            Effect.catchCause(() => Effect.succeed("cancelled")),
          ),
    );

    type Raced<A> =
      | { readonly _tag: "done"; readonly value: A }
      | { readonly _tag: "cancelled"; readonly reason: string };

    /**
     * Races in-flight work against the cancellation request instead of polling once per turn.
     * The loser is interrupted, which closes the scope `withAbortSignal` opened and so ABORTS the
     * HTTP request / Playwright call — polling left a wedged call running for the rest of the
     * attempt budget and honoured the cancellation only when it finally returned.
     */
    const racingCancellation = <A, R>(
      effect: Effect.Effect<A, never, R>,
    ): Effect.Effect<Raced<A>, never, R> =>
      Effect.race(
        effect.pipe(Effect.map((value): Raced<A> => ({ _tag: "done", value }))),
        cancelAwait.pipe(Effect.map((reason): Raced<A> => ({ _tag: "cancelled", reason }))),
      );

    /** Records a cancellation that a race just observed. */
    const noteCancellation = (reason: string) =>
      Effect.suspend(() => {
        cancellation = { reason };
        return emit({ type: "cancellationRequested", attemptId, reason, source: "api" });
      });

    const verifyCriterion = (
      session: BrowserSession,
      criterionId: string,
      requestedBy: "agent" | "runner",
    ): Effect.Effect<void, never, Crypto.Crypto> =>
      Effect.gen(function* () {
        const criterion = contract.criteria.find((c) => c.id === criterionId);
        if (criterion === undefined) return;
        const current = results.get(criterionId);
        if (current !== undefined && current.status !== "pending" && requestedBy === "runner")
          return;

        const requested = yield* store
          .emit({
            type: "evidenceRequested",
            attemptId,
            criterionId,
            requestedBy,
          })
          .pipe(Effect.result);
        const seq = requested._tag === "Success" ? requested.success.seq : 0;

        // The checkpoint capture is MANDATORY evidence for this evaluation: it is what a reader
        // (and the evaluator) has to look at. If it could not be persisted, this criterion can no
        // longer be `passed` — see `adjudicate` below.
        // Recorded in BOTH places as soon as it happens: the local list demotes this criterion,
        // the attempt-level one makes the run an `error` even if this evaluation returns early.
        const evidenceFailures: Array<string> = [];
        const evidenceFailed = (message: string) => {
          evidenceFailures.push(message);
          recorder.noteMandatoryFailure(message);
        };
        if (config.capture.screenshots !== "off") {
          const shot = yield* recorder.takeScreenshot(session, `checkpoint-${criterionId}`, {
            sourceSeq: seq,
          });
          if (shot.state !== "present") {
            evidenceFailed(
              `checkpoint capture for ${criterionId} (${shot.artifactId}): ${shot.reason ?? "capture failed"}`,
            );
          }
        }

        const hash = contract.hashes.criteria[criterionId] ?? "";

        let produced: CriterionResult;
        if (criterion.method === "code") {
          produced = yield* runCodeCheck({ criterion, hash, seq, evidenceFailed });
        } else {
          const decision = canStartModelCall({
            budgets: contract.budgets,
            state: budget,
            role: "verifier",
            nowMs: yield* Clock.currentTimeMillis,
          });
          if (decision._tag === "deny") {
            budgetDetail = decision.error.message;
            yield* emit({
              type: "budgetExhausted",
              attemptId,
              budget: decision.error.budget,
              limit: decision.error.limit,
              used: decision.error.used,
              detail: decision.error.detail ?? decision.error.message,
            });
            produced = {
              ...pendingResult(criterion, hash),
              evaluator: fallbackModelEvaluator(),
              status: "inconclusive",
              observed: "the token budget was exhausted before this criterion could be evaluated",
              limitations: decision.error.message,
              evaluatedAtSeq: seq,
            };
          } else {
            // design-contracts §3 makes `operationTimeoutMs` the per-operation bound, and it has to
            // apply to the verifier too: a wedged evaluation call used to consume the whole attempt
            // budget with `attemptTimeoutMs` as the only backstop. The signal goes with it so the
            // request is aborted rather than abandoned.
            const response = yield* withModelRetry({ role: "verifier" })(
              withAbortSignal((signal) =>
                verifier.verify({
                  attemptId,
                  criterion,
                  criterionHash: hash,
                  evidence: recorder.items(),
                  scenario: {
                    id: contract.id,
                    body: contract.body,
                    inputs: contract.inputs,
                    // The model sees PUBLIC fixture values only, and even those go through the redactor.
                    fixturePublic: redactor.deep(deps.fixtureSession?.publicValues ?? {}),
                  },
                  baseUrl: config.baseUrl,
                  seq,
                  signal,
                }),
              ).pipe(
                Effect.timeoutOrElse({
                  duration: contract.budgets.operationTimeoutMs,
                  orElse: () =>
                    Effect.fail(
                      new VerifierError({
                        criterionId,
                        reason:
                          `the evaluation call exceeded the per-operation timeout ` +
                          `(${contract.budgets.operationTimeoutMs} ms)`,
                        // A wedged evaluation is transport, not evidence: the runner may retry it.
                        retryable: true,
                      }),
                    ),
                }),
                Effect.result,
              ),
            );

            if (response._tag === "Failure") {
              produced = {
                ...pendingResult(criterion, hash),
                status: "error",
                observed: response.failure.message,
                evaluatedAtSeq: seq,
              };
            } else {
              budget = recordModelCall(budget);
              budget = chargeTokens(budget, "verifier", response.success.usage ?? {});
              verifierTokens = budget.verifierTokens;
              const outcomeValue = response.success.outcome;
              if (outcomeValue._tag === "needsEvidence") {
                // The expectation is NOT rewritten: the loop may keep navigating within budget.
                yield* emit({
                  type: "evidenceRequested",
                  attemptId,
                  criterionId,
                  requestedBy: "verifier",
                  note: outcomeValue.hint,
                });
                // ... but the final pass IS the last chance. Leaving the criterion `pending` would
                // record "never looked at" for something that was looked at and could not be
                // settled: it resolves to `inconclusive`, naming what was missing.
                if (requestedBy !== "runner") return;
                produced = {
                  ...pendingResult(criterion, hash),
                  evaluator: fallbackModelEvaluator(),
                  status: "inconclusive",
                  observed: `the available evidence does not settle this criterion: ${outcomeValue.missing.join(
                    "; ",
                  )}`,
                  limitations: outcomeValue.hint,
                  evaluatedAtSeq: seq,
                };
              } else {
                produced = outcomeValue.result;
              }
            }
          }
        }

        // Re-read the inventory: a code check mints its own probe evidence WHILE it runs, so the
        // snapshot taken before the evaluation would reject the very artifact it just produced.
        // The integrity rule is unchanged — the id must exist and belong to this attempt.
        const knownArtifacts = yield* store.attemptArtifacts(attemptId);

        // The law between an evaluator's answer and a recorded verdict — its rules, their order
        // and their strings live in `policy/adjudicate`, and the verifier crosses the same code
        // over the pre-evaluation snapshot (`screenProposal`).
        const admission = adjudicate({
          proposed: produced,
          current,
          requestedBy,
          attemptArtifacts: knownArtifacts,
          facts: {
            navigationSettled: dispatcher.navigationSettled(),
            checkpointReached: dispatcher.currentObservation() !== undefined,
          },
          persistenceFailures: evidenceFailures,
        });
        results.set(criterionId, admission.result);
        yield* emit({
          type: "verificationFinished",
          attemptId,
          criterionId,
          result: admission.result,
          ...(admission.applied ? {} : { note: admission.note }),
        });
      });

    interface CodeCheckOptions {
      readonly criterion: Criterion;
      readonly hash: string;
      readonly seq: number;
      /** Called when a probe payload this check journalled could not be written. */
      readonly evidenceFailed: (message: string) => void;
    }

    const codeCheckBody = (
      options: CodeCheckOptions,
    ): Effect.Effect<CriterionResult, never, Crypto.Crypto | Scope> =>
      Effect.gen(function* () {
        const { criterion, hash, seq } = options;
        const checkName = criterion.checkName ?? "";
        const base = pendingResult(criterion, hash);
        const lookup = yield* registries.checks.lookup(checkName).pipe(Effect.result);
        if (lookup._tag === "Failure") {
          return {
            ...base,
            status: "error" as const,
            observed: lookup.failure.message,
            evaluatedAtSeq: seq,
          };
        }
        const binding = yield* verifyCriterionBinding({
          checkName,
          criterionId: criterion.id,
          text: criterion.text,
          contractHash: hash,
        }).pipe(Effect.result);
        if (binding._tag === "Failure") {
          executionError = { stage: "verification", reason: binding.failure.message };
          yield* emit({
            type: "error",
            attemptId,
            stage: "verification",
            reason: binding.failure.message,
            fatal: true,
          });
          return {
            ...base,
            status: "error" as const,
            observed: binding.failure.message,
            evaluatedAtSeq: seq,
          };
        }

        // A check's probe output is journalled AND persisted: an artifact the report can cite must
        // have something behind it, so the payload is written next to the attempt's other evidence.
        //
        // The write runs on a fiber owned by THIS scope, not on a detached root fiber. With
        // `Effect.runPromise` the write was immune to the check's timeout, to the attempt scope and
        // to cancellation, so a slow check could journal `artifactAvailable` AFTER `runFinished`
        // and mutate `artifacts.json` after `result.json` had been written — the inventory on disk
        // then no longer matched the result (.recon/critic-runner-coop.ts, case B).
        const runEvidence = yield* FiberSet.makeRuntimePromise<never, string>();
        const recordEvidence = (e: {
          readonly label: string;
          readonly data: unknown;
        }): Promise<string> =>
          runEvidence(
            Effect.gen(function* () {
              const payload = yield* recorder.recordCheckPayload({
                label: e.label,
                data: e.data,
                seq,
              });
              if (payload.failed !== undefined) {
                // A check's probe output is mandatory evidence for its own criterion: a citation the
                // report cannot open is not a proof, so this forbids a `passed` further down.
                options.evidenceFailed(payload.failed);
              }
              return payload.artifactId;
            }),
          );

        // `signal` is aborted by the timeout below and by a cancellation, so a check that passes it
        // on to its own fetch/query is STOPPED rather than left running unobserved.
        const executed = yield* Effect.tryPromise({
          try: (signal) =>
            lookup.success({
              runId: request.runId,
              attemptId,
              criterion: { id: criterion.id, text: criterion.text, hash },
              inputs: contract.inputs,
              fixture: { public: deps.fixtureSession?.publicValues ?? {} },
              baseUrl: config.baseUrl,
              recordEvidence,
              signal,
            }),
          catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
        }).pipe(
          Effect.timeoutOrElse({
            duration: contract.budgets.operationTimeoutMs,
            orElse: () => Effect.fail(`check "${checkName}" exceeded the per-operation timeout`),
          }),
          Effect.result,
        );

        if (executed._tag === "Failure") {
          return {
            ...base,
            status: "error" as const,
            observed: String(executed.failure),
            evaluatedAtSeq: seq,
          };
        }
        const value = executed.success;
        return {
          ...base,
          status: value.status,
          evaluator: { kind: "code" as const, checkName },
          expected: value.expected,
          observed: value.observed,
          evidence: value.evidence as ReadonlyArray<string>,
          evaluatedAtSeq: seq,
        };
      });

    /**
     * Closing the scope interrupts every evidence write the check left in flight, so no artifact
     * can be journalled once the check has returned or timed out.
     */
    const runCodeCheck = (
      options: CodeCheckOptions,
    ): Effect.Effect<CriterionResult, never, Crypto.Crypto> =>
      Effect.scoped(codeCheckBody(options));

    // --- tool dispatch -------------------------------------------------------------------------

    /**
     * The tool dispatcher (runner/dispatcher.ts): the whole 8-case switch and the memory it
     * needs. It owns the live page state — `currentObservation` and `navigationSettled` are its
     * transitions, the runner only CONSULTS them (adjudication's facts below) — and the action
     * bookkeeping. `check` runs the evaluation through this closure: the law stays here, the
     * mechanism is borrowed.
     */
    const dispatcher = makeDispatcher({
      attemptId,
      store,
      emitEvent: emit,
      journalEvent: journal,
      redactor,
      recorder,
      operationTimeoutMs: contract.budgets.operationTimeoutMs,
      maxActions: contract.maxActions,
      allowedOrigins: config.allowedOrigins,
      screenshots: config.capture.screenshots,
      criterionIds: contract.criteria.map((c) => c.id),
      verifyCriterion: (session, criterionId) => verifyCriterion(session, criterionId, "agent"),
    });

    // --- the agent loop ------------------------------------------------------------------------

    const messages: Array<PromptMessage> = [
      {
        role: "system",
        parts: [
          {
            type: "text",
            // The prompt is redacted too: a secret that reached the contract through an input or a
            // fixture value must not be handed to the model (§13).
            text: redactor.text(
              systemPrompt(contract, {
                baseUrl: config.baseUrl,
                allowedOrigins: config.allowedOrigins,
              }),
            ),
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: "Start with `observe` to see the page, then act. Call `finish` once the walkthrough is done.",
          },
        ],
      },
    ];
    const tools = toolDefinitions();

    const agentLoop = (session: BrowserSession): Effect.Effect<void, never, Crypto.Crypto> =>
      Effect.gen(function* () {
        let idleTurns = 0;
        while (true) {
          const cancelled = yield* cancelReason;
          if (Option.isSome(cancelled)) {
            cancellation = { reason: cancelled.value };
            yield* emit({
              type: "cancellationRequested",
              attemptId,
              reason: cancelled.value,
              source: "api",
            });
            return;
          }
          if (dispatcher.finishRequested()) return;
          // A fatal execution error raised inside a tool dispatch (for instance a driver result
          // that does not decode) ends the loop here rather than being handed another turn.
          if (executionError !== undefined) return;

          const nowMs = yield* Clock.currentTimeMillis;
          const decision = canStartModelCall({
            budgets: contract.budgets,
            state: budget,
            role: "browser",
            nowMs,
          });
          if (decision._tag === "deny") {
            budgetDetail = decision.error.message;
            yield* emit({
              type: "budgetExhausted",
              attemptId,
              budget: decision.error.budget,
              limit: decision.error.limit,
              used: decision.error.used,
              detail: decision.error.detail ?? decision.error.message,
            });
            return;
          }

          const nudge = dispatcher.takePendingNudge();
          if (nudge !== undefined) {
            messages.push({ role: "user", parts: [{ type: "text", text: nudge }] });
          }

          const callId = `mc_${budget.modelCalls + 1}`;
          yield* emit({
            type: "modelCallStarted",
            attemptId,
            role: "browser" as ModelRole,
            callId,
            provider: provider.id,
            model: provider.modelId,
          });
          // Three things this call did not have before: a per-operation bound
          // (`operationTimeoutMs` — design-contracts §3), an `AbortSignal` so the HTTP request is
          // really aborted, and a race against the cancellation request so honouring a cancel does
          // not wait for a wedged call to return.
          const raced = yield* racingCancellation(
            withModelRetry({ role: "browser", callId })(
              withAbortSignal((signal) =>
                provider.generate({ role: "browser", prompt: { messages }, tools, signal }),
              ).pipe(
                // A provider that DIES (an SDK that throws where the seam declares a typed failure)
                // used to kill the attempt fiber, and the generic handler at the end of the attempt
                // attributes a dead fiber to the `browser` stage — so an exploding model adapter was
                // reported as a browser failure. The defect is named here, where we know whose it is.
                Effect.catchDefect((defect) =>
                  Effect.fail(
                    new ProviderError({
                      provider: provider.id,
                      reason: `the provider raised a defect: ${
                        defect instanceof Error ? defect.message : String(defect)
                      }`,
                      retryable: false,
                    }),
                  ),
                ),
                Effect.timeoutOrElse({
                  duration: contract.budgets.operationTimeoutMs,
                  orElse: () =>
                    Effect.fail(
                      new ProviderError({
                        provider: provider.id,
                        reason:
                          `the model call exceeded the per-operation timeout ` +
                          `(${contract.budgets.operationTimeoutMs} ms)`,
                        retryable: true,
                      }),
                    ),
                }),
                Effect.result,
              ),
            ),
          );
          budget = recordModelCall(budget);
          if (raced._tag === "cancelled") {
            yield* noteCancellation(raced.reason);
            return;
          }
          const response = raced.value;
          if (response._tag === "Failure") {
            executionError = { stage: "agent-loop", reason: response.failure.message };
            yield* emit({
              type: "error",
              attemptId,
              stage: "agent-loop",
              reason: response.failure.message,
              fatal: true,
            });
            return;
          }
          budget = chargeTokens(budget, "browser", response.success.usage ?? {});
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
            ...(response.success.finishReason === undefined
              ? {}
              : { finishReason: response.success.finishReason }),
          });

          const assistantParts: Array<PromptPart> = [];
          if (response.success.text !== undefined && response.success.text !== "") {
            assistantParts.push({ type: "text", text: response.success.text });
          }
          for (const call of response.success.toolCalls) {
            assistantParts.push({
              type: "toolCall",
              id: call.id,
              name: call.name,
              params: call.params,
            });
          }
          if (assistantParts.length > 0)
            messages.push({ role: "assistant", parts: assistantParts });

          if (response.success.toolCalls.length === 0) {
            idleTurns += 1;
            // `budgets.maxIdleTurns` is a BLOCKING budget like any other: declared in the config,
            // frozen into the contract, printed with the resolved configuration and recorded in the
            // manifest. It used to be a hardcoded `3` that silently ended the loop, which spec §7
            // does not sanction — §7 sanctions EMITTING `progressStalled`. Both happen now, and the
            // run resolves to `inconclusive`, never `failed`.
            if (idleTurns >= contract.budgets.maxIdleTurns) {
              yield* emit({
                type: "progressStalled",
                attemptId,
                reason: `the model produced ${idleTurns} consecutive turns without a tool call`,
                repeatedActions: idleTurns,
              });
              const exhausted = new BudgetExhaustedError({
                budget: "maxIdleTurns",
                limit: contract.budgets.maxIdleTurns,
                used: idleTurns,
                detail: "the model stopped calling tools, so the walkthrough could not progress",
              });
              budgetDetail = exhausted.message;
              yield* emit({
                type: "budgetExhausted",
                attemptId,
                budget: exhausted.budget,
                limit: exhausted.limit,
                used: exhausted.used,
                detail: exhausted.detail ?? exhausted.message,
              });
              return;
            }
            messages.push({
              role: "user",
              parts: [{ type: "text", text: "Use a tool to make progress, or call `finish`." }],
            });
            continue;
          }
          idleTurns = 0;

          const resultParts: Array<PromptPart> = [];
          for (const call of response.success.toolCalls) {
            const signature = `${call.name}:${JSON.stringify(call.params ?? {})}`;
            actionHistory.push(signature);
            if (
              !stallNotified &&
              actionHistory.length >= 3 &&
              actionHistory.slice(-3).every((s) => s === signature)
            ) {
              stallNotified = true;
              yield* emit({
                type: "progressStalled",
                attemptId,
                reason: `the same action was repeated three times: ${call.name}`,
                repeatedActions: 3,
              });
            }
            // The dispatch loop is raced too: a cancellation during a 15 s Playwright action used
            // to be noticed only at the top of the NEXT turn. Interrupting the action aborts it
            // through the driver's own signals; the journal stays paired because the interrupt
            // handler closes the `actionStarted` it left open.
            const dispatchedRace = yield* racingCancellation(
              dispatcher
                .dispatch(session, call)
                .pipe(Effect.onInterrupt(() => dispatcher.closeInterruptedAction())),
            );
            if (dispatchedRace._tag === "cancelled") {
              yield* noteCancellation(dispatchedRace.reason);
              return;
            }
            const dispatched = dispatchedRace.value;
            if (dispatched.executionError !== undefined) executionError = dispatched.executionError;
            resultParts.push({
              type: "toolResult",
              id: call.id,
              name: call.name,
              result: dispatched.result,
              isError: dispatched.isError,
            });
            if (dispatcher.finishRequested() || executionError !== undefined) break;
          }
          messages.push({ role: "user", parts: resultParts });
        }
      });

    // --- the attempt body, scoped so cancellation closes the browser -----------------------------

    const attemptBody = Effect.gen(function* () {
      const session = yield* driver.openContext({
        attemptId,
        baseUrl: config.baseUrl,
        ...(deps.fixtureSession?.storageState === undefined
          ? {}
          : { storageState: deps.fixtureSession.storageState }),
        capture: config.capture,
        attemptDir: layout.attemptDir(attemptId),
        screenshotsDir: layout.screenshotsDir(attemptId),
        operationTimeoutMs: contract.budgets.operationTimeoutMs,
      });
      yield* emit({
        type: "browserContextOpened",
        attemptId,
        baseUrl: config.baseUrl,
        usedStorageState: deps.fixtureSession?.storageState !== undefined,
        capture: config.capture,
      });

      // A cancelled or timed-out attempt never reaches step 9, and the driver's own scope
      // finalizer can only DISCARD what its `finalize` produced — so the trace and the logs landed
      // on disk but were absent from `artifacts.json`, which §9 defines as the inventory of every
      // expected artifact. This finalizer is registered after the driver's, so it runs first and
      // its captures are journalled; `finalize` is idempotent, so the happy path pays nothing.
      yield* Effect.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : session.finalize({ retainTrace: true }).pipe(
              Effect.flatMap((captures) =>
                Effect.forEach(captures, (capture) => recorder.registerCapture(capture), {
                  discard: true,
                }),
              ),
              Effect.timeoutOrElse({
                duration: contract.budgets.operationTimeoutMs,
                orElse: () => Effect.void,
              }),
              Effect.catchCause(() => Effect.void),
            ),
      );

      // Step 4: captures are live before any scenario action; step 5-6: the agent loop.
      const initial = yield* session.navigate({ url: config.baseUrl }).pipe(Effect.result);
      if (initial._tag === "Failure") {
        executionError = { stage: "browser", reason: initial.failure.message };
        yield* emit({
          type: "error",
          attemptId,
          stage: "browser",
          reason: initial.failure.message,
          fatal: true,
        });
      } else {
        // The absence rule starts from what the driver reported about this first load (§8).
        dispatcher.noteNavigationSettled(initial.success.settled);
        yield* agentLoop(session);
      }

      // Steps 7-8: every criterion still unresolved is evaluated before aggregation. The final
      // pass is raced against the cancellation request too, so a cancel arriving here is honoured
      // within one evaluation instead of after all of them.
      if (cancellation === undefined && executionError === undefined) {
        for (const criterion of contract.criteria) {
          const current = results.get(criterion.id);
          if (current !== undefined && current.status === "pending") {
            const verified = yield* racingCancellation(
              verifyCriterion(session, criterion.id, "runner"),
            );
            if (verified._tag === "cancelled") {
              yield* noteCancellation(verified.reason);
              break;
            }
          }
        }
      }

      // Step 9: settle the evidence. A failed capture is recorded, never hidden.
      const retainTrace =
        config.capture.retainTraceOn === "all" ||
        contract.criteria.some((c) => results.get(c.id)?.status !== "passed");
      // Bounded like every other call into the driver. This one is the last statement of a run
      // that is otherwise FINISHED: a trace that never stops settling would have held the whole
      // remaining attempt budget with nothing smaller than `attemptTimeoutMs` to cut it, and the
      // two finalizer paths that do the same work (the scope finalizer above, and the driver's own)
      // are already bounded by `operationTimeoutMs`. A timeout is reported as a failed capture
      // instead of being swallowed — spec §10: a capture failure is recorded, never hidden.
      const captures = yield* session.finalize({ retainTrace }).pipe(
        Effect.timeoutOrElse({
          duration: contract.budgets.operationTimeoutMs,
          orElse: () =>
            Effect.succeed<ReadonlyArray<CaptureOutcome>>([
              {
                kind: "trace",
                state: "failed",
                reason:
                  `closing the browser context exceeded the per-operation timeout ` +
                  `(${contract.budgets.operationTimeoutMs} ms)`,
              },
            ]),
        }),
      );
      for (const capture of captures) {
        yield* recorder.registerCapture(capture);
      }
    });

    // `deps.restore` is the ONLY interruptible window of the run: the caller holds an
    // uninterruptible mask so that whatever happens here, the outcome is still aggregated, written
    // and journalled. Inside that window `Effect.exit` does capture an interrupt — verified in
    // .recon/critic-exit-interrupt3.ts — so the tail below really runs.
    const exit = yield* Effect.exit(
      deps.restore(
        Effect.scoped(attemptBody).pipe(
          Effect.timeoutOrElse({
            duration: contract.budgets.attemptTimeoutMs,
            // The `attemptTimeout` budget is the ONLY blocking one that fires here rather than at a
            // pre-call gate, and it used to leave no trace: a run could end on an exhausted
            // blocking budget with no `budgetExhausted` event in the journal to explain it.
            orElse: () =>
              Effect.gen(function* () {
                const nowMs = yield* Clock.currentTimeMillis;
                budgetDetail = `blocking budget attemptTimeout exhausted (${contract.budgets.attemptTimeoutMs} ms)`;
                yield* emit({
                  type: "budgetExhausted",
                  attemptId,
                  budget: "attemptTimeout",
                  limit: contract.budgets.attemptTimeoutMs,
                  used: Math.max(contract.budgets.attemptTimeoutMs, nowMs - deps.startedAtMs),
                  detail: budgetDetail,
                });
              }),
          }),
        ),
      ),
    );
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterrupts(exit.cause)) {
        // An interrupt IS a cancellation: someone (Ctrl-C, a supervisor, an enclosing timeout)
        // asked the run to stop. design-contracts §8 aggregates that to `cancelled`, and §12 maps
        // it to exit 130 — neither is possible unless the outcome says so.
        if (cancellation === undefined) {
          cancellation = { reason: "the run was interrupted" };
          yield* emit({
            type: "cancellationRequested",
            attemptId,
            reason: cancellation.reason,
            source: "signal",
          });
        }
      } else if (executionError === undefined && cancellation === undefined) {
        const reason = Cause.pretty(exit.cause);
        executionError = { stage: "browser", reason };
        yield* emit({ type: "error", attemptId, stage: "browser", reason, fatal: true });
      }
    }

    // design-contracts §8: a failure to persist MANDATORY evidence is an `error`, ranked with a
    // blocking execution error and above a product failure. The individual criterion statuses are
    // preserved either way — `finalize` carries them into `result.json` whatever the aggregate is.
    if (
      recorder.mandatoryFailures.length > 0 &&
      executionError === undefined &&
      cancellation === undefined
    ) {
      const reason = `mandatory evidence could not be persisted: ${recorder.mandatoryFailures.join("; ")}`;
      executionError = { stage: "evidence", reason };
      yield* emit({ type: "error", attemptId, stage: "evidence", reason, fatal: true });
    }

    return outcome();
  });

const finalize = (options: {
  readonly request: RunScenarioRequest;
  readonly store: RunStore["Service"];
  readonly outcome: AttemptOutcome;
  readonly contract: ScenarioContract | undefined;
  readonly startedAt: string;
  readonly startedAtMs: number;
}): Effect.Effect<RunResult, RunFailure> =>
  Effect.gen(function* () {
    const { contract, outcome, request, store } = options;
    const finishedAtMs = yield* Clock.currentTimeMillis;
    const finishedAt = DateTime.formatIso(yield* DateTime.now);
    const durationMs = finishedAtMs - options.startedAtMs;

    const verdict = aggregate({
      ...(outcome.cancellation === undefined ? {} : { cancellation: outcome.cancellation }),
      ...(outcome.executionError === undefined ? {} : { executionError: outcome.executionError }),
      criteria: outcome.criteria,
      ...(outcome.budgetExhausted === undefined
        ? {}
        : { budgetExhausted: outcome.budgetExhausted }),
      ...(outcome.budgetDetail === undefined ? {} : { budgetDetail: outcome.budgetDetail }),
    });

    const attemptCommon = {
      attemptId: request.attemptId,
      startedAt: options.startedAt,
      finishedAt,
      durationMs,
      criteria: outcome.criteria,
      actions: {
        used: outcome.actionsUsed,
        guidance: contract?.maxActions ?? request.config.maxActions,
        guidanceExceeded: outcome.guidanceExceeded,
      },
      model: outcome.model,
      artifacts: outcome.artifacts,
    };

    const attempt: AttemptResult =
      verdict.status === "cancelled"
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
                  ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
                }
              : { ...attemptCommon, status: "passed" };

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
      finalized: true,
    };

    const result: RunResult =
      verdict.status === "cancelled"
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
                  ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
                }
              : { ...runCommon, status: "passed" };

    yield* store
      .writeResult(result)
      .pipe(
        Effect.mapError((cause) => new RunFailure({ stage: "aggregate", reason: cause.message })),
      );
    yield* store
      .emit({
        type: "runFinished",
        attemptId: request.attemptId,
        durationMs,
        status: result.status,
        criteriaCount: outcome.criteria.length,
        failedCriteria: outcome.criteria
          .filter((c) => c.status === "failed")
          .map((c) => c.criterionId),
      })
      .pipe(Effect.ignore);

    return result;
  });
