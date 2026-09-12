import type { CriterionReCheck, CriterionResult, CriterionStatus } from "../domain/result.js";

export type VerdictRequester = "agent" | "runner";

/**
 * How strong a claim a status makes about the product. A later evaluation may only move a criterion
 * UP this scale: `passed` is the weakest claim (everything was fine), `failed` the strongest.
 */
const severity: Record<CriterionStatus, number> = {
  pending: -1,
  passed: 0,
  inconclusive: 1,
  error: 2,
  failed: 3,
};

/** `passed` and `failed` are decisions; `inconclusive` and `error` are "not settled yet". */
export const isTerminal = (status: CriterionStatus): boolean =>
  status === "passed" || status === "failed";

export interface VerdictAdmission {
  /** The result to store for this criterion. */
  readonly result: CriterionResult;
  /** True when the incoming evaluation replaced the recorded verdict. */
  readonly applied: boolean;
  /** Human-readable rule that was applied — journalled with the verification event. */
  readonly note: string;
}

/**
 * spec §9 — "Do not lose this information".
 *
 * The browser agent may call `check` on the same criterion as often as it likes, and nothing stops
 * it from calling it again after a `failed`. Letting the last answer win would give an adversarial
 * (or merely persistent) agent a retry-until-green path, and `result.json` would show a clean pass
 * while the product failure survived only in `events.jsonl`.
 *
 * The rule: a criterion that has reached a TERMINAL verdict is not re-decided by the agent. Any
 * later evaluation is kept as an additional observation on the criterion, and it replaces the
 * recorded status only when it is strictly WORSE — so a real regression observed later is never
 * hidden, and a `failed` can never become `passed` because the agent asked again.
 *
 * `inconclusive` and `error` are not decisions: re-evaluating them (the agent captured the evidence
 * the verifier asked for) replaces them normally, in either direction.
 */
export const admitVerdict = (input: {
  readonly current: CriterionResult | undefined;
  readonly incoming: CriterionResult;
  readonly requestedBy: VerdictRequester;
}): VerdictAdmission => {
  const { current, incoming, requestedBy } = input;
  if (current === undefined || !isTerminal(current.status)) {
    return { result: incoming, applied: true, note: "first verdict recorded for this criterion" };
  }

  const worse = severity[incoming.status] > severity[current.status];
  const note = worse
    ? `a later ${requestedBy} evaluation reported ${incoming.status}, which is worse than the recorded ` +
      `${current.status}: the recorded verdict was replaced, never upgraded`
    : `the criterion was already ${current.status}; a later ${requestedBy} evaluation reported ` +
      `${incoming.status} and was kept as an observation — asking again never upgrades a verdict`;

  const entry: CriterionReCheck = {
    status: incoming.status,
    observed: incoming.observed,
    evidence: incoming.evidence,
    requestedBy,
    evaluatedAtSeq: incoming.evaluatedAtSeq,
    applied: worse,
    note,
  };
  const history: ReadonlyArray<CriterionReCheck> = [...(current.reChecks ?? []), entry];

  if (!worse) {
    return { result: { ...current, reChecks: history }, applied: false, note };
  }
  return {
    result: {
      ...incoming,
      // The earlier verdict and every later observation stay attached to the criterion.
      reChecks: history,
      ...(current.downgrades === undefined && incoming.downgrades === undefined
        ? {}
        : { downgrades: [...(current.downgrades ?? []), ...(incoming.downgrades ?? [])] }),
    },
    applied: true,
    note,
  };
};
