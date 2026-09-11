import type { AbsenceBranch, CriterionResult } from "../domain/result.js"
import { recordDowngrade } from "./evidence.js"

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

/**
 * spec §9 / design-contracts §8, wired into the run rather than left to the evaluator.
 *
 * The evaluator's `absence` field is a CLAIM, not a decision: a model that declares an element
 * missing after a navigation that never settled would otherwise turn "I could not see it" into a
 * product failure. The harness re-derives the branch from what the driver actually reported —
 * whether the last navigation settled, and whether the checkpoint the criterion names was observed
 * — and an evaluator that reports uncertainty itself can never obtain the established branch.
 *
 * The branch taken is recorded on the result; only a `failed` resting on an uncertain absence is
 * downgraded, and the downgrade says why.
 */
export const enforceAbsenceRule = (input: {
  readonly result: CriterionResult
  readonly facts: AbsenceInput
}): CriterionResult => {
  const claimed = input.result.absence
  if (claimed === undefined) return input.result
  const facts: AbsenceInput = claimed === "uncertain-navigation"
    ? { navigationSettled: false, checkpointReached: false }
    : input.facts
  const outcome = classifyAbsence(facts)
  const result: CriterionResult = { ...input.result, absence: outcome.branch }
  if (outcome.status === "failed" || result.status !== "failed") return result
  return recordDowngrade(result, {
    reason: "absence-uncertain-navigation",
    to: "inconclusive",
    detail: `a missing locator cannot establish a failure here: ${outcome.rationale}`
  })
}
