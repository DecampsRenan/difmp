import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { defaultBudgets, freezeContract, parseSpec, resolveConfig, systemPrompt } from "../src/index.js"
import { expectSuccess, platform, readFixture } from "./helpers.js"

const frozen = Effect.gen(function*() {
  const spec = yield* expectSuccess(parseSpec({
    specPath: "project-create.e2e.md",
    content: readFixture("project-create.e2e.md")
  }))
  const project = yield* expectSuccess(resolveConfig({
    source: "harness.config.ts",
    config: {
      baseUrl: "http://127.0.0.1:3000",
      budgets: { maxModelCalls: 12, maxTokens: 90_000, verifierReserveTokens: 9_000, attemptTimeoutMs: 90_000 }
    }
  }))
  return yield* expectSuccess(freezeContract({
    spec,
    specPath: "project-create.e2e.md",
    config: project.config,
    runId: "r_abcdefghijklm",
    attemptId: "a1",
    inputs: { projectName: "Projet démo" }
  }))
})

/**
 * spec.md §6 step 5: the agent is handed the scenario, the criteria, the tools, the indicative
 * action threshold AND the explicitly configured blocking budgets — with the distinction between
 * the two kinds of limit kept legible.
 */
describe("system prompt", () => {
  it.effect("states every configured blocking budget", () =>
    Effect.gen(function*() {
      const contract = yield* frozen
      const prompt = systemPrompt(contract, {
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins: ["http://127.0.0.1:3000"]
      })
      expect(prompt).toContain("Budgets bloquants")
      expect(prompt).toContain("90 s")
      expect(prompt).toContain("12")
      expect(prompt).toContain("90000")
      expect(prompt).toContain("9000")
      expect(prompt).toContain(`${defaultBudgets.operationTimeoutMs / 1000} s`)
    }).pipe(Effect.provide(platform)))

  it.effect("keeps the indicative threshold and the blocking budgets legibly apart", () =>
    Effect.gen(function*() {
      const contract = yield* frozen
      const prompt = systemPrompt(contract, {
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins: ["http://127.0.0.1:3000"]
      })
      const threshold = prompt.indexOf("Seuil indicatif d'actions")
      const budgets = prompt.indexOf("Budgets bloquants")
      expect(threshold).toBeGreaterThan(-1)
      expect(budgets).toBeGreaterThan(threshold)
      // The threshold says it stops nothing; the budgets say they stop the run.
      expect(prompt).toContain("le dépassement n'interrompt rien")
      expect(prompt).toContain("ARRÊTE le run")
      expect(prompt).toContain("`inconclusive`")
    }).pipe(Effect.provide(platform)))
})
