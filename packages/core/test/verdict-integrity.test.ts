import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import {
  BrowserDriver,
  FixtureManager,
  makeRegistry,
  parseSpec,
  readRunJournal,
  resolveConfig,
  RunStore,
  runScenario,
  Verifier
} from "../src/index.js"
import type {
  AbsenceBranch,
  BrowserSession,
  CaptureOutcome,
  Check,
  CriterionResult,
  EvidenceItem,
  Fixture,
  FixtureSession,
  HarnessEvent,
  LoadedSpec,
  ObserveResult,
  RunResult,
  VerificationResponse
} from "../src/index.js"
import { scriptedProvider } from "./fakes.js"
import type { ScriptedTurn } from "./fakes.js"
import { expectSuccess, platform, readFixture } from "./helpers.js"

const runId = "r_abcdefghijklm"

const spec = (name: string) => parseSpec({ specPath: name, content: readFixture(name) })

/** One canned answer from the evaluator. Several per criterion = one per `check` call. */
interface Verdict {
  readonly status: CriterionResult["status"]
  readonly observed?: string
  readonly absence?: AbsenceBranch
  /** Overrides the evidence the verdict cites — used to invent references. */
  readonly evidence?: ReadonlyArray<string>
}

/** A verifier whose answers are a QUEUE per criterion, so the second `check` can differ. */
const queuedVerifier = (queues: Readonly<Record<string, ReadonlyArray<Verdict>>>, fallback: Verdict) => {
  const taken: Record<string, number> = {}
  return Layer.succeed(
    Verifier,
    Verifier.of({
      id: "queued-verifier",
      verify: (request) =>
        Effect.sync((): VerificationResponse => {
          const id = request.criterion.id
          const index = taken[id] ?? 0
          taken[id] = index + 1
          const queue = queues[id]
          const verdict = queue === undefined ? fallback : queue[Math.min(index, queue.length - 1)] ?? fallback
          return {
            outcome: {
              _tag: "verdict",
              result: {
                criterionId: id,
                criterionHash: request.criterionHash,
                status: verdict.status,
                method: "model",
                evaluator: { kind: "scripted-model" },
                expected: request.criterion.text,
                observed: verdict.observed ?? `scripted observation ${index + 1}`,
                evidence: verdict.evidence ?? request.evidence.map((e: EvidenceItem) => e.artifactId),
                ...(verdict.absence === undefined ? {} : { absence: verdict.absence }),
                evaluatedAtSeq: request.seq
              }
            },
            usage: { inputTokens: 20, outputTokens: 10 }
          }
        })
    })
  )
}

interface BrowserOptions {
  readonly screenshotFails?: boolean
  /** What the driver reports about the first (and every) navigation settling. */
  readonly settles?: boolean
}

const browserLayer = (options: BrowserOptions = {}) => {
  let url = "http://127.0.0.1:3000/"
  const session: BrowserSession = {
    observe: (observationId) =>
      Effect.succeed(
        {
          observationId,
          url,
          title: "Fixture app",
          snapshot: `- button "Créer" [ref=e1]`,
          elements: [{ ref: "e1", role: "button", name: "Créer" }]
        } satisfies ObserveResult
      ),
    navigate: ({ url: target }) =>
      Effect.sync(() => {
        url = target
        return { url: target, settled: options.settles ?? true }
      }),
    click: () => Effect.succeed({ performed: true as const, navigated: false }),
    fill: () => Effect.succeed({ performed: true as const, navigated: false }),
    press: () => Effect.succeed({ performed: true as const, navigated: false }),
    scroll: () => Effect.succeed({ performed: true as const, navigated: false }),
    screenshot: ({ fileName, label }) =>
      Effect.succeed(
        (options.screenshotFails === true
          ? { kind: "screenshot", state: "failed", reason: "disk full", ...(label === undefined ? {} : { label }) }
          : {
            kind: "screenshot",
            state: "present",
            path: `/tmp/${fileName}`,
            bytes: 128,
            ...(label === undefined ? {} : { label })
          }) satisfies CaptureOutcome
      ),
    currentUrl: Effect.sync(() => url),
    consoleEntries: Effect.succeed([]),
    networkEntries: Effect.succeed([]),
    finalize: () => Effect.succeed([{ kind: "trace", state: "present", path: "/tmp/trace.zip" } as CaptureOutcome])
  }
  return Layer.succeed(BrowserDriver, BrowserDriver.of({ id: "fake", openContext: () => Effect.succeed(session) }))
}

const fixtureLayer = (session: Partial<FixtureSession> = {}) =>
  Layer.succeed(
    FixtureManager,
    FixtureManager.of({
      setup: (request) =>
        Effect.succeed({
          fixtureName: request.fixtureName,
          publicValues: session.publicValues ?? {},
          ...(session.secretValues === undefined ? {} : { secretValues: session.secretValues }),
          cleanup: () => Effect.succeed({ cleanupsRun: 1, timedOut: false, errors: [] })
        } satisfies FixtureSession)
    })
  )

interface RunOptions {
  readonly spec: LoadedSpec
  readonly turns: ReadonlyArray<ScriptedTurn>
  readonly verdicts?: Readonly<Record<string, ReadonlyArray<Verdict>>>
  readonly fallback?: Verdict
  readonly configOverrides?: Record<string, unknown>
  readonly checks?: Record<string, Check>
  readonly browser?: BrowserOptions
  readonly fixture?: Partial<FixtureSession>
}

interface RunOutput {
  readonly result: RunResult
  readonly events: ReadonlyArray<HarnessEvent>
  readonly runRoot: string
  readonly journalText: string
  readonly contractText: string
  readonly manifestText: string
}

const execute = (options: RunOptions) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "harness-verdicts-" }).pipe(Effect.orDie)
    const project = yield* expectSuccess(resolveConfig({
      source: "harness.config.ts",
      config: { outputDir: dir, ...options.configOverrides }
    }))

    const result = yield* runScenario({
      spec: options.spec,
      specPath: options.spec.specPath,
      config: project.config,
      registries: {
        fixtures: makeRegistry<Fixture>("fixture", { "authenticated-workspace": async () => ({ public: {} }) }),
        checks: makeRegistry<Check>("check", options.checks ?? {})
      },
      runId,
      attemptId: "a1",
      harnessVersion: "0.1.0-test",
      dependencies: { effect: "4.0.0-rc.113" }
    }).pipe(
      Effect.provide(Layer.mergeAll(
        RunStore.layer({ runId, outputDir: dir }),
        browserLayer(options.browser),
        scriptedProvider(options.turns),
        queuedVerifier(options.verdicts ?? {}, options.fallback ?? { status: "passed" }),
        fixtureLayer(options.fixture)
      )),
      Effect.orDie
    )

    const runRoot = `${dir}/${runId}`
    const journal = yield* readRunJournal(`${runRoot}/events.jsonl`).pipe(Effect.orDie)
    const read = (name: string) =>
      fs.readFileString(`${runRoot}/${name}`).pipe(Effect.catchCause(() => Effect.succeed("")))
    return {
      result,
      events: journal.events,
      runRoot,
      journalText: yield* read("events.jsonl"),
      contractText: yield* read("contract.json"),
      manifestText: yield* read("manifest.json")
    } satisfies RunOutput
  })

const observe = { name: "observe", params: {} }
const finish = { name: "finish", params: {} }
const check = (criterionId: string) => ({ name: "check", params: { criterionId } })

const criterion = (out: RunOutput, id: string): CriterionResult =>
  out.result.attempts[0]!.criteria.find((c) => c.criterionId === id)!

describe("verdict integrity — a re-`check` never upgrades a decided criterion", () => {
  it.effect("a `failed` criterion stays failed when the agent asks again and gets `passed`", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [
          { toolCalls: [observe] },
          { toolCalls: [check("c1")] },
          { toolCalls: [check("c1")] },
          { toolCalls: [finish] }
        ],
        verdicts: {
          c1: [
            { status: "failed", observed: "le projet n'apparaît pas" },
            { status: "passed", observed: "il est là finalement" }
          ]
        }
      })

      const c1 = criterion(out, "c1")
      expect(c1.status).toBe("failed")
      expect(c1.observed).toBe("le projet n'apparaît pas")
      expect(out.result.status).toBe("failed")
      // The later answer is not lost: it is recorded as an observation that changed nothing.
      expect(c1.reChecks).toHaveLength(1)
      expect(c1.reChecks![0]).toMatchObject({ status: "passed", applied: false, requestedBy: "agent" })
      // Both evaluations are in the journal, and the second one carries the rule that was applied.
      const verifications = out.events.filter((e) => e.type === "verificationFinished")
      expect(verifications).toHaveLength(3 + 1)
      expect(verifications[1]).toMatchObject({ criterionId: "c1" })
      expect((verifications[1] as { note?: string }).note).toContain("never upgrades")
    }).pipe(Effect.provide(platform)))

  it.effect("a later evaluation may still make a `passed` criterion worse", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [check("c1")] }, { toolCalls: [check("c1")] }, {
          toolCalls: [finish]
        }],
        verdicts: {
          c1: [
            { status: "passed", observed: "présent avant rechargement" },
            { status: "failed", observed: "disparu après rechargement" }
          ]
        }
      })
      const c1 = criterion(out, "c1")
      expect(c1.status).toBe("failed")
      expect(c1.observed).toBe("disparu après rechargement")
      expect(c1.reChecks![0]).toMatchObject({ status: "failed", applied: true })
      expect(out.result.status).toBe("failed")
    }).pipe(Effect.provide(platform)))

  it.effect("an `inconclusive` criterion is not terminal: more evidence can still settle it", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [check("c1")] }, { toolCalls: [check("c1")] }, {
          toolCalls: [finish]
        }],
        verdicts: {
          c1: [
            { status: "inconclusive", observed: "pas encore rechargé" },
            { status: "passed", observed: "toujours là après rechargement" }
          ]
        }
      })
      const c1 = criterion(out, "c1")
      expect(c1.status).toBe("passed")
      expect(c1.reChecks).toBeUndefined()
      expect(out.result.status).toBe("passed")
    }).pipe(Effect.provide(platform)))
})

describe("evidence integrity applies to `method: code` exactly as it does to `model`", () => {
  const codeSpec = () => spec("coded-check.e2e.md")

  it.effect("a check citing an artifact that does not exist cannot pass", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(codeSpec())
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        checks: {
          "project-unique-in-storage": async () => ({
            status: "passed",
            expected: "exactement une ligne",
            observed: "une seule ligne en base",
            evidence: ["art_999"]
          })
        }
      })
      const c2 = criterion(out, "c2")
      expect(c2.status).toBe("inconclusive")
      expect(c2.evidence).toEqual([])
      expect(c2.downgrades![0]).toMatchObject({ reason: "rejected-evidence", from: "passed", to: "inconclusive" })
      expect(out.result.status).toBe("inconclusive")
    }).pipe(Effect.provide(platform)))

  it.effect("a check citing the evidence it just journalled passes: the inventory is re-read", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(codeSpec())
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        checks: {
          "project-unique-in-storage": async (ctx) => {
            const artifactId = await ctx.recordEvidence({ label: "probe", data: { rows: 1 } })
            return {
              status: "passed",
              expected: "exactement une ligne",
              observed: "une seule ligne en base",
              evidence: [artifactId]
            }
          }
        }
      })
      const c2 = criterion(out, "c2")
      expect(c2.status).toBe("passed")
      expect(c2.evidence).toHaveLength(1)
      expect(c2.downgrades).toBeUndefined()
      expect(out.result.status).toBe("passed")
    }).pipe(Effect.provide(platform)))

  it.effect("a check that passes while citing nothing at all is not a verified criterion", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(codeSpec())
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        checks: {
          "project-unique-in-storage": async () => ({
            status: "passed",
            expected: "exactement une ligne",
            observed: "j'ai regardé, promis",
            evidence: []
          })
        }
      })
      expect(criterion(out, "c2").status).toBe("inconclusive")
    }).pipe(Effect.provide(platform)))
})

describe("the absence rule is a harness decision, not a claim the evaluator makes", () => {
  it.effect("a failure resting on an absence after uncertain navigation is downgraded", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        fallback: { status: "failed", observed: "je ne vois pas le projet", absence: "uncertain-navigation" }
      })
      const c1 = criterion(out, "c1")
      expect(c1.status).toBe("inconclusive")
      expect(c1.absence).toBe("uncertain-navigation")
      expect(c1.downgrades!.some((d) => d.reason === "absence-uncertain-navigation")).toBe(true)
      // Never `failed`: the harness would not turn "I could not see it" into a product failure.
      expect(out.result.status).toBe("inconclusive")
    }).pipe(Effect.provide(platform)))

  it.effect("claiming the checkpoint branch does not help when the navigation never settled", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        browser: { settles: false },
        fallback: { status: "failed", observed: "absent", absence: "established-at-checkpoint" }
      })
      const c1 = criterion(out, "c1")
      expect(c1.status).toBe("inconclusive")
      // The branch RECORDED is the one the harness derived, not the one the evaluator claimed.
      expect(c1.absence).toBe("uncertain-navigation")
      expect(c1.downgrades!.some((d) => d.reason === "absence-uncertain-navigation")).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("an absence established on a settled, observed page still fails", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        fallback: { status: "failed", observed: "absent après rechargement", absence: "established-at-checkpoint" }
      })
      const c1 = criterion(out, "c1")
      expect(c1.status).toBe("failed")
      expect(c1.absence).toBe("established-at-checkpoint")
      expect(c1.downgrades).toBeUndefined()
      expect(out.result.status).toBe("failed")
    }).pipe(Effect.provide(platform)))
})

describe("a failure to persist mandatory evidence can never end in a silent success", () => {
  it.effect("a criterion whose checkpoint capture failed is not `passed`, and the run is an error", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        browser: { screenshotFails: true }
      })
      // Aggregation order (design-contracts §8): evidence-persistence failure ranks as `error`.
      expect(out.result.status).toBe("error")
      if (out.result.status === "error") {
        expect(out.result.stage).toBe("evidence")
        expect(out.result.reason).toContain("mandatory evidence could not be persisted")
      }
      for (const c of out.result.attempts[0]!.criteria) {
        expect(c.status).toBe("inconclusive")
        expect(c.downgrades!.some((d) => d.reason === "evidence-persistence-failed")).toBe(true)
        expect(c.limitations).toContain("disk full")
      }
      expect(out.events.some((e) => e.type === "error" && e.stage === "evidence")).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("a product failure keeps its own verdict when the capture also failed", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        browser: { screenshotFails: true },
        fallback: { status: "failed", observed: "le projet n'apparaît pas" }
      })
      expect(out.result.status).toBe("error")
      // spec §9: the criterion keeps its own status even when the aggregate is an error.
      expect(criterion(out, "c1").status).toBe("failed")
    }).pipe(Effect.provide(platform)))
})

describe("known secrets never reach the contract, the journal or the manifest", () => {
  it.effect("a secret a fixture leaked into `public` is redacted everywhere it would be written", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        fixture: {
          publicValues: { workspaceName: "Espace démo", leaked: "sk-live-SUPERSECRET" },
          secretValues: ["sk-live-SUPERSECRET"]
        }
      })
      expect(out.journalText).not.toContain("sk-live-SUPERSECRET")
      expect(out.contractText).not.toContain("sk-live-SUPERSECRET")
      expect(out.journalText).toContain("[redacted]")
    }).pipe(Effect.provide(platform)))

  it.effect("a value parked under a sensitive `providerOptions` key never lands on disk", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        configOverrides: { providerOptions: { apiKey: "sk-ant-NOPE", script: "healthy" } }
      })
      expect(out.manifestText).not.toContain("sk-ant-NOPE")
      expect(out.journalText).not.toContain("sk-ant-NOPE")
      // The KEY is still visible — only its value is gone.
      expect(out.manifestText).toContain("apiKey")
      expect(out.manifestText).toContain("healthy")
    }).pipe(Effect.provide(platform)))
})
