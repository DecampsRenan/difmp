import type {
  Criterion,
  CriterionDowngrade,
  CriterionResult,
  EvidenceItem,
  Evaluator,
} from "@difmp/core";
import type { CriterionVerdictShape } from "./verdict.js";

export interface VerdictValidation {
  readonly result: CriterionResult;
  /** References the evaluator produced that do not exist in this attempt's evidence. */
  readonly rejectedReferences: ReadonlyArray<string>;
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
 * `confidence` is carried through UNTOUCHED and read by nothing here. It is an observation about
 * the evaluator, recorded next to the verdict so the two can be compared after the fact; no rule
 * above consults it, and a high value never spares a verdict a single downgrade.
 *
 * Core's `enforceEvidenceIntegrity` applies the same rule once more against the run store's
 * inventory; the two are deliberately redundant.
 */
export const validateVerdict = (options: {
  readonly verdict: CriterionVerdictShape;
  readonly criterion: Criterion;
  readonly criterionHash: string;
  readonly evaluator: Evaluator;
  readonly evidence: ReadonlyArray<EvidenceItem>;
  readonly seq: number;
}): VerdictValidation => {
  const { criterion, evaluator, seq, verdict } = options;
  const known = new Set(options.evidence.map((item) => item.artifactId));
  const accepted = verdict.evidence.filter((id) => known.has(id));
  const rejected = verdict.evidence.filter((id) => !known.has(id));

  const limitations: Array<string> = [];
  if (verdict.limitations !== null && verdict.limitations !== "")
    limitations.push(verdict.limitations);

  let status: CriterionResult["status"] = verdict.status;
  // Every status the harness imposes is recorded, so a report can say WHY it refused to conclude
  // instead of showing a bare `inconclusive`.
  const downgrades: Array<CriterionDowngrade> = [];
  const downgrade = (reason: CriterionDowngrade["reason"], detail: string) => {
    if (status !== "inconclusive")
      downgrades.push({ reason, from: status, to: "inconclusive", detail });
    status = "inconclusive";
    limitations.push(detail);
  };

  if (verdict.criterionId !== criterion.id) {
    downgrade(
      "rejected-evidence",
      `the evaluator answered about ${verdict.criterionId} instead of ${criterion.id}; the verdict was rejected`,
    );
  }

  if (rejected.length > 0) {
    downgrade(
      "rejected-evidence",
      `evidence references do not exist in this attempt and were rejected: ${rejected.join(", ")}`,
    );
  }

  if (status === "passed" && accepted.length === 0) {
    downgrade(
      "rejected-evidence",
      "no usable evidence was attached, so the criterion cannot be considered verified",
    );
  }

  if (verdict.missingEvidence.length > 0) {
    if (status === "passed") {
      downgrade(
        "rejected-evidence",
        `evidence still missing: ${verdict.missingEvidence.join(", ")}`,
      );
    } else {
      limitations.push(`evidence still missing: ${verdict.missingEvidence.join(", ")}`);
    }
  }

  // spec §9: an absence observed after an uncertain navigation cannot establish a failure. The
  // runner re-derives the branch from what the driver reported; this is the cheap half of the
  // rule — an evaluator that reports its own uncertainty never gets to answer `failed`.
  if (verdict.absence === "uncertain-navigation" && status === "failed") {
    downgrade(
      "absence-uncertain-navigation",
      "the evaluator reported an absence after an uncertain navigation, which cannot establish a failure",
    );
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
    ...(verdict.confidence === null ? {} : { confidence: verdict.confidence }),
    evidence: accepted,
    ...(limitations.length === 0 ? {} : { limitations: limitations.join(" | ") }),
    ...(verdict.absence === null ? {} : { absence: verdict.absence }),
    ...(downgrades.length === 0 ? {} : { downgrades }),
    evaluatedAtSeq: seq,
  };
  return { result, rejectedReferences: rejected };
};
