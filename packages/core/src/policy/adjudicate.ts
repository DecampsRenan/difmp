import type { CriterionResult } from "../domain/result.js";
import type { AbsenceInput } from "./absence.js";
import { enforceAbsenceRule } from "./absence.js";
import { enforceEvidenceIntegrity, enforceEvidencePersistence } from "./evidence.js";
import { admitVerdict } from "./verdict.js";
import type { VerdictAdmission, VerdictRequester } from "./verdict.js";

/**
 * The driver facts the absence rule needs. Whoever holds the browser session assembles them —
 * the law stays pure.
 */
export type AdjudicationFacts = AbsenceInput;

export interface AdjudicationInput {
  /** What the Évaluateur (or the code check) produced, BEFORE any rule is applied. */
  readonly proposed: CriterionResult;
  /** The verdict already recorded for this criterion, if any. */
  readonly current: CriterionResult | undefined;
  readonly requestedBy: VerdictRequester;
  /** This attempt's persisted inventory, RE-READ at the moment of judgement. */
  readonly attemptArtifacts: ReadonlySet<string>;
  readonly facts: AdjudicationFacts;
  /** Mandatory evidence for this criterion that the store could not persist, with its reason. */
  readonly persistenceFailures: ReadonlyArray<string>;
}

/**
 * The adjudication — the Harnais's single law between an Évaluateur's answer and a recorded
 * Verdict (ADR-0003). Four rules, in this order, applied to `model` AND `code` criteria alike:
 *
 *   1. every cited artifact must exist, belong to this attempt and have been persisted;
 *   2. an absence only establishes a failure at the checkpoint the criterion names;
 *   3. mandatory evidence that could not be saved forbids `passed`;
 *   4. a terminal verdict is not re-decided by the agent asking again — only made worse.
 *
 * The order is the law, not an implementation detail: rule 1 can demote a `passed` to
 * `inconclusive` before rule 3 ever sees it (a persistence failure then records a limitation
 * instead of a second downgrade), and rule 4 must receive an answer that has already survived
 * rules 1–3, or a rejected claim could become a recorded observation. The detail strings each
 * rule writes are defined with the rule itself, so a report says the same WHY whichever pass
 * caught the problem.
 */
export const adjudicate = (input: AdjudicationInput): VerdictAdmission => {
  const checked = enforceEvidenceIntegrity({
    result: input.proposed,
    attemptArtifacts: input.attemptArtifacts,
  });
  const withAbsence = enforceAbsenceRule({ result: checked, facts: input.facts });
  const persisted = enforceEvidencePersistence({
    result: withAbsence,
    failures: input.persistenceFailures,
  });
  return admitVerdict({
    current: input.current,
    incoming: persisted,
    requestedBy: input.requestedBy,
  });
};

/**
 * The first of the two application points — the screening pass, run by the verifier against the
 * evidence snapshot taken BEFORE the evaluation. The second is `adjudicate`, run by the runner
 * against the inventory RE-READ after (a code check mints its own probe evidence while it runs,
 * so the snapshot would reject the very artifact it just produced). The double enforcement is
 * deliberate: a bug in one pass cannot mint a false `passed`, because the other one decides.
 *
 * Screening applies the same code as the first two rules — the same primitives, the same
 * strings — over a smaller facts set: the verifier holds no driver facts, so only the
 * evaluator's own uncertainty claim (`absence: "uncertain-navigation"`) can be honoured here;
 * re-deriving an `established-at-checkpoint` claim belongs to the record pass.
 */
export const screenProposal = (input: {
  readonly proposed: CriterionResult;
  readonly knownArtifacts: ReadonlySet<string>;
}): CriterionResult => {
  const checked = enforceEvidenceIntegrity({
    result: input.proposed,
    attemptArtifacts: input.knownArtifacts,
  });
  return checked.absence === "uncertain-navigation"
    ? enforceAbsenceRule({
        result: checked,
        facts: { navigationSettled: false, checkpointReached: false },
      })
    : checked;
};
