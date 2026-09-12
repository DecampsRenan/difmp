import type { RunStage } from "../domain/errors.js";
import type { CriterionId } from "../domain/ids.js";
import type { CriterionResult, InconclusiveReason } from "../domain/result.js";

export interface AggregationInput {
  /** Explicit cancellation wins over everything else. */
  readonly cancellation?: { readonly reason: string };
  /** A blocking execution error, or a failure to persist mandatory evidence. */
  readonly executionError?: { readonly stage: RunStage; readonly reason: string };
  readonly criteria: ReadonlyArray<CriterionResult>;
  /** True when a BLOCKING budget ended the loop. Never true for `maxActions`. */
  readonly budgetExhausted?: boolean;
  readonly budgetDetail?: string;
}

export type AggregateOutcome =
  | { readonly status: "cancelled"; readonly reason: string }
  | { readonly status: "error"; readonly stage: RunStage; readonly reason: string }
  | { readonly status: "failed"; readonly failedCriteria: ReadonlyArray<CriterionId> }
  | {
      readonly status: "inconclusive";
      readonly reason: InconclusiveReason;
      readonly detail?: string;
    }
  | { readonly status: "passed" };

const unresolvedStatuses = new Set(["pending", "inconclusive", "error"]);

/**
 * The MVP aggregation policy, in EXACT order:
 * explicit cancellation -> `cancelled`; else blocking execution / evidence-persistence error ->
 * `error`; else any criterion `failed` -> `failed`; else any criterion unresolved ->
 * `inconclusive`; else `passed`.
 *
 * Individual criterion statuses are preserved by the caller even when the aggregate is `error`.
 */
export const aggregate = (input: AggregationInput): AggregateOutcome => {
  if (input.cancellation !== undefined) {
    return { status: "cancelled", reason: input.cancellation.reason };
  }
  if (input.executionError !== undefined) {
    return {
      status: "error",
      stage: input.executionError.stage,
      reason: input.executionError.reason,
    };
  }
  const failed = input.criteria.filter((c) => c.status === "failed").map((c) => c.criterionId);
  if (failed.length > 0) {
    return { status: "failed", failedCriteria: failed };
  }
  const unresolved = input.criteria.filter((c) => unresolvedStatuses.has(c.status));
  if (input.criteria.length === 0) {
    // Nothing was evaluated. If a blocking budget is what stopped us (a fixture setup that never
    // returned, say), say so — "no criterion was evaluated" alone hides the reason.
    return {
      status: "inconclusive",
      reason: input.budgetExhausted === true ? "budget-exhausted" : "unresolved-criteria",
      detail:
        input.budgetExhausted === true && input.budgetDetail !== undefined
          ? input.budgetDetail
          : "no criterion was evaluated",
    };
  }
  if (unresolved.length > 0) {
    const reason: InconclusiveReason =
      input.budgetExhausted === true
        ? "budget-exhausted"
        : unresolved.every((c) => c.status === "inconclusive")
          ? "insufficient-evidence"
          : "unresolved-criteria";
    const detail =
      input.budgetExhausted === true && input.budgetDetail !== undefined
        ? input.budgetDetail
        : `unresolved: ${unresolved.map((c) => `${c.criterionId} (${c.status})`).join(", ")}`;
    return { status: "inconclusive", reason, detail };
  }
  return { status: "passed" };
};
