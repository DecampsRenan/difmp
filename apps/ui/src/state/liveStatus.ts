import type { CriterionStatus, RunStatus } from "../types/events.js";
import type { CriterionView } from "../state/model.js";

/**
 * Operator-facing statuses for the simplified live view. Domain literals from the harness are
 * mapped here so the left panel stays a short, greppable vocabulary.
 */
export type LiveStatus = "not tested" | "in progress" | "failed" | "need details" | "passed";

export type RunOrSuiteStatus = "pending" | "running" | RunStatus;

/** Scenario / file-level mapping. */
export const liveStatusFromRun = (status: RunOrSuiteStatus | string): LiveStatus => {
  switch (status) {
    case "pending":
      return "not tested";
    case "running":
      return "in progress";
    case "passed":
      return "passed";
    case "failed":
    case "error":
      return "failed";
    case "inconclusive":
    case "cancelled":
      return "need details";
    default:
      return "not tested";
  }
};

/**
 * Criterion / assertion-level mapping.
 *
 * - `pending` → not tested
 * - `pending` + evidence already requested → in progress (check running)
 * - `inconclusive` (incl. unresolved `needsEvidence` / unfinished evidence) → need details
 * - `failed` / `error` → failed
 * - `passed` → passed
 */
export const liveStatusFromCriterion = (
  criterion: Pick<CriterionView, "status" | "evidenceRequested">,
): LiveStatus => {
  const status = criterion.status as CriterionStatus | string;
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
    case "error":
      return "failed";
    case "inconclusive":
      return "need details";
    case "pending":
      return criterion.evidenceRequested ? "in progress" : "not tested";
    default:
      return "not tested";
  }
};

export const liveStatusTone = (status: LiveStatus): string => {
  switch (status) {
    case "passed":
      return "ok";
    case "failed":
      return "bad";
    case "need details":
      return "warn";
    case "in progress":
      return "info";
    case "not tested":
      return "neutral";
  }
};
