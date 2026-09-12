import { BudgetExhaustedError } from "../domain/errors.js";
import type { Budgets } from "../domain/budgets.js";
import type { ModelRole } from "../domain/events.js";

export interface BudgetState {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Part of the totals above; tracked separately so the reserve can be reported. */
  readonly verifierTokens: number;
  readonly startedAtMs: number;
}

export const makeBudgetState = (startedAtMs: number): BudgetState => ({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  verifierTokens: 0,
  startedAtMs,
});

export const tokensUsed = (state: BudgetState): number => state.inputTokens + state.outputTokens;

/**
 * The browsing loop may not spend the verifier reserve; the verifier may spend everything.
 *
 * This is the SHARED ceiling. It is not the whole story for the verifier: see
 * `canStartModelCall`, where `verifierReserveTokens` is a pool of its own so that an oversized
 * browsing turn cannot take the final verification's tokens away from it.
 */
export const tokenCeiling = (budgets: Budgets, role: ModelRole): number =>
  role === "verifier" ? budgets.maxTokens : budgets.maxTokens - budgets.verifierReserveTokens;

/** Tokens the verifier may still spend: its own untouched reserve, or what is left of the shared pool. */
export const verifierTokensLeft = (budgets: Budgets, state: BudgetState): number =>
  Math.max(
    budgets.verifierReserveTokens - state.verifierTokens,
    budgets.maxTokens - tokensUsed(state),
  );

export type BudgetDecision =
  | { readonly _tag: "allow" }
  | { readonly _tag: "deny"; readonly error: BudgetExhaustedError };

const deny = (error: BudgetExhaustedError): BudgetDecision => ({ _tag: "deny", error });
const allow: BudgetDecision = { _tag: "allow" };

/** Checked before every model call. A denial ends the loop; it never marks a criterion failed. */
export const canStartModelCall = (options: {
  readonly budgets: Budgets;
  readonly state: BudgetState;
  readonly role: ModelRole;
  readonly nowMs: number;
}): BudgetDecision => {
  const { budgets, nowMs, role, state } = options;
  const elapsed = nowMs - state.startedAtMs;
  if (elapsed >= budgets.attemptTimeoutMs) {
    return deny(
      new BudgetExhaustedError({
        budget: "attemptTimeout",
        limit: budgets.attemptTimeoutMs,
        used: elapsed,
      }),
    );
  }
  if (state.modelCalls >= budgets.maxModelCalls) {
    return deny(
      new BudgetExhaustedError({
        budget: "maxModelCalls",
        limit: budgets.maxModelCalls,
        used: state.modelCalls,
      }),
    );
  }
  const used = tokensUsed(state);
  if (role === "browser") {
    const ceiling = tokenCeiling(budgets, "browser");
    if (used >= ceiling) {
      return deny(
        new BudgetExhaustedError({
          budget: "maxTokens",
          limit: ceiling,
          used,
          detail:
            `${budgets.verifierReserveTokens} tokens are reserved for the final verification and are ` +
            `not available to the browsing loop`,
        }),
      );
    }
    return allow;
  }
  // The reserve is a POOL, not a subtraction. A browsing turn's cost is only known once it has
  // run, so the loop can cross its ceiling by one oversized turn; if the reserve were merely
  // `maxTokens - used` the final verification would then be denied and the reserve would have
  // reserved nothing. The verifier therefore keeps `verifierReserveTokens` of its own whatever the
  // browsing loop consumed, which is what makes "the final evaluation can always run" true.
  if (verifierTokensLeft(budgets, state) <= 0) {
    return deny(
      new BudgetExhaustedError({
        budget: "maxTokens",
        limit: budgets.maxTokens,
        used,
        detail: `the verifier reserve (${budgets.verifierReserveTokens}) and the shared token budget are both exhausted`,
      }),
    );
  }
  return allow;
};

export const recordModelCall = (state: BudgetState): BudgetState => ({
  ...state,
  modelCalls: state.modelCalls + 1,
});

export const chargeTokens = (
  state: BudgetState,
  role: ModelRole,
  usage: { readonly inputTokens?: number; readonly outputTokens?: number },
): BudgetState => {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return {
    ...state,
    inputTokens: state.inputTokens + input,
    outputTokens: state.outputTokens + output,
    verifierTokens:
      role === "verifier" ? state.verifierTokens + input + output : state.verifierTokens,
  };
};

export interface BudgetRemaining {
  readonly modelCalls: number;
  readonly tokens: number;
  /** What the BROWSER loop may still spend (reserve withheld). */
  readonly browserTokens: number;
  /** What the VERIFIER may still spend: its own reserve survives a browsing overshoot. */
  readonly verifierTokens: number;
  readonly timeMs: number;
}

export const remaining = (
  budgets: Budgets,
  state: BudgetState,
  nowMs: number,
): BudgetRemaining => ({
  modelCalls: Math.max(0, budgets.maxModelCalls - state.modelCalls),
  tokens: Math.max(0, budgets.maxTokens - tokensUsed(state)),
  browserTokens: Math.max(0, tokenCeiling(budgets, "browser") - tokensUsed(state)),
  verifierTokens: Math.max(0, verifierTokensLeft(budgets, state)),
  timeMs: Math.max(0, budgets.attemptTimeoutMs - (nowMs - state.startedAtMs)),
});

/** Exhausting a blocking budget yields `inconclusive` — never `failed`. */
export const inconclusiveForBudget = (
  error: BudgetExhaustedError,
): { readonly reason: "budget-exhausted"; readonly detail: string } => ({
  reason: "budget-exhausted",
  detail: error.message,
});
