import { BudgetExhaustedError } from "../domain/errors.js"
import type { Budgets } from "../domain/budgets.js"
import type { ModelRole } from "../domain/events.js"

export interface BudgetState {
  readonly modelCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** Part of the totals above; tracked separately so the reserve can be reported. */
  readonly verifierTokens: number
  readonly startedAtMs: number
}

export const makeBudgetState = (startedAtMs: number): BudgetState => ({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  verifierTokens: 0,
  startedAtMs
})

export const tokensUsed = (state: BudgetState): number => state.inputTokens + state.outputTokens

/** The browser loop may not spend the verifier reserve; the verifier may spend everything. */
export const tokenCeiling = (budgets: Budgets, role: ModelRole): number =>
  role === "verifier" ? budgets.maxTokens : budgets.maxTokens - budgets.verifierReserveTokens

export type BudgetDecision =
  | { readonly _tag: "allow" }
  | { readonly _tag: "deny"; readonly error: BudgetExhaustedError }

const deny = (error: BudgetExhaustedError): BudgetDecision => ({ _tag: "deny", error })
const allow: BudgetDecision = { _tag: "allow" }

/** Checked before every model call. A denial ends the loop; it never marks a criterion failed. */
export const canStartModelCall = (options: {
  readonly budgets: Budgets
  readonly state: BudgetState
  readonly role: ModelRole
  readonly nowMs: number
}): BudgetDecision => {
  const { budgets, nowMs, role, state } = options
  const elapsed = nowMs - state.startedAtMs
  if (elapsed >= budgets.attemptTimeoutMs) {
    return deny(
      new BudgetExhaustedError({ budget: "attemptTimeout", limit: budgets.attemptTimeoutMs, used: elapsed })
    )
  }
  if (state.modelCalls >= budgets.maxModelCalls) {
    return deny(
      new BudgetExhaustedError({ budget: "maxModelCalls", limit: budgets.maxModelCalls, used: state.modelCalls })
    )
  }
  const ceiling = tokenCeiling(budgets, role)
  const used = tokensUsed(state)
  if (used >= ceiling) {
    return deny(
      new BudgetExhaustedError({
        budget: "maxTokens",
        limit: ceiling,
        used,
        detail: role === "browser"
          ? `${budgets.verifierReserveTokens} tokens are withheld so the final verification can always run`
          : "token budget exhausted"
      })
    )
  }
  return allow
}

export const recordModelCall = (state: BudgetState): BudgetState => ({
  ...state,
  modelCalls: state.modelCalls + 1
})

export const chargeTokens = (
  state: BudgetState,
  role: ModelRole,
  usage: { readonly inputTokens?: number; readonly outputTokens?: number }
): BudgetState => {
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  return {
    ...state,
    inputTokens: state.inputTokens + input,
    outputTokens: state.outputTokens + output,
    verifierTokens: role === "verifier" ? state.verifierTokens + input + output : state.verifierTokens
  }
}

export interface BudgetRemaining {
  readonly modelCalls: number
  readonly tokens: number
  /** What the BROWSER loop may still spend (reserve withheld). */
  readonly browserTokens: number
  readonly timeMs: number
}

export const remaining = (budgets: Budgets, state: BudgetState, nowMs: number): BudgetRemaining => ({
  modelCalls: Math.max(0, budgets.maxModelCalls - state.modelCalls),
  tokens: Math.max(0, budgets.maxTokens - tokensUsed(state)),
  browserTokens: Math.max(0, tokenCeiling(budgets, "browser") - tokensUsed(state)),
  timeMs: Math.max(0, budgets.attemptTimeoutMs - (nowMs - state.startedAtMs))
})

/** Exhausting a blocking budget yields `inconclusive` — never `failed`. */
export const inconclusiveForBudget = (
  error: BudgetExhaustedError
): { readonly reason: "budget-exhausted"; readonly detail: string } => ({
  reason: "budget-exhausted",
  detail: error.message
})
