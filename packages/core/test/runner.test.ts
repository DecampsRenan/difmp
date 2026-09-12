import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Result } from "effect"
import {
  FixtureError,
  FixtureManager,
  makeRegistry,
  parseSpec,
  readRunJournal,
  resolveConfig,
  RunStore,
  runScenario
} from "../src/index.js"
import type { Check, Fixture, HarnessEvent, LoadedSpec, ResolvedConfig, RunResult } from "../src/index.js"
import type { ModelProvider, RunFailure } from "../src/index.js"
import { dyingProvider, fakeBrowser, fakeFixtures, scriptedProvider, scriptedVerifier } from "./fakes.js"
import type { FakeBrowserOptions, ScriptedTurn, ScriptedVerdict } from "./fakes.js"
import { expectSuccess, platform, readFixture } from "./helpers.js"

const runId = "r_abcdefghijklm"

const spec = (name: string) => parseSpec({ specPath: name, content: readFixture(name) })

interface RunOptions {
  readonly spec: LoadedSpec
  readonly turns: ReadonlyArray<ScriptedTurn>
  readonly verdicts?: Readonly<Record<string, ScriptedVerdict>>
  readonly fallbackVerdict?: ScriptedVerdict
  readonly configOverrides?: Record<string, unknown>
  readonly fixtures?: Record<string, Fixture>
  readonly checks?: Record<string, Check>
  /** Makes `FixtureManager.setup` fail, to exercise a run that dies during infrastructure setup. */
  readonly fixtureSetupError?: string
  /** Passed to the fake browser — a failing screenshot, a `finalize` that never returns, … */
  readonly browserOptions?: FakeBrowserOptions
  /** Replaces the scripted model provider (used to make the provider DIE rather than fail). */
  readonly providerLayer?: Layer.Layer<ModelProvider>
  /**
   * Run-directory entries to pre-create as DIRECTORIES, so the store's write to that path really
   * fails. A genuine filesystem failure, not a stubbed one.
   */
  readonly blockWrites?: ReadonlyArray<string>
}

interface RunOutput {
  readonly result: RunResult
  readonly events: ReadonlyArray<HarnessEvent>
  readonly config: ResolvedConfig
  readonly fixtureCleanups: ReadonlyArray<string>
  readonly runRoot: string
}

interface RawRunOutput extends Omit<RunOutput, "result"> {
  /** `Failure` when `runScenario` itself failed — a store write, for instance. */
  readonly outcome: Result.Result<RunResult, RunFailure>
}

const executeRaw = (options: RunOptions) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "difmp-runner-" }).pipe(Effect.orDie)
    const project = yield* expectSuccess(resolveConfig({
      source: "difmp.config.ts",
      config: { outputDir: dir, ...options.configOverrides }
    }))
    for (const entry of options.blockWrites ?? []) {
      yield* fs.makeDirectory(`${dir}/${runId}/${entry}`, { recursive: true }).pipe(Effect.orDie)
    }
    const browser = fakeBrowser(options.browserOptions ?? {})
    const fixtures = fakeFixtures()
    const fixtureLayer = options.fixtureSetupError === undefined
      ? fixtures.layer
      : Layer.succeed(
        FixtureManager,
        FixtureManager.of({
          setup: (request) =>
            Effect.fail(
              new FixtureError({
                fixtureName: request.fixtureName,
                phase: "setup",
                reason: options.fixtureSetupError!
              })
            )
        })
      )

    const outcome = yield* runScenario({
      spec: options.spec,
      specPath: options.spec.specPath,
      config: project.config,
      registries: {
        fixtures: makeRegistry<Fixture>("fixture", options.fixtures ?? {}),
        checks: makeRegistry<Check>("check", options.checks ?? {})
      },
      runId,
      attemptId: "a1",
      harnessVersion: "0.1.0-test",
      dependencies: { effect: "4.0.0-rc.113" }
    }).pipe(
      Effect.provide(Layer.mergeAll(
        RunStore.layer({ runId, outputDir: dir }),
        browser.layer,
        options.providerLayer ?? scriptedProvider(options.turns),
        scriptedVerifier(options.verdicts ?? {}, options.fallbackVerdict ?? { status: "passed" }),
        fixtureLayer
      )),
      Effect.result
    )

    const journal = yield* readRunJournal(`${dir}/${runId}/events.jsonl`).pipe(Effect.orDie)
    return {
      outcome,
      events: journal.events,
      config: project.config,
      fixtureCleanups: fixtures.cleanups,
      runRoot: `${dir}/${runId}`
    } satisfies RawRunOutput
  })

/** The usual case: the run is expected to settle into a `RunResult`, whatever its status. */
const execute = (options: RunOptions) =>
  executeRaw(options).pipe(Effect.map((raw): RunOutput => {
    if (Result.isFailure(raw.outcome)) {
      throw new Error(`expected the run to settle, it failed with: ${raw.outcome.failure.message}`)
    }
    return { ...raw, result: raw.outcome.success }
  }))

const observe = { name: "observe", params: {} }
const finish = { name: "finish", params: {} }

describe("runner", () => {
  it.effect("runs the reference scenario end to end and passes", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [
          { toolCalls: [observe] },
          { toolCalls: [{ name: "click", params: { observationId: "obs_1", ref: "e1" } }] },
          { toolCalls: [finish] }
        ],
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })
      expect(out.result.status).toBe("passed")
      expect(out.result.attempts[0]!.criteria.map((c) => c.status)).toEqual(["passed", "passed", "passed"])
      expect(out.fixtureCleanups).toEqual(["authenticated-workspace"])
    }).pipe(Effect.provide(platform)))

  it.effect("freezes the contract before opening the browser context", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })
      const order = out.events.map((e) => e.type)
      expect(order.indexOf("contractFrozen")).toBeGreaterThan(-1)
      expect(order.indexOf("contractFrozen")).toBeLessThan(order.indexOf("browserContextOpened"))
      expect(order.indexOf("fixtureReady")).toBeLessThan(order.indexOf("contractFrozen"))

      const fs = yield* FileSystem.FileSystem
      const contract = JSON.parse(yield* fs.readFileString(`${out.runRoot}/contract.json`).pipe(Effect.orDie)) as {
        criteria: ReadonlyArray<{ id: string; text: string }>
        hashes: { criteria: Record<string, string> }
      }
      // Inputs and fixture values are resolved in the frozen text.
      expect(contract.criteria[0]!.text).toContain(`Projet ${runId}`)
      expect(Object.keys(contract.hashes.criteria)).toEqual(["c1", "c2", "c3"])
    }).pipe(Effect.provide(platform)))

  it.effect("a 40-action run still passes and warns exactly once", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const turns: Array<ScriptedTurn> = Array.from({ length: 40 }, () => ({ toolCalls: [observe] }))
      turns.push({ toolCalls: [finish] })
      const out = yield* execute({
        spec: loaded,
        turns,
        configOverrides: { budgets: { maxModelCalls: 100 } },
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })
      const warnings = out.events.filter((e) => e.type === "actionGuidanceExceeded")
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatchObject({ rendering: "26 actions / 25 indicatives" })
      expect(out.result.attempts[0]!.actions.used).toBe(40)
      expect(out.result.attempts[0]!.actions.guidanceExceeded).toBe(true)
      expect(out.result.status).toBe("passed")
    }).pipe(Effect.provide(platform)))

  it.effect("a blocking budget ends the loop as inconclusive, never failed", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const turns: Array<ScriptedTurn> = Array.from({ length: 20 }, () => ({ toolCalls: [observe] }))
      const out = yield* execute({
        spec: loaded,
        turns,
        configOverrides: { budgets: { maxModelCalls: 3 } },
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })
      expect(out.events.some((e) => e.type === "budgetExhausted")).toBe(true)
      expect(out.result.status).toBe("inconclusive")
      if (out.result.status === "inconclusive") expect(out.result.reason).toBe("budget-exhausted")
    }).pipe(Effect.provide(platform)))

  it.effect("`finish` alone never produces a pass: verification decides", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [finish] }],
        fallbackVerdict: { status: "failed", observed: "le projet n'apparaît pas" },
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })
      expect(out.result.status).toBe("failed")
      if (out.result.status === "failed") expect(out.result.failedCriteria).toEqual(["c1", "c2", "c3"])
    }).pipe(Effect.provide(platform)))

  it.effect("a criterion the verifier never resolves forbids `passed`", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [finish] }],
        verdicts: { c2: { status: "passed", verdict: false } },
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })
      expect(out.result.status).toBe("inconclusive")
      const c2 = out.result.attempts[0]!.criteria.find((c) => c.criterionId === "c2")
      // The final pass is the last chance to settle it: a verifier that still asks for evidence
      // there resolves to `inconclusive` (naming what was missing), never to `passed`.
      expect(c2!.status).toBe("inconclusive")
    }).pipe(Effect.provide(platform)))

  it.effect("rejects a stale observation reference without touching another element", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [
          { toolCalls: [observe] },
          { toolCalls: [{ name: "click", params: { observationId: "obs_99", ref: "e1" } }] },
          { toolCalls: [finish] }
        ],
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })
      const failedAction = out.events.find((e) => e.type === "actionFinished" && e.outcome === "error")
      expect(failedAction).toMatchObject({ tool: "click", code: "stale-observation" })
      // The rejected action still counts against the indicative threshold.
      expect(out.result.attempts[0]!.actions.used).toBe(2)
    }).pipe(Effect.provide(platform)))

  it.effect("blocks a navigation outside the allow-list", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [
          { toolCalls: [{ name: "navigate", params: { url: "https://evil.example/" } }] },
          { toolCalls: [finish] }
        ],
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })
      const blocked = out.events.find((e) => e.type === "actionFinished" && e.outcome === "error")
      expect(blocked).toMatchObject({ tool: "navigate", code: "origin-not-allowed" })
    }).pipe(Effect.provide(platform)))

  it.effect("reports a missing fixture as an execution error, before the browser opens", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({ spec: loaded, turns: [{ toolCalls: [finish] }] })
      expect(out.result.status).toBe("error")
      expect(out.events.some((e) => e.type === "browserContextOpened")).toBe(false)
      if (out.result.status === "error") {
        // spec §6 step 1 validates the REGISTRIES, so an unregistered name never reaches setup.
        expect(out.result.stage).toBe("validate")
        expect(out.result.reason).toContain("is not registered")
      }
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a check name that is not registered, before the browser opens", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("coded-check.e2e.md"))
      const out = yield* execute({ spec: loaded, turns: [{ toolCalls: [finish] }] })
      expect(out.result.status).toBe("error")
      expect(out.events.some((e) => e.type === "browserContextOpened")).toBe(false)
      expect(out.events.some((e) => e.type === "contractFrozen")).toBe(false)
      if (out.result.status === "error") {
        expect(out.result.stage).toBe("validate")
        expect(out.result.reason).toContain("project-unique-in-storage")
        expect(out.result.reason).toContain("c2")
      }
    }).pipe(Effect.provide(platform)))

  it.effect("writes the initial manifest at step 2, before the fixture can fail", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [finish] }],
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) },
        fixtureSetupError: "seed API refused the request (HTTP 503)"
      })
      expect(out.result.status).toBe("error")
      if (out.result.status === "error") expect(out.result.stage).toBe("fixture-setup")

      const fs = yield* FileSystem.FileSystem
      // The reporter can attribute the run even though nothing was ever frozen.
      expect(yield* fs.exists(`${out.runRoot}/contract.json`).pipe(Effect.orDie)).toBe(false)
      const manifest = JSON.parse(yield* fs.readFileString(`${out.runRoot}/manifest.json`).pipe(Effect.orDie)) as {
        stage: string
        scenarioId: string
        hashes?: unknown
        model: { adapterId: string }
      }
      expect(manifest.stage).toBe("initial")
      expect(manifest.hashes).toBeUndefined()
      expect(manifest.scenarioId).toBe("project-create")
      expect(manifest.model.adapterId).toBe("scripted")
      // The failure is journalled as an `error` event, not only folded into result.json.
      expect(out.events.some((e) => e.type === "error" && e.stage === "fixture-setup" && e.fatal)).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("enriches the manifest with the contract hashes once the freeze succeeded", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })
      const fs = yield* FileSystem.FileSystem
      const manifest = JSON.parse(yield* fs.readFileString(`${out.runRoot}/manifest.json`).pipe(Effect.orDie)) as {
        stage: string
        hashes?: { contract: string }
      }
      expect(manifest.stage).toBe("final")
      expect(manifest.hashes?.contract).toBe(out.result.contractHash)
    }).pipe(Effect.provide(platform)))
  it.effect("releases the fixture when a store write fails after it was acquired", () =>
    Effect.gen(function*() {
      // `writeContract` and `writeManifest` fail out of the run BEFORE the attempt starts, and the
      // fixture release used to be attached to the attempt only — so the freeze-failure branch
      // cleaned up and these two leaked the fixture (a seeded workspace, a database row, a server
      // process) for the rest of the process's life.
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* executeRaw({
        spec: loaded,
        turns: [{ toolCalls: [finish] }],
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) },
        blockWrites: ["contract.json"]
      })
      expect(Result.isFailure(out.outcome)).toBe(true)
      if (Result.isFailure(out.outcome)) expect(out.outcome.failure.stage).toBe("contract")
      expect(out.fixtureCleanups).toEqual(["authenticated-workspace"])
      expect(out.events.some((e) => e.type === "fixtureCleaned")).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("cleans the fixture up exactly once on the happy path", () =>
    Effect.gen(function*() {
      // The release is now attached both where the journal wants it and as a safety net around the
      // rest of the run; it must still run once and only once.
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })
      expect(out.result.status).toBe("passed")
      expect(out.fixtureCleanups).toEqual(["authenticated-workspace"])
      expect(out.events.filter((e) => e.type === "fixtureCleaned")).toHaveLength(1)
    }).pipe(Effect.provide(platform)))

  // `it.live`, not `it.effect`: the point of this test is a REAL deadline, and `it.effect` runs on
  // a TestClock whose time only moves when a test advances it — a wall-clock timeout would never
  // fire there and the run would hang exactly as it did before the fix.
  it.live("bounds the closing capture so a trace that never settles cannot wedge the run", () =>
    Effect.gen(function*() {
      // Step 9 ran `session.finalize` with no bound of its own: a driver that never returned held
      // the run until `attemptTimeoutMs`, which would have turned a finished, passing run into an
      // `inconclusive` on an exhausted blocking budget. `operationTimeoutMs` is the per-operation
      // bound everywhere else, and a timeout is reported as a FAILED capture, never swallowed.
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) },
        browserOptions: { finalizeHangs: true },
        configOverrides: { budgets: { operationTimeoutMs: 200, attemptTimeoutMs: 20_000 } }
      })
      expect(out.result.status).toBe("passed")
      expect(out.events.some((e) => e.type === "budgetExhausted")).toBe(false)
      const traces = out.events.filter((e) => e.type === "artifactAvailable" && e.kind === "trace")
      expect(traces).toHaveLength(1)
      expect(traces[0]).toMatchObject({ state: "failed" })
      expect(traces[0]).toMatchObject({ reason: expect.stringContaining("per-operation timeout") })
    }).pipe(Effect.provide(platform)))

  it.effect("never cites evidence the artifact inventory refused", () =>
    Effect.gen(function*() {
      // `recordArtifact` failures were ignored while the artifact still entered the evidence index,
      // so `result.json` could cite an `art_*` id that `artifacts.json` on disk never received —
      // a citation a reader cannot open. spec §10: a capture failure is never hidden.
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [{ toolCalls: [observe] }, { toolCalls: [finish] }],
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) },
        blockWrites: ["artifacts.json"]
      })
      const attempt = out.result.attempts[0]!
      expect(attempt.artifacts).toEqual([])
      for (const criterion of attempt.criteria) {
        expect(criterion.evidence).toEqual([])
        expect(criterion.status).not.toBe("passed")
      }
      // Mandatory checkpoint captures could not be persisted: the run is an `error`, and says so.
      expect(out.result.status).toBe("error")
      if (out.result.status === "error") expect(out.result.stage).toBe("evidence")
      expect(out.events.some((e) =>
        e.type === "error" && e.stage === "evidence" && !e.fatal && e.reason.includes("could not be recorded")
      )).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("blames the provider, not the browser, when the adapter raises a defect", () =>
    Effect.gen(function*() {
      // A provider that throws used to kill the attempt fiber, and a dead fiber is attributed to
      // the `browser` stage — an exploding model adapter was reported as a browser failure.
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const out = yield* execute({
        spec: loaded,
        turns: [],
        providerLayer: dyingProvider("the SDK exploded"),
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })
      expect(out.result.status).toBe("error")
      if (out.result.status === "error") {
        expect(out.result.stage).toBe("agent-loop")
        expect(out.result.reason).toContain("the SDK exploded")
      }
      const errors = out.events.filter((e) => e.type === "error")
      expect(errors.some((e) => e.type === "error" && e.stage === "agent-loop")).toBe(true)
      expect(errors.some((e) => e.type === "error" && e.stage === "browser")).toBe(false)
    }).pipe(Effect.provide(platform)))
})
