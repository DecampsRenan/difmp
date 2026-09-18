import type { AttemptResult, CriterionResult, ReportInput } from "@difmp/core";
import { describe, expect, it } from "vitest";
import { renderHtmlReport } from "../src/html.js";
import { buildReportView } from "../src/view.js";
import { loadFixture } from "./fixtures.js";

/**
 * A criterion the harness refused to conclude must say WHICH rule refused, and a verdict the agent
 * tried to overturn must still be visible. A bare `inconclusive` is exactly the information the
 * reader is missing, so these are rendered as their own blocks, not folded into "limitations".
 */
const withVerdictHistory = (input: ReportInput): ReportInput => {
  const attempt = input.result.attempts[0]!;
  const [first, ...rest] = attempt.criteria;
  const patched: CriterionResult = {
    ...first!,
    status: "inconclusive",
    absence: "uncertain-navigation",
    downgrades: [
      {
        reason: "absence-uncertain-navigation",
        from: "failed",
        to: "inconclusive",
        detail:
          "navigation did not settle, so absence cannot be distinguished from a page that never rendered",
      },
      {
        reason: "evidence-persistence-failed",
        from: "passed",
        to: "inconclusive",
        detail:
          "mandatory evidence could not be persisted: checkpoint capture for c1 (art_9): disk full",
      },
    ],
    reChecks: [
      {
        status: "passed",
        observed: "this time the project is visible",
        evidence: ["art_2"],
        requestedBy: "agent",
        evaluatedAtSeq: 42,
        applied: false,
        note:
          "the criterion was already failed; a later agent evaluation reported passed and was kept " +
          "as an observation — asking again never upgrades a verdict",
      },
    ],
  };
  const attempts: ReadonlyArray<AttemptResult> = [
    { ...attempt, criteria: [patched, ...rest] } as AttemptResult,
    ...input.result.attempts.slice(1),
  ];
  return { ...input, result: { ...input.result, attempts } as ReportInput["result"] };
};

describe("the report explains why the harness refused to conclude", () => {
  const input = withVerdictHistory(loadFixture("inconclusive"));

  it("carries the downgrades and the later evaluations into the view", () => {
    const view = buildReportView(input);
    const criterion = view.criteria.find((c) => c.id === "c1")!;
    expect(criterion.downgrades.map((d) => d.reason)).toEqual([
      "absence-uncertain-navigation",
      "evidence-persistence-failed",
    ]);
    expect(criterion.reChecks).toHaveLength(1);
    const sources = view.diagnostics.map((d) => d.source);
    expect(sources).toContain("absence after uncertain navigation c1");
    expect(sources).toContain("mandatory evidence not persisted c1");
    expect(sources).toContain("re-check c1");
  });

  it("names the rule, the status it replaced and the reason in the HTML", () => {
    const html = renderHtmlReport(input);
    expect(html).toContain("Status imposed by the harness");
    expect(html).toContain("absence after uncertain navigation");
    expect(html).toContain("mandatory evidence not persisted");
    expect(html).toContain("Later evaluations of this criterion");
    expect(html).toContain("observation only");
    // The rejected upgrade is shown as what it was, not silently dropped.
    expect(html).toContain("this time the project is visible");
  });

  it("escapes a downgrade detail like every other piece of text", () => {
    const attempt = input.result.attempts[0]!;
    const criterion = attempt.criteria[0]!;
    const hostile: ReportInput = {
      ...input,
      result: {
        ...input.result,
        attempts: [
          {
            ...attempt,
            criteria: [
              {
                ...criterion,
                downgrades: [
                  {
                    reason: "rejected-evidence",
                    from: "passed",
                    to: "inconclusive",
                    detail: `<script>alert("xss")</script>`,
                  },
                ],
              },
              ...attempt.criteria.slice(1),
            ],
          } as AttemptResult,
        ],
      } as ReportInput["result"],
    };
    const html = renderHtmlReport(hostile);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

/**
 * A declared confidence is an observation about the evaluator, not a measurement of the verdict.
 * The report shows it with that caveat attached, precisely so nobody reads a confident verdict the
 * harness refused as a safer one.
 */
const withConfidence = (input: ReportInput, confidence: number): ReportInput => {
  const attempt = input.result.attempts[0]!;
  const [first, ...rest] = attempt.criteria;
  const attempts: ReadonlyArray<AttemptResult> = [
    { ...attempt, criteria: [{ ...first!, confidence }, ...rest] } as AttemptResult,
    ...input.result.attempts.slice(1),
  ];
  return { ...input, result: { ...input.result, attempts } as ReportInput["result"] };
};

describe("the declared confidence is reported as an observation", () => {
  it("shows the number and says no rule reads it", () => {
    const input = withConfidence(loadFixture("inconclusive"), 0.92);
    expect(buildReportView(input).criteria[0]!.confidence).toBe(0.92);

    const html = renderHtmlReport(input);
    expect(html).toContain("Confidence declared by the evaluator");
    expect(html).toContain("92 %");
    expect(html).toContain("no harness rule reads it");
  });

  it("says nothing at all when the evaluator declared nothing", () => {
    const html = renderHtmlReport(loadFixture("inconclusive"));
    expect(html).not.toContain("Confidence declared by the evaluator");
  });
});
