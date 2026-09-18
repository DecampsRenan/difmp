import { Effect, Schema } from "effect";

const positiveInt = (defaultValue: number) =>
  Schema.Int.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultValue)),
  );

export const defaultBudgets = {
  attemptTimeoutMs: 120_000,
  operationTimeoutMs: 15_000,
  maxModelCalls: 40,
  maxTokens: 200_000,
  verifierReserveTokens: 20_000,
  fixtureSetupTimeoutMs: 60_000,
  fixtureCleanupTimeoutMs: 15_000,
  maxIdleTurns: 3,
  maxEvidenceRequests: 1,
  modelCallRetries: 2,
} as const;

/**
 * The BLOCKING guard rails. Distinct from `maxActions`, which is indicative and lives on the
 * config/contract directly — see policy/actions.ts.
 */
export const Budgets = Schema.Struct({
  attemptTimeoutMs: positiveInt(defaultBudgets.attemptTimeoutMs),
  operationTimeoutMs: positiveInt(defaultBudgets.operationTimeoutMs),
  maxModelCalls: positiveInt(defaultBudgets.maxModelCalls),
  maxTokens: positiveInt(defaultBudgets.maxTokens),
  /**
   * A pool of `maxTokens` set aside for the final verification.
   *
   * Two rules, and they are not the same one: the browsing loop is refused a new model call once
   * the run has consumed `maxTokens - verifierReserveTokens`, AND the verifier may always spend up
   * to `verifierReserveTokens` of its own, whatever the browsing loop ended up consuming. The
   * second rule is what makes the reserve real: a budget is checked BEFORE a call and a turn's
   * cost is only known after it, so one oversized browsing turn can cross the first ceiling — it
   * still cannot take the final evaluation's tokens away. Consequence to know: when that happens
   * the run's total spend can exceed `maxTokens` by that overshoot plus the reserve.
   */
  verifierReserveTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultBudgets.verifierReserveTokens)),
  ),
  /**
   * Bounds EVERYTHING the fixture does before the browser opens. `attemptTimeoutMs` only wraps the
   * attempt body, so without this a fixture that never returns hangs the run with nothing to stop
   * it. Exhausting it ends the run as `inconclusive`, like any other blocking budget.
   */
  fixtureSetupTimeoutMs: positiveInt(defaultBudgets.fixtureSetupTimeoutMs),
  fixtureCleanupTimeoutMs: positiveInt(defaultBudgets.fixtureCleanupTimeoutMs),
  /**
   * How many consecutive model turns WITHOUT a tool call end the browsing loop. A model that keeps
   * narrating instead of acting is making no progress, and `progressStalled` alone would let it
   * spend the whole token budget saying so. Ending the loop yields `inconclusive` — never `failed`:
   * nothing about the product was established.
   */
  maxIdleTurns: positiveInt(defaultBudgets.maxIdleTurns),
  /**
   * How many times ONE criterion may come back as "needs more evidence" before the verifier stops
   * asking and settles for `inconclusive`. Without it a stubborn evaluator spends the whole budget
   * on a single criterion.
   */
  maxEvidenceRequests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultBudgets.maxEvidenceRequests)),
  ),
  /**
   * How many times ONE model call is retried when the provider reports the failure as RETRYABLE
   * (a 429 with `Retry-After`, a 5xx, a transport blip) before the call fails as before. Unlike
   * the blocking budgets above, exhausting it changes nothing on its own: the call simply ends
   * with the error that triggered the retries, exactly as it did before the retry existed — so
   * exhausting it emits no `budgetExhausted`. The retries are transport-level: they happen before
   * any tool has run and the logical call still counts once against `maxModelCalls`. Backoff is
   * 250 ms doubling, capped at 4 s, overridden by a provider-reported `retryAfterMs`.
   */
  modelCallRetries: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultBudgets.modelCallRetries)),
  ),
})
  .check(
    Schema.makeFilter((b) =>
      b.verifierReserveTokens < b.maxTokens
        ? undefined
        : [{ path: ["verifierReserveTokens"], issue: "must be smaller than maxTokens" }],
    ),
  )
  .annotate({ identifier: "Budgets" });

export type Budgets = (typeof Budgets)["Type"];
