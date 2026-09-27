import { describe, expect, it } from "vitest";
import { adjudicate, screenProposal } from "../src/index.js";
import type { AdjudicationInput, CriterionResult, CriterionStatus } from "../src/index.js";

const result = (
  status: CriterionStatus,
  overrides: Partial<CriterionResult> = {},
): CriterionResult => ({
  criterionId: "c1",
  criterionHash: "hash",
  status,
  method: "model",
  evaluator: { kind: "scripted-model" },
  expected: "the project appears",
  observed: "observed",
  evidence: ["art_1"],
  evaluatedAtSeq: 7,
  ...overrides,
});

const settled = { navigationSettled: true, checkpointReached: true };
const unsettled = { navigationSettled: false, checkpointReached: false };

/** The record pass, with every input at its calm default except what the test overrides. */
const record = (overrides: Partial<AdjudicationInput> = {}) =>
  adjudicate({
    proposed: result("passed"),
    current: undefined,
    requestedBy: "agent",
    attemptArtifacts: new Set(["art_1"]),
    facts: settled,
    persistenceFailures: [],
    ...overrides,
  });

describe("adjudicate — evidence integrity comes first and rejects invented Preuve", () => {
  it("rejects invented references and says so in a downgrade", () => {
    const admission = record({
      proposed: result("passed", { evidence: ["art_1", "art_404"] }),
    });
    expect(admission.result.status).toBe("inconclusive");
    expect(admission.result.evidence).toEqual(["art_1"]);
    expect(admission.result.downgrades![0]).toMatchObject({
      reason: "rejected-evidence",
      from: "passed",
      to: "inconclusive",
    });
  });

  it("refuses a `passed` with no usable evidence at all", () => {
    const admission = record({
      proposed: result("passed", { evidence: [] }),
      attemptArtifacts: new Set(),
    });
    expect(admission.result.status).toBe("inconclusive");
    expect(admission.result.downgrades).toHaveLength(1);
  });

  it("leaves a well-supported verdict untouched", () => {
    const admission = record();
    expect(admission.applied).toBe(true);
    expect(admission.result).toEqual(result("passed"));
  });
});

describe("adjudicate — the harness decides the absence branch, not the evaluator", () => {
  it("does nothing when the verdict is not about an absence", () => {
    const verdict = result("failed");
    const admission = record({ proposed: verdict, facts: unsettled });
    expect(admission.result).toEqual(verdict);
  });

  it("downgrades a failure the evaluator itself calls uncertain", () => {
    const admission = record({
      proposed: result("failed", { absence: "uncertain-navigation" }),
    });
    expect(admission.result.status).toBe("inconclusive");
    expect(admission.result.absence).toBe("uncertain-navigation");
    expect(admission.result.downgrades![0]!.reason).toBe("absence-uncertain-navigation");
    expect(admission.result.limitations).toContain("cannot establish a failure");
  });

  it("rejects a claimed checkpoint branch when the navigation never settled", () => {
    const admission = record({
      proposed: result("failed", { absence: "established-at-checkpoint" }),
      facts: { navigationSettled: false, checkpointReached: true },
    });
    expect(admission.result.status).toBe("inconclusive");
    expect(admission.result.absence).toBe("uncertain-navigation");
  });

  it("rejects it when the checkpoint the criterion names was never reached", () => {
    const admission = record({
      proposed: result("failed", { absence: "established-at-checkpoint" }),
      facts: { navigationSettled: true, checkpointReached: false },
    });
    expect(admission.result.status).toBe("inconclusive");
  });

  it("keeps a failure established at the checkpoint, and records that branch", () => {
    const admission = record({
      proposed: result("failed", { absence: "established-at-checkpoint" }),
    });
    expect(admission.result.status).toBe("failed");
    expect(admission.result.absence).toBe("established-at-checkpoint");
    expect(admission.result.downgrades).toBeUndefined();
  });

  it("never upgrades: a passed verdict that mentions an absence is left alone", () => {
    const admission = record({
      proposed: result("passed", { absence: "uncertain-navigation" }),
      facts: unsettled,
    });
    expect(admission.result.status).toBe("passed");
  });
});

describe("adjudicate — a mandatory Preuve that could not be saved forbids a silent success", () => {
  it("forbids `passed` when mandatory evidence could not be persisted", () => {
    const admission = record({
      persistenceFailures: ["checkpoint capture for c1 (art_3): disk full"],
    });
    expect(admission.result.status).toBe("inconclusive");
    expect(admission.result.downgrades![0]!.reason).toBe("evidence-persistence-failed");
    expect(admission.result.limitations).toContain("disk full");
  });

  it("does not rewrite a failure, but records the missing capture", () => {
    const admission = record({
      proposed: result("failed"),
      persistenceFailures: ["art_3: disk full"],
    });
    expect(admission.result.status).toBe("failed");
    expect(admission.result.downgrades).toBeUndefined();
    expect(admission.result.limitations).toContain("disk full");
  });
});

describe("adjudicate — asking again never upgrades a verdict", () => {
  it("keeps a `failed` when a later agent evaluation says `passed`, and keeps the later answer", () => {
    const admission = record({
      current: result("failed", { observed: "absent" }),
      proposed: result("passed", { observed: "present", evaluatedAtSeq: 11 }),
    });
    expect(admission.applied).toBe(false);
    expect(admission.result.status).toBe("failed");
    expect(admission.result.observed).toBe("absent");
    expect(admission.result.reChecks).toEqual([
      {
        status: "passed",
        observed: "present",
        evidence: ["art_1"],
        requestedBy: "agent",
        evaluatedAtSeq: 11,
        applied: false,
        note: expect.stringContaining("never upgrades") as unknown as string,
      },
    ]);
  });

  it("lets a later evaluation make a `passed` criterion worse", () => {
    const admission = record({
      current: result("passed"),
      proposed: result("failed", { observed: "disparu" }),
    });
    expect(admission.applied).toBe(true);
    expect(admission.result.status).toBe("failed");
    expect(admission.result.reChecks).toHaveLength(1);
    expect(admission.result.reChecks![0]!.applied).toBe(true);
  });

  it("treats `inconclusive` and `error` as not decided: they can still be settled", () => {
    for (const status of ["inconclusive", "error"] as const) {
      const admission = record({
        current: result(status),
        proposed: result("passed"),
      });
      expect(admission.applied).toBe(true);
      expect(admission.result.status).toBe("passed");
    }
  });

  it("accumulates several later evaluations instead of keeping only the last", () => {
    const first = record({
      current: result("failed"),
      proposed: result("passed", { evaluatedAtSeq: 9 }),
    });
    const second = record({
      current: first.result,
      proposed: result("passed", { evaluatedAtSeq: 12 }),
    });
    expect(second.result.status).toBe("failed");
    expect(second.result.reChecks!.map((r) => r.evaluatedAtSeq)).toEqual([9, 12]);
  });
});

describe("the order of the four rules is the law", () => {
  it("integrity runs before persistence: a rejected `passed` earns a limitation, not two downgrades", () => {
    const admission = record({
      proposed: result("passed", { evidence: ["art_404"] }),
      persistenceFailures: ["art_3: disk full"],
    });
    // Had persistence run first, its downgrade would lead; it must not even fire, because
    // integrity already took the criterion out of `passed`.
    expect(admission.result.downgrades!.map((d) => d.reason)).toEqual(["rejected-evidence"]);
    expect(admission.result.limitations).toContain("disk full");
  });

  it("integrity runs before absence: its refusal is the only downgrade the absence sees", () => {
    const admission = record({
      proposed: result("failed", {
        evidence: ["art_404"],
        absence: "uncertain-navigation",
      }),
      facts: unsettled,
    });
    // Integrity takes the criterion to `inconclusive` first, so the absence rule has no `failed`
    // left to downgrade. Absence-first would have recorded TWO downgrades, led by its own.
    expect(admission.result.downgrades!.map((d) => d.reason)).toEqual(["rejected-evidence"]);
    expect(admission.result.absence).toBe("uncertain-navigation");
  });

  it("admission is last: it only ever sees an answer rules 1-3 survived", () => {
    const admission = record({
      current: result("failed"),
      proposed: result("passed", { evidence: ["art_404"] }),
    });
    expect(admission.result.status).toBe("failed");
    // The observation records what the RULES decided (`inconclusive`), not what the agent asked.
    expect(admission.result.reChecks![0]!.status).toBe("inconclusive");
  });
});

const detail = (r: CriterionResult, index = 0) => r.downgrades![index]!.detail;

describe("one canonical message per DowngradeReason", () => {
  it("rejected-evidence: invented reference", () => {
    const admission = record({ proposed: result("passed", { evidence: ["art_404"] }) });
    expect(detail(admission.result)).toBe(
      "evidence references do not exist in this attempt and were rejected: art_404",
    );
  });

  it("rejected-evidence: no usable Preuve", () => {
    const admission = record({
      proposed: result("passed", { evidence: [] }),
      attemptArtifacts: new Set(),
    });
    expect(detail(admission.result)).toBe(
      "no usable evidence was attached, so the criterion cannot be considered verified",
    );
  });

  it("evidence-persistence-failed", () => {
    const admission = record({ persistenceFailures: ["art_3: disk full"] });
    expect(detail(admission.result)).toBe(
      "mandatory evidence could not be persisted: art_3: disk full",
    );
  });

  it("absence-uncertain-navigation: the rationale names the missing fact", () => {
    const noNavigation = record({
      proposed: result("failed", { absence: "established-at-checkpoint" }),
      facts: { navigationSettled: false, checkpointReached: true },
    });
    expect(detail(noNavigation.result)).toBe(
      "a missing locator cannot establish a failure here: navigation did not settle, so absence " +
        "cannot be distinguished from a page that never rendered",
    );
    const noCheckpoint = record({
      proposed: result("failed", { absence: "established-at-checkpoint" }),
      facts: { navigationSettled: true, checkpointReached: false },
    });
    expect(detail(noCheckpoint.result)).toBe(
      "a missing locator cannot establish a failure here: the checkpoint named by the criterion " +
        "was never reached, so absence proves nothing",
    );
  });
});

describe("screenProposal — the verifier's pass over the snapshot, same law same strings", () => {
  const known = new Set(["art_1"]);

  it("rejects invented references with the very detail the record pass writes", () => {
    const proposal = result("passed", { evidence: ["art_1", "art_404"] });
    const screened = screenProposal({ proposed: proposal, knownArtifacts: known });
    const recorded = record({ proposed: proposal }).result;
    expect(screened.status).toBe("inconclusive");
    expect(screened.evidence).toEqual(["art_1"]);
    expect(screened.downgrades![0]!.detail).toBe(recorded.downgrades![0]!.detail);
  });

  it("refuses a `passed` with no usable evidence", () => {
    const screened = screenProposal({
      proposed: result("passed", { evidence: [] }),
      knownArtifacts: new Set(),
    });
    expect(screened.status).toBe("inconclusive");
    expect(screened.downgrades![0]!.detail).toBe(
      "no usable evidence was attached, so the criterion cannot be considered verified",
    );
  });

  it("honours only the evaluator's own uncertainty claim — re-deriving needs driver facts", () => {
    const claimed = screenProposal({
      proposed: result("failed", { absence: "established-at-checkpoint" }),
      knownArtifacts: known,
    });
    // The screen pass cannot know whether the navigation settled; the record pass decides.
    expect(claimed.status).toBe("failed");
    const admitted = record({ proposed: claimed, facts: unsettled });
    expect(admitted.result.status).toBe("inconclusive");
  });

  it("a proposal the screen pass demoted never gains anything back at the record pass", () => {
    const proposal = result("passed", { evidence: ["art_404"] });
    const screened = screenProposal({ proposed: proposal, knownArtifacts: new Set(["art_1"]) });
    const final = record({ proposed: screened, attemptArtifacts: new Set(["art_1"]) });
    // Crossing the same artifact set twice must not duplicate the refusal: one downgrade, said once.
    expect(final.result.downgrades!.map((d) => d.reason)).toEqual(["rejected-evidence"]);
    expect(final.result.status).toBe("inconclusive");
  });
});
