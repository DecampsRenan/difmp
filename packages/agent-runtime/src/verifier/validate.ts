import type { Criterion, CriterionResult, EvidenceItem, Evaluator } from "@harness/core"
import type { CriterionVerdictShape } from "./verdict.js"

export interface VerdictValidation {
  readonly result: CriterionResult
  /** References the evaluator produced that do not exist in this attempt's evidence. */
  readonly rejectedReferences: ReadonlyArray<string>
}

/**
 * Harness-side validation of what the evaluator returned. Structure is already guaranteed by the
 * Schema decode; what is checked here is authority:
 *
 * - the verdict must be about the criterion we asked about;
 * - every `artifactId` must EXIST and belong to this attempt's evidence set;
 * - an invented or absent reference forces `inconclusive` — never `passed`;
 * - `passed` with no evidence at all is `inconclusive`;
 * - `expected` is always the FROZEN contract text, never the evaluator's restatement.
 *
 * Core's `enforceEvidenceIntegrity` applies the same rule once more against the run store's
 * inventory; the two are deliberately redundant.
 */
export const validateVerdict = (options: {
  readonly verdict: CriterionVerdictShape
  readonly criterion: Criterion
  readonly criterionHash: string
  readonly evaluator: Evaluator
  readonly evidence: ReadonlyArray<EvidenceItem>
  readonly seq: number
}): VerdictValidation => {
  const { criterion, evaluator, seq, verdict } = options
  const known = new Set(options.evidence.map((item) => item.artifactId))
  const accepted = verdict.evidence.filter((id) => known.has(id))
  const rejected = verdict.evidence.filter((id) => !known.has(id))

  const limitations: Array<string> = []
  if (verdict.limitations !== null && verdict.limitations !== "") limitations.push(verdict.limitations)

  let status: CriterionResult["status"] = verdict.status

  if (verdict.criterionId !== criterion.id) {
    status = "inconclusive"
    limitations.push(
      `the evaluator answered about ${verdict.criterionId} instead of ${criterion.id}; the verdict was rejected`
    )
  }

  if (rejected.length > 0) {
    status = "inconclusive"
    limitations.push(
      `evidence references do not exist in this attempt and were rejected: ${rejected.join(", ")}`
    )
  }

  if (status === "passed" && accepted.length === 0) {
    status = "inconclusive"
    limitations.push("no usable evidence was attached, so the criterion cannot be considered verified")
  }

  if (verdict.missingEvidence.length > 0) {
    limitations.push(`evidence still missing: ${verdict.missingEvidence.join(", ")}`)
    if (status === "passed") status = "inconclusive"
  }

  const result: CriterionResult = {
    criterionId: criterion.id,
    criterionHash: options.criterionHash,
    status,
    method: criterion.method,
    evaluator,
    // The frozen text, verbatim. The evaluator never gets to restate the expectation.
    expected: criterion.text,
    observed: verdict.observed,
    evidence: accepted,
    ...(limitations.length === 0 ? {} : { limitations: limitations.join(" | ") }),
    ...(verdict.absence === null ? {} : { absence: verdict.absence }),
    evaluatedAtSeq: seq
  }
  return { result, rejectedReferences: rejected }
}
