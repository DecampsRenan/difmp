import type { AbsenceBranch } from "../domain/result.js"

export interface AbsenceInput {
  /** Did the navigation that preceded the observation actually settle? */
  readonly navigationSettled: boolean
  /** Was the checkpoint the criterion names reached (page loaded, list rendered, settled)? */
  readonly checkpointReached: boolean
}

export interface AbsenceOutcome {
  readonly status: "failed" | "inconclusive"
  readonly branch: AbsenceBranch
  readonly rationale: string
}

/**
 * A missing locator means two very different things. This distinction is explicit, and the
 * branch taken is recorded on the `CriterionResult` so a report can show which one applied.
 */
export const classifyAbsence = (input: AbsenceInput): AbsenceOutcome =>
  input.navigationSettled && input.checkpointReached
    ? {
      status: "failed",
      branch: "established-at-checkpoint",
      rationale: "the element was absent at the checkpoint the criterion names, on a settled page"
    }
    : {
      status: "inconclusive",
      branch: "uncertain-navigation",
      rationale: input.navigationSettled
        ? "the checkpoint named by the criterion was never reached, so absence proves nothing"
        : "navigation did not settle, so absence cannot be distinguished from a page that never rendered"
    }
