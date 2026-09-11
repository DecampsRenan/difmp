import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import {
  makeRegistry,
  parseSpec,
  readRunJournal,
  resolveConfig,
  RunStore,
  runScenario
} from "../src/index.js"
import type { Check, Fixture, HarnessEvent, LoadedSpec, ResolvedConfig, RunResult } from "../src/index.js"
import { fakeBrowser, fakeFixtures, scriptedProvider, scriptedVerifier } from "./fakes.js"
import type { ScriptedTurn, ScriptedVerdict } from "./fakes.js"
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
}

interface RunOutput {
  readonly result: RunResult
  readonly events: ReadonlyArray<HarnessEvent>
  readonly config: ResolvedConfig
  readonly fixtureCleanups: ReadonlyArray<string>
  readonly runRoot: string
}

const execute = (options: RunOptions) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "harness-runner-" }).pipe(Effect.orDie)
    const project = yield* expectSuccess(resolveConfig({
      source: "harness.config.ts",
      config: { outputDir: dir, ...options.configOverrides }
    }))
    const browser = fakeBrowser()
    const fixtures = fakeFixtures()

    const result = yield* runScenario({
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
        scriptedProvider(options.turns),
        scriptedVerifier(options.verdicts ?? {}, options.fallbackVerdict ?? { status: "passed" }),
        fixtures.layer
      )),
      Effect.orDie
    )

    const journal = yield* readRunJournal(`${dir}/${runId}/events.jsonl`).pipe(Effect.orDie)
    return {
      result,
      events: journal.events,
      config: project.config,
      fixtureCleanups: fixtures.cleanups,
      runRoot: `${dir}/${runId}`
    } satisfies RunOutput
  })

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
        expect(out.result.stage).toBe("fixture-setup")
        expect(out.result.reason).toContain("is not registered")
      }
    }).pipe(Effect.provide(platform)))
})
