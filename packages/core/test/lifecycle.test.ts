// NOTE: these tests use `it.live` on purpose — `it.effect` installs a TestClock and no
// timeout under test would ever fire.
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Layer, PubSub, Schema } from "effect"
import {
  FixtureManager,
  makeRegistry,
  ModelProvider,
  parseSpec,
  ProviderError,
  readRunJournal,
  resolveConfig,
  RunStore,
  runScenario,
  Verifier,
  VerifierError
} from "../src/index.js"
import type { Check, Fixture, HarnessEvent, LoadedSpec, RunId, RunResult } from "../src/index.js"
import { fakeBrowser, fakeFixtures, scriptedProvider, scriptedVerifier } from "./fakes.js"
import { expectSuccess, platform, readFixture } from "./helpers.js"

/**
 * Cancellation, interruption and resource lifecycle. Every test here pins behaviour that was
 * PROVEN broken by a probe under `.recon/` — the probe name is quoted on each one.
 */

const runId = "r_abcdefghijklm" as RunId
const attemptId = "a1"

const spec = (name: string) => parseSpec({ specPath: name, content: readFixture(name) })

interface Wiring {
  readonly spec: LoadedSpec
  readonly configOverrides?: Record<string, unknown>
  readonly provider?: Layer.Layer<ModelProvider>
  readonly fixtureLayer?: Layer.Layer<FixtureManager>
  readonly verifierLayer?: Layer.Layer<Verifier>
  readonly fixtures?: Record<string, Fixture>
  readonly checks?: Record<string, Check>
  readonly cancellation?: Deferred.Deferred<string>
  readonly fallbackVerdict?: { readonly status: "passed" | "failed" | "inconclusive" }
}

interface Wired {
  readonly run: Effect.Effect<RunResult, never>
  readonly runRoot: string
  readonly journal: Effect.Effect<ReadonlyArray<HarnessEvent>>
  readonly result: Effect.Effect<RunResult | undefined>
  readonly artifactLabels: Effect.Effect<ReadonlyArray<string>>
}

/** Builds a run over a temp directory without executing it, so a test can fork and interrupt it. */
const wire = (options: Wiring) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "harness-lifecycle-" }).pipe(Effect.orDie)
    const project = yield* expectSuccess(resolveConfig({
      source: "harness.config.ts",
      config: { outputDir: dir, ...options.configOverrides }
    }))
    const runRoot = `${dir}/${runId}`

    const run = runScenario({
      spec: options.spec,
      specPath: options.spec.specPath,
      config: project.config,
      registries: {
        fixtures: makeRegistry<Fixture>("fixture", options.fixtures ?? {}),
        checks: makeRegistry<Check>("check", options.checks ?? {})
      },
      runId,
      attemptId,
      harnessVersion: "0.1.0-test",
      dependencies: {},
      ...(options.cancellation === undefined ? {} : { cancellation: options.cancellation })
    }).pipe(
      Effect.provide(Layer.mergeAll(
        RunStore.layer({ runId, outputDir: dir }),
        fakeBrowser().layer,
        options.provider ?? scriptedProvider([]),
        options.verifierLayer ?? scriptedVerifier({}, options.fallbackVerdict ?? { status: "passed" }),
        options.fixtureLayer ?? fakeFixtures().layer
      )),
      Effect.provide(platform),
      Effect.scoped,
      Effect.orDie
    )

    const readJson = (path: string) =>
      fs.readFileString(path).pipe(
        Effect.map((text) => JSON.parse(text) as unknown),
        Effect.orElseSucceed(() => undefined)
      )

    return {
      run,
      runRoot,
      journal: readRunJournal(`${runRoot}/events.jsonl`).pipe(
        Effect.map((j) => j.events),
        Effect.orElseSucceed(() => [] as ReadonlyArray<HarnessEvent>)
      ),
      result: readJson(`${runRoot}/result.json`).pipe(Effect.map((v) => v as RunResult | undefined)),
      artifactLabels: readJson(`${runRoot}/artifacts.json`).pipe(
        Effect.map((v) => {
          const inventory = v as { artifacts?: ReadonlyArray<{ label?: string }> } | undefined
          return (inventory?.artifacts ?? []).map((a) => a.label ?? "")
        })
      )
    } satisfies Wired
  })

/** A provider whose call never returns, and which records whether its AbortSignal fired. */
const hangingProvider = (seen: { aborted: boolean; calls: number }) =>
  Layer.succeed(
    ModelProvider,
    ModelProvider.of({
      id: "hanging",
      modelId: "hang-v1",
      generate: (request) =>
        Effect.callback<never, ProviderError>(() => {
          seen.calls += 1
          request.signal?.addEventListener("abort", () => {
            seen.aborted = true
          })
        })
    })
  )

describe("cancellation and lifecycle", () => {
  // .recon/critic-runner-cancel.ts — before the fix: no result.json, no runFinished, and
  // `journal.finalized === false`, because `Effect.exit` does not catch interruption in v4.
  it.live("an interrupted run still writes result.json, journals runFinished and reports cancelled", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const seen = { aborted: false, calls: 0 }
      const wired = yield* wire({
        spec: loaded,
        provider: hangingProvider(seen),
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) }
      })

      const fiber = yield* Effect.forkChild(wired.run)
      yield* Effect.sleep("150 millis")
      const exit = yield* Effect.exit(Fiber.interrupt(fiber))
      expect(exit._tag).toBe("Success")

      const events = yield* wired.journal
      const types = events.map((e) => e.type)
      expect(types).toContain("cancellationRequested")
      expect(types).toContain("fixtureCleaned")
      // The tail runs to the very end: `runFinished` is the LAST event, nothing lands after it.
      expect(types[types.length - 1]).toBe("runFinished")

      const persisted = yield* wired.result
      expect(persisted?.status).toBe("cancelled")
      expect(persisted?.finalized).toBe(true)

      const journal = yield* readRunJournal(`${wired.runRoot}/events.jsonl`).pipe(Effect.orDie)
      expect(journal.finalized).toBe(true)
      // The in-flight model call was ABORTED, not abandoned.
      expect(seen.aborted).toBe(true)
    }).pipe(Effect.provide(platform), Effect.scoped))

  // .recon/critic-runner-coop.ts case A — before the fix: the cancel was honoured only when the
  // in-flight call returned (~2.9 s late for a 3 s call) and the request was never aborted.
  it.live("a cooperative cancellation aborts the in-flight model call instead of waiting for it", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const seen = { aborted: false, calls: 0 }
      const cancellation = yield* Deferred.make<string>()
      const wired = yield* wire({
        spec: loaded,
        provider: hangingProvider(seen),
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) },
        cancellation,
        // Far longer than the test takes: only the cancellation can end this run.
        configOverrides: { budgets: { operationTimeoutMs: 60_000, attemptTimeoutMs: 120_000 } }
      })

      const fiber = yield* Effect.forkChild(wired.run)
      yield* Effect.sleep("100 millis")
      yield* Deferred.succeed(cancellation, "user pressed the cancel button")
      const result = yield* Fiber.join(fiber).pipe(Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.die("the run did not honour the cancellation")
      }))

      expect(result.status).toBe("cancelled")
      if (result.status === "cancelled") expect(result.reason).toContain("cancel button")
      expect(seen.aborted).toBe(true)
      expect(seen.calls).toBe(1)
      const events = yield* wired.journal
      expect(events.some((e) => e.type === "cancellationRequested")).toBe(true)
      expect(events[events.length - 1]?.type).toBe("runFinished")
    }).pipe(Effect.provide(platform), Effect.scoped))

  // design-contracts §3: operationTimeoutMs is the per-operation bound. It was applied to
  // Playwright operations and to code checks, but never to a model call.
  it.live("a model call is bounded by budgets.operationTimeoutMs", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const seen = { aborted: false, calls: 0 }
      const wired = yield* wire({
        spec: loaded,
        provider: hangingProvider(seen),
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) },
        // attemptTimeoutMs is 100x the operation bound: only the per-operation bound can end this.
        configOverrides: { budgets: { operationTimeoutMs: 200, attemptTimeoutMs: 20_000 } }
      })

      const result = yield* wired.run.pipe(Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.die("the model call was not bounded by operationTimeoutMs")
      }))

      expect(result.status).toBe("error")
      if (result.status === "error") {
        expect(result.stage).toBe("agent-loop")
        expect(result.reason).toContain("per-operation timeout")
      }
      expect(seen.aborted).toBe(true)
    }).pipe(Effect.provide(platform), Effect.scoped))

  // The same bound applies to the evaluation call: `verifier.verify` was wrapped in `Effect.result`
  // and nothing else, so a wedged verifier consumed the whole attempt budget.
  it.live("a verification call is bounded by budgets.operationTimeoutMs and gets the signal", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      let sawSignal = false
      let aborted = false
      const wedgedVerifier = Layer.succeed(
        Verifier,
        Verifier.of({
          id: "wedged",
          verify: (request) =>
            Effect.callback<never, VerifierError>(() => {
              sawSignal = request.signal !== undefined
              request.signal?.addEventListener("abort", () => {
                aborted = true
              })
            })
        })
      )
      const wired = yield* wire({
        spec: loaded,
        provider: scriptedProvider([{ toolCalls: [{ name: "finish", params: {} }] }]),
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) },
        verifierLayer: wedgedVerifier,
        configOverrides: { budgets: { operationTimeoutMs: 200, attemptTimeoutMs: 20_000 } }
      })

      const result = yield* wired.run.pipe(Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.die("the verification call was not bounded by operationTimeoutMs")
      }))

      expect(sawSignal).toBe(true)
      expect(aborted).toBe(true)
      // Every criterion comes back `error` naming the bound; none is left `pending`.
      const criteria = result.attempts[0]?.criteria ?? []
      expect(criteria.length).toBeGreaterThan(0)
      for (const criterion of criteria) {
        expect(criterion.status).toBe("error")
        expect(criterion.observed).toContain("per-operation timeout")
      }
    }).pipe(Effect.provide(platform), Effect.scoped))

  // .recon/critic-runner-coop.ts case B — before the fix `recordEvidence` used `Effect.runPromise`,
  // a detached root fiber: `artifactAvailable` was journalled AFTER `runFinished` and
  // `artifacts.json` mutated after `result.json` had been written.
  it.live("a timed-out code check can no longer land evidence after the run is aggregated", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("coded-check.e2e.md"))
      let landed = 0
      const slowCheck: Check = async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 600))
        await ctx.recordEvidence({ label: "late-probe", data: { landed: "after the timeout" } })
        landed += 1
        return { status: "passed", expected: "e", observed: "o", evidence: [] }
      }
      const wired = yield* wire({
        spec: loaded,
        provider: scriptedProvider([{ toolCalls: [{ name: "finish", params: {} }] }]),
        checks: { "project-unique-in-storage": slowCheck },
        configOverrides: { budgets: { operationTimeoutMs: 150 } }
      })

      yield* wired.run
      // Long enough for the abandoned check to have reached its own `recordEvidence` call.
      yield* Effect.sleep("900 millis")

      expect(landed).toBe(0)
      expect(yield* wired.artifactLabels).not.toContain("late-probe")
      const events = yield* wired.journal
      const finishedAt = events.findIndex((e) => e.type === "runFinished")
      expect(finishedAt).toBeGreaterThanOrEqual(0)
      expect(events.slice(finishedAt + 1)).toEqual([])
    }).pipe(Effect.provide(platform), Effect.scoped))

  // The `idleTurns >= 3` loop terminator was hardcoded, unconfigurable and absent from `budgets`
  // and the manifest. It is now a declared blocking budget.
  it.live("maxIdleTurns is a declared blocking budget and resolves to inconclusive", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const wired = yield* wire({
        spec: loaded,
        // Every turn comes back with no tool call.
        provider: scriptedProvider([]),
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) },
        // The walkthrough never happened, so nothing settles the criteria.
        fallbackVerdict: { status: "inconclusive" },
        configOverrides: { budgets: { maxIdleTurns: 2 } }
      })

      const result = yield* wired.run
      expect(result.status).toBe("inconclusive")
      if (result.status === "inconclusive") expect(result.reason).toBe("budget-exhausted")

      const events = yield* wired.journal
      const exhausted = events.find((e) => e.type === "budgetExhausted")
      expect(exhausted).toMatchObject({ budget: "maxIdleTurns", limit: 2, used: 2 })
      // spec §7 sanctions EMITTING progressStalled; the budget is what ends the loop.
      expect(events.some((e) => e.type === "progressStalled")).toBe(true)

      const manifest = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(`${wired.runRoot}/manifest.json`)),
        Effect.map((text) => JSON.parse(text) as { config: { budgets: Record<string, number> } }),
        Effect.orDie
      )
      expect(manifest.config.budgets.maxIdleTurns).toBe(2)
    }).pipe(Effect.provide(platform), Effect.scoped))

  // .recon/critic-fixture-bounds.ts case A — before the fix a fixture setup that never returned
  // hung the run forever: attemptTimeoutMs only wraps the attempt body.
  it.live("fixture setup is bounded by budgets.fixtureSetupTimeoutMs", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const wired = yield* wire({
        spec: loaded,
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) },
        fixtureLayer: Layer.succeed(FixtureManager, FixtureManager.of({ setup: () => Effect.never })),
        configOverrides: { budgets: { fixtureSetupTimeoutMs: 250 } }
      })

      const result = yield* wired.run.pipe(Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.die("fixture setup was not bounded")
      }))

      // A blocking budget is `inconclusive`, never `error` (design-contracts §7).
      expect(result.status).toBe("inconclusive")
      if (result.status === "inconclusive") expect(result.reason).toBe("budget-exhausted")
      const events = yield* wired.journal
      expect(events.find((e) => e.type === "budgetExhausted")).toMatchObject({ budget: "fixtureSetupTimeout" })
      expect(events.some((e) => e.type === "browserContextOpened")).toBe(false)
      expect(events[events.length - 1]?.type).toBe("runFinished")
    }).pipe(Effect.provide(platform), Effect.scoped))

  // design-contracts §7, as amended: harness-initiated evidence capture for the FINAL evaluation is
  // exempt from "no late actions"; agent actions and model calls are not.
  it.live("after a budget is exhausted no action or model call runs, but the final capture may", () =>
    Effect.gen(function*() {
      const loaded = yield* expectSuccess(spec("project-create.e2e.md"))
      const wired = yield* wire({
        spec: loaded,
        provider: scriptedProvider([{ toolCalls: [{ name: "observe", params: {} }] }]),
        fixtures: { "authenticated-workspace": async () => ({ public: {} }) },
        configOverrides: { budgets: { maxModelCalls: 1 } }
      })

      const result = yield* wired.run
      expect(result.status).toBe("inconclusive")
      const events = yield* wired.journal
      const exhausted = events.findIndex((e) => e.type === "budgetExhausted")
      expect(exhausted).toBeGreaterThanOrEqual(0)
      const after = events.slice(exhausted + 1).map((e) => e.type)
      expect(after).not.toContain("actionStarted")
      expect(after).not.toContain("modelCallStarted")
      expect(after).toContain("artifactAvailable")
    }).pipe(Effect.provide(platform), Effect.scoped))

  // .recon/critic-pubsub3.ts — an SSE consumer parked in `PubSub.take` never received a
  // termination signal when the run ended, which is the documented SIGTERM hang.
  it.live("the events PubSub is shut down when the run's scope closes", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "harness-pubsub-" }).pipe(Effect.orDie)
      const events = yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* RunStore
          expect(yield* PubSub.isShutdown(store.events)).toBe(false)
          return store.events
        }).pipe(Effect.provide(RunStore.layer({ runId, outputDir: dir }).pipe(Layer.provide(platform))))
      )
      expect(yield* PubSub.isShutdown(events)).toBe(true)
      yield* PubSub.awaitShutdown(events).pipe(Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.die("a subscriber would still be parked on this PubSub")
      }))
    }).pipe(Effect.provide(platform), Effect.scoped))
})

/** Guards the schema addition rather than the behaviour: a new budget must survive a round trip. */
describe("budgets", () => {
  it.live("the new blocking budgets are part of the resolved configuration", () =>
    Effect.gen(function*() {
      const project = yield* expectSuccess(resolveConfig({
        source: "harness.config.ts",
        config: { budgets: { fixtureSetupTimeoutMs: 1_000, maxIdleTurns: 5, maxEvidenceRequests: 3 } }
      }))
      expect(project.config.budgets.fixtureSetupTimeoutMs).toBe(1_000)
      expect(project.config.budgets.maxIdleTurns).toBe(5)
      expect(project.config.budgets.maxEvidenceRequests).toBe(3)
      // Defaults are still applied for everything not overridden.
      expect(project.config.budgets.fixtureCleanupTimeoutMs).toBe(15_000)
      const encoded = Schema.encodeUnknownSync(Schema.Unknown)(project.config.budgets)
      expect(encoded).toBeDefined()
    }).pipe(Effect.provide(platform)))
})
