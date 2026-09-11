import { Effect, Schema } from "effect"

const positiveInt = (defaultValue: number) =>
  Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultValue)))

export const defaultBudgets = {
  attemptTimeoutMs: 120_000,
  operationTimeoutMs: 15_000,
  maxModelCalls: 40,
  maxTokens: 200_000,
  verifierReserveTokens: 20_000,
  fixtureCleanupTimeoutMs: 15_000
} as const

/**
 * The BLOCKING guard rails. Distinct from `maxActions`, which is indicative and lives on the
 * config/contract directly — see policy/actions.ts.
 */
export const Budgets = Schema.Struct({
  attemptTimeoutMs: positiveInt(defaultBudgets.attemptTimeoutMs),
  operationTimeoutMs: positiveInt(defaultBudgets.operationTimeoutMs),
  maxModelCalls: positiveInt(defaultBudgets.maxModelCalls),
  maxTokens: positiveInt(defaultBudgets.maxTokens),
  /** Withheld from the browser loop so the final verification can always run. */
  verifierReserveTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultBudgets.verifierReserveTokens))
  ),
  fixtureCleanupTimeoutMs: positiveInt(defaultBudgets.fixtureCleanupTimeoutMs)
}).check(
  Schema.makeFilter((b) =>
    b.verifierReserveTokens < b.maxTokens
      ? undefined
      : [{ path: ["verifierReserveTokens"], issue: "must be smaller than maxTokens" }]
  )
).annotate({ identifier: "Budgets" })

export type Budgets = typeof Budgets["Type"]
