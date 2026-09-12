import type { CriterionVerdictShape } from "../verifier/verdict.js";

export type VerdictSpec = Partial<CriterionVerdictShape>;

/**
 * Canned evaluator answers for the deterministic verifier. Per criterion you may declare a single
 * answer or a sequence — a sequence is what lets a test go "needs evidence" first and conclude on
 * the second pass.
 */
export interface VerdictScript {
  readonly byCriterion?: Readonly<Record<string, VerdictSpec | ReadonlyArray<VerdictSpec>>>;
  readonly fallback?: VerdictSpec;
}

const defaults = (criterionId: string): CriterionVerdictShape => ({
  criterionId,
  status: "inconclusive",
  expected: "(scripted verifier: expectation not restated)",
  observed: "(scripted verifier: no observation supplied)",
  evidence: [],
  limitations: "scripted test double — this is not a model judgement",
  missingEvidence: [],
  evidenceHint: null,
  absence: null,
});

export const renderVerdict = (
  script: VerdictScript,
  criterionId: string,
  occurrence: number,
): CriterionVerdictShape => {
  const entry = script.byCriterion?.[criterionId];
  const spec = Array.isArray(entry)
    ? entry[Math.min(occurrence, entry.length - 1)]
    : (entry as VerdictSpec | undefined);
  const chosen = spec ?? script.fallback;
  return { ...defaults(criterionId), ...chosen, criterionId };
};
