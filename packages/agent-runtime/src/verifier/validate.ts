import type { Criterion, CriterionResult, EvidenceItem, Evaluator } from "@difmp/core";
import { appendLimitation, recordDowngrade, screenProposal } from "@difmp/core";
import type { CriterionVerdictShape } from "./verdict.js";

/**
 * Authority checks over what the evaluator returned — the part ONLY the verifier can do, at the
 * moment the answer arrives:
 *
 * - the verdict must be about the criterion we asked about;
 * - `expected` is always the FROZEN contract text, never the evaluator's restatement;
 * - `missingEvidence` is either a refusal (`passed` cannot claim to still need proof) or a
 *   recorded limitation.
 *
 * The evidence law itself is not re-implemented here: the raw result — invented references
 * included — goes through `screenProposal`, core's first application of the adjudication, over
 * the evidence snapshot taken before the evaluation. Core's record pass re-applies the same
 * rules against the run store's inventory; the double enforcement is deliberate, and both
 * passes say WHY in the same strings.
 */
export const validateVerdict = (options: {
  readonly verdict: CriterionVerdictShape;
  readonly criterion: Criterion;
  readonly criterionHash: string;
  readonly evaluator: Evaluator;
  readonly evidence: ReadonlyArray<EvidenceItem>;
  readonly seq: number;
}): CriterionResult => {
  const { criterion, evaluator, seq, verdict } = options;
  const known = new Set(options.evidence.map((item) => item.artifactId));

  const limitations: Array<string> = [];
  if (verdict.limitations !== null && verdict.limitations !== "")
    limitations.push(verdict.limitations);

  let result: CriterionResult = {
    criterionId: criterion.id,
    criterionHash: options.criterionHash,
    status: verdict.status,
    method: criterion.method,
    evaluator,
    // The frozen text, verbatim. The evaluator never gets to restate the expectation.
    expected: criterion.text,
    observed: verdict.observed,
    // Cited-as-is: `screenProposal` strips what does not exist, and records that it did.
    evidence: verdict.evidence,
    ...(limitations.length === 0 ? {} : { limitations: limitations.join(" | ") }),
    ...(verdict.absence === null ? {} : { absence: verdict.absence }),
    evaluatedAtSeq: seq,
  };

  if (verdict.criterionId !== criterion.id) {
    result = recordDowngrade(result, {
      reason: "rejected-evidence",
      to: "inconclusive",
      detail: `the evaluator answered about ${verdict.criterionId} instead of ${criterion.id}; the verdict was rejected`,
    });
  }

  // Rejected/absent references and `passed` without usable Preuve — the shared rules, the shared
  // strings. The evaluator's own uncertainty claim is honoured here; re-deriving the absence
  // branch from driver facts belongs to the record pass, which holds those facts.
  result = screenProposal({ proposed: result, knownArtifacts: known });

  if (verdict.missingEvidence.length > 0) {
    const detail = `evidence still missing: ${verdict.missingEvidence.join(", ")}`;
    result =
      result.status === "passed"
        ? recordDowngrade(result, { reason: "rejected-evidence", to: "inconclusive", detail })
        : { ...result, limitations: appendLimitation(result, detail) };
  }

  return result;
};
