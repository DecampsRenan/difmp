import type { CriterionResult } from "../domain/result.js"

export interface EvidenceCheck {
  readonly result: CriterionResult
  /** artifactIds that exist AND belong to this attempt. */
  readonly attemptArtifacts: ReadonlySet<string>
}

/**
 * Structural guard over what a verifier returned. Invented or foreign artifact references, and
 * a `passed` verdict with no evidence at all, are forced to `inconclusive` — never to `passed`.
 * This is a structural check: it says nothing about whether the semantic judgement is correct.
 */
export const enforceEvidenceIntegrity = (input: EvidenceCheck): CriterionResult => {
  const { attemptArtifacts, result } = input
  const unknown = result.evidence.filter((id) => !attemptArtifacts.has(id))
  const limitations: Array<string> = []
  if (result.limitations !== undefined) limitations.push(result.limitations)

  if (unknown.length > 0) {
    limitations.push(
      `evidence references do not exist in this attempt and were rejected: ${unknown.join(", ")}`
    )
    return {
      ...result,
      status: "inconclusive",
      evidence: result.evidence.filter((id) => attemptArtifacts.has(id)),
      limitations: limitations.join(" | ")
    }
  }

  if (result.status === "passed" && result.evidence.length === 0) {
    limitations.push("no evidence was attached, so the criterion cannot be considered verified")
    return { ...result, status: "inconclusive", limitations: limitations.join(" | ") }
  }

  return limitations.length === 0 ? result : { ...result, limitations: limitations.join(" | ") }
}
