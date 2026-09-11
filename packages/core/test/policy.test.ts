import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  aggregate,
  canStartModelCall,
  chargeTokens,
  classifyAbsence,
  checkNavigationOrigin,
  defaultBudgets,
  enforceEvidenceIntegrity,
  guidanceExceeded,
  makeActionGuidance,
  makeBudgetState,
  recordAction,
  recordModelCall,
  tokenCeiling,
  tokensUsed,
  verifierTokensLeft,
  verifyCriterionBinding
} from "../src/index.js"
import type { Budgets, CriterionResult } from "../src/index.js"
import { expectFailure, expectSuccess, platform } from "./helpers.js"

const budgets: Budgets = { ...defaultBudgets, maxModelCalls: 2, maxTokens: 1000, verifierReserveTokens: 200 }

const criterion = (
  id: string,
  status: CriterionResult["status"],
  evidence: ReadonlyArray<string> = ["art_1"]
): CriterionResult => ({
  criterionId: id,
  criterionHash: "h",
  status,
  method: "model",
  evaluator: { kind: "scripted-model" },
  expected: "e",
  observed: "o",
  evidence: evidence as never,
  evaluatedAtSeq: 1
})

describe("maxActions guidance is indicative, never blocking", () => {
  it("emits the crossing notice exactly once and keeps counting", () => {
    let state = makeActionGuidance(25)
    const notices: Array<string> = []
    for (let i = 0; i < 40; i++) {
      const step = recordAction(state)
      state = step.state
      if (step.notice !== undefined) notices.push(step.notice.rendering)
    }
    expect(notices).toEqual(["26 actions / 25 indicatives"])
    expect(state.used).toBe(40)
    expect(guidanceExceeded(state)).toBe(true)
  })

  it("renders the threshold the way the spec asks for", () => {
    let state = makeActionGuidance(25)
    for (let i = 0; i < 28; i++) state = recordAction(state).state
    expect(recordAction({ ...state, notified: false }).notice?.rendering).toBe("29 actions / 25 indicatives")
  })

  it("a 40-action run is still `passed`: the counter never reaches the aggregation", () => {
    let state = makeActionGuidance(25)
    for (let i = 0; i < 40; i++) state = recordAction(state).state
    const verdict = aggregate({ criteria: [criterion("c1", "passed")] })
    expect(verdict.status).toBe("passed")
  })
})

describe("blocking budgets are separate and end the loop as inconclusive", () => {
  it("denies a model call once maxModelCalls is reached", () => {
    let state = makeBudgetState(0)
    expect(canStartModelCall({ budgets, state, role: "browser", nowMs: 0 })._tag).toBe("allow")
    state = recordModelCall(recordModelCall(state))
    const decision = canStartModelCall({ budgets, state, role: "browser", nowMs: 0 })
    expect(decision._tag).toBe("deny")
    if (decision._tag === "deny") expect(decision.error.budget).toBe("maxModelCalls")
  })

  it("withholds the verifier reserve from the browser loop only", () => {
    expect(tokenCeiling(budgets, "browser")).toBe(800)
    expect(tokenCeiling(budgets, "verifier")).toBe(1000)
    const state = chargeTokens(makeBudgetState(0), "browser", { inputTokens: 800, outputTokens: 0 })
    const browser = canStartModelCall({ budgets, state, role: "browser", nowMs: 0 })
    const verifier = canStartModelCall({ budgets, state, role: "verifier", nowMs: 0 })
    expect(browser._tag).toBe("deny")
    expect(verifier._tag).toBe("allow")
  })

  it("keeps the verifier reserve available after an oversized browsing turn overshot it", () => {
    // The gate runs BEFORE a call and a turn's cost is only known after it, so the browsing loop
    // can cross `maxTokens - verifierReserveTokens` by one turn. The reserve must survive that,
    // otherwise the final verification is denied and the reserve reserved nothing.
    const overshot = chargeTokens(makeBudgetState(0), "browser", { inputTokens: 1200, outputTokens: 0 })
    expect(tokensUsed(overshot)).toBeGreaterThan(budgets.maxTokens)
    expect(canStartModelCall({ budgets, state: overshot, role: "browser", nowMs: 0 })._tag).toBe("deny")
    expect(canStartModelCall({ budgets, state: overshot, role: "verifier", nowMs: 0 })._tag).toBe("allow")
    expect(verifierTokensLeft(budgets, overshot)).toBe(budgets.verifierReserveTokens)
  })

  it("denies the verifier once it has spent its own reserve and the shared budget too", () => {
    const spent = chargeTokens(
      chargeTokens(makeBudgetState(0), "browser", { inputTokens: 1200, outputTokens: 0 }),
      "verifier",
      { inputTokens: 200, outputTokens: 0 }
    )
    expect(verifierTokensLeft(budgets, spent)).toBe(0)
    const decision = canStartModelCall({ budgets, state: spent, role: "verifier", nowMs: 0 })
    expect(decision._tag).toBe("deny")
    if (decision._tag === "deny") expect(decision.error.budget).toBe("maxTokens")
  })

  it("denies once the attempt timeout has elapsed", () => {
    const decision = canStartModelCall({
      budgets,
      state: makeBudgetState(0),
      role: "browser",
      nowMs: budgets.attemptTimeoutMs
    })
    expect(decision._tag).toBe("deny")
    if (decision._tag === "deny") expect(decision.error.budget).toBe("attemptTimeout")
  })

  it("maps an exhausted budget to inconclusive, never to failed", () => {
    const verdict = aggregate({
      criteria: [criterion("c1", "passed"), criterion("c2", "pending")],
      budgetExhausted: true,
      budgetDetail: "maxTokens"
    })
    expect(verdict.status).toBe("inconclusive")
    if (verdict.status === "inconclusive") expect(verdict.reason).toBe("budget-exhausted")
  })
})

describe("aggregation order", () => {
  const failing = [criterion("c1", "failed"), criterion("c2", "pending")]

  it("cancellation wins over everything", () => {
    const verdict = aggregate({
      cancellation: { reason: "user" },
      executionError: { stage: "browser", reason: "boom" },
      criteria: failing
    })
    expect(verdict.status).toBe("cancelled")
  })

  it("a blocking execution error wins over a failed criterion", () => {
    const verdict = aggregate({ executionError: { stage: "evidence", reason: "disk full" }, criteria: failing })
    expect(verdict.status).toBe("error")
  })

  it("a failed criterion wins over an unresolved one", () => {
    const verdict = aggregate({ criteria: failing })
    expect(verdict.status).toBe("failed")
    if (verdict.status === "failed") expect(verdict.failedCriteria).toEqual(["c1"])
  })

  it("an unresolved criterion forbids `passed`", () => {
    const verdict = aggregate({ criteria: [criterion("c1", "passed"), criterion("c2", "pending")] })
    expect(verdict.status).toBe("inconclusive")
    if (verdict.status === "inconclusive") expect(verdict.reason).toBe("unresolved-criteria")
  })

  it("only all-resolved, none-failed yields `passed`", () => {
    expect(aggregate({ criteria: [criterion("c1", "passed")] }).status).toBe("passed")
  })

  it("no criterion at all is inconclusive, never a silent success", () => {
    expect(aggregate({ criteria: [] }).status).toBe("inconclusive")
  })
})

describe("evidence integrity", () => {
  const known = new Set(["art_1", "art_2"])

  it("forces inconclusive when a reference does not belong to the attempt", () => {
    const guarded = enforceEvidenceIntegrity({
      result: { ...criterion("c1", "passed", ["art_1", "art_99"]) },
      attemptArtifacts: known
    })
    expect(guarded.status).toBe("inconclusive")
    expect(guarded.evidence).toEqual(["art_1"])
    expect(guarded.limitations).toContain("art_99")
  })

  it("never lets a `passed` verdict stand without any evidence", () => {
    const guarded = enforceEvidenceIntegrity({
      result: criterion("c1", "passed", []),
      attemptArtifacts: known
    })
    expect(guarded.status).toBe("inconclusive")
  })

  it("leaves a well-evidenced verdict alone", () => {
    const result = criterion("c1", "passed", ["art_2"])
    expect(enforceEvidenceIntegrity({ result, attemptArtifacts: known })).toEqual(result)
  })
})

describe("absence rule", () => {
  it("records `failed` only for an absence established at the checkpoint", () => {
    const established = classifyAbsence({ navigationSettled: true, checkpointReached: true })
    expect(established.status).toBe("failed")
    expect(established.branch).toBe("established-at-checkpoint")
  })

  it("records `inconclusive` after uncertain navigation", () => {
    const uncertain = classifyAbsence({ navigationSettled: false, checkpointReached: true })
    expect(uncertain.status).toBe("inconclusive")
    expect(uncertain.branch).toBe("uncertain-navigation")
    const noCheckpoint = classifyAbsence({ navigationSettled: true, checkpointReached: false })
    expect(noCheckpoint.status).toBe("inconclusive")
    expect(noCheckpoint.branch).toBe("uncertain-navigation")
  })
})

describe("navigation origin allow-list", () => {
  const allowed = ["http://127.0.0.1:3000"]

  it.effect("accepts an allowed origin and rejects everything else", () =>
    Effect.gen(function*() {
      expect(yield* expectSuccess(checkNavigationOrigin("http://127.0.0.1:3000/app", allowed)))
        .toBe("http://127.0.0.1:3000/app")
      const foreign = yield* expectFailure(checkNavigationOrigin("https://evil.example/x", allowed))
      expect(foreign.rule).toBe("allowed-origins")
      const scheme = yield* expectFailure(checkNavigationOrigin("javascript:alert(1)", allowed))
      expect(scheme.reason).toContain("scheme")
      const relative = yield* expectFailure(checkNavigationOrigin("/app", allowed))
      expect(relative.reason).toContain("not an absolute URL")
    }))
})

describe("criterion hash binding", () => {
  it.effect("rejects a check bound to a criterion whose text changed", () =>
    Effect.gen(function*() {
      const text = "Le projet reste présent après rechargement."
      const hash = "0".repeat(64)
      const error = yield* expectFailure(verifyCriterionBinding({
        checkName: "project-unique-in-storage",
        criterionId: "c3",
        text,
        contractHash: hash
      }))
      expect(error.message).toContain("no longer matches the frozen contract")
    }).pipe(Effect.provide(platform)))
})
