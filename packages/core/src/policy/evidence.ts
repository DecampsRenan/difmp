import type { CriterionDowngrade, CriterionResult, CriterionStatus, DowngradeReason } from "../domain/result.js"

export interface EvidenceCheck {
  readonly result: CriterionResult
  /** artifactIds that exist, belong to this attempt AND were actually persisted. */
  readonly attemptArtifacts: ReadonlySet<string>
}

const appendLimitation = (result: CriterionResult, message: string): string =>
  result.limitations === undefined || result.limitations === ""
    ? message
    : `${result.limitations} | ${message}`

/**
 * Impose a status the evaluator did not ask for, and RECORD why. A report showing `inconclusive`
 * must be able to say which rule refused to conclude — silently rewriting the status would hide
 * exactly the information the reader needs.
 */
export const recordDowngrade = (
  result: CriterionResult,
  input: { readonly reason: DowngradeReason; readonly to: CriterionStatus; readonly detail: string }
): CriterionResult => {
  const downgrade: CriterionDowngrade = {
    reason: input.reason,
    from: result.status,
    to: input.to,
    detail: input.detail
  }
  return {
    ...result,
    status: input.to,
    limitations: appendLimitation(result, input.detail),
    downgrades: [...(result.downgrades ?? []), downgrade]
  }
}

/**
 * Structural guard over what an evaluator returned — applied to BOTH `method: "model"` and
 * `method: "code"` criteria, because a TS check lives in a separate package and is no more
 * trusted than a model. Invented, foreign or unpersisted artifact references, and a `passed`
 * verdict with no evidence at all, are forced to `inconclusive` — never to `passed`.
 * This is a structural check: it says nothing about whether the semantic judgement is correct.
 */
export const enforceEvidenceIntegrity = (input: EvidenceCheck): CriterionResult => {
  const { attemptArtifacts, result } = input
  const unknown = result.evidence.filter((id) => !attemptArtifacts.has(id))

  if (unknown.length > 0) {
    return recordDowngrade(
      { ...result, evidence: result.evidence.filter((id) => attemptArtifacts.has(id)) },
      {
        reason: "rejected-evidence",
        to: "inconclusive",
        detail: `evidence references do not exist in this attempt and were rejected: ${unknown.join(", ")}`
      }
    )
  }

  if (result.status === "passed" && result.evidence.length === 0) {
    return recordDowngrade(result, {
      reason: "rejected-evidence",
      to: "inconclusive",
      detail: "no evidence was attached, so the criterion cannot be considered verified"
    })
  }

  return result
}

export interface EvidencePersistenceCheck {
  readonly result: CriterionResult
  /** Mandatory evidence for THIS criterion that the store could not persist, with its reason. */
  readonly failures: ReadonlyArray<string>
}

/**
 * spec §13: "a failure to save mandatory evidence must prevent a silent success".
 *
 * Mandatory evidence is the evidence the harness itself requires in order to conclude a criterion:
 * the checkpoint capture taken when the criterion is evaluated (unless captures are disabled), and
 * the payload a TS check journals through `recordEvidence`. When one of those could not be written,
 * the criterion cannot be `passed` — a pass nobody can audit is exactly the silent success the spec
 * forbids. A `failed` verdict is NOT rewritten: an observation that contradicts the expectation
 * stands on its own, and the missing capture is recorded as a limitation.
 */
export const enforceEvidencePersistence = (input: EvidencePersistenceCheck): CriterionResult => {
  const { failures, result } = input
  if (failures.length === 0) return result
  const detail = `mandatory evidence could not be persisted: ${failures.join("; ")}`
  if (result.status !== "passed") {
    return { ...result, limitations: appendLimitation(result, detail) }
  }
  return recordDowngrade(result, { reason: "evidence-persistence-failed", to: "inconclusive", detail })
}
