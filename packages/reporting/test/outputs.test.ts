import { decodeStrictSync, RunResult } from "@difmp/core";
import { describe, expect, it } from "vitest";
import { renderHtmlReport } from "../src/html.js";
import { renderJsonReport } from "../src/json.js";
import { renderJUnitReport } from "../src/junit.js";
import { buildReportView } from "../src/view.js";
import type { FixtureName } from "./fixtures.js";
import { fixtureNames, loadFixture } from "./fixtures.js";

const decodeResult = decodeStrictSync(RunResult);

describe.each(fixtureNames)("fixture %s", (name: FixtureName) => {
  const input = loadFixture(name);

  it("renders result.json that decodes back into core's RunResult", () => {
    const json = renderJsonReport(input);
    expect(decodeResult(JSON.parse(json))).toEqual(input.result);
  });

  it("keeps key order stable across renders", () => {
    const first = renderJsonReport(input);
    const keys = Object.keys(JSON.parse(first) as Record<string, unknown>);
    expect(keys).toEqual([...keys].toSorted());
    expect(renderJsonReport(input)).toBe(first);
  });

  it("never emits a skipped element in JUnit", () => {
    const xml = renderJUnitReport(input);
    expect(xml).not.toContain("<skipped");
    expect(xml).toContain('skipped="0"');
  });

  it("produces a standalone HTML document with no external reference", () => {
    const html = renderHtmlReport(input);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<(?:script|img|iframe|link|source)[^>]+(?:src|href)="https?:/);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/url\(\s*https?:/);
  });
});

describe("JUnit status mapping", () => {
  it("maps a product criterion failure to <failure> and keeps the real status in the message", () => {
    const xml = renderJUnitReport(loadFixture("failed-persistence"));
    expect(xml).toMatch(/<failure type="criterion-failed" message="status=failed/);
    expect(xml).toContain('failures="1"');
  });

  it("maps indeterminate criteria to <error>, never to a green skip", () => {
    const xml = renderJUnitReport(loadFixture("inconclusive"));
    expect(xml).toMatch(/<error type="criterion-inconclusive" message="status=inconclusive/);
    expect(xml).toMatch(/<error type="criterion-pending" message="status=pending/);
    expect(xml).toContain('failures="0"');
    expect(xml).toContain('errors="2"');
  });

  it("adds a run-level <error> for a technical error and documents the cancellation rule", () => {
    const xml = renderJUnitReport(loadFixture("error"));
    expect(xml).toMatch(/<error type="run-error"/);
    expect(xml).toContain("No &lt;skipped&gt; is ever emitted");
  });

  it("emits no failure and no error for a fully passed run", () => {
    const xml = renderJUnitReport(loadFixture("passed"));
    expect(xml).toContain('failures="0"');
    expect(xml).toContain('errors="0"');
    expect(xml).not.toContain("<failure");
    expect(xml).not.toContain("<error");
  });
});

describe("report view", () => {
  it("keeps the indicative action count out of the blocking budgets", () => {
    const view = buildReportView(loadFixture("failed-persistence"));
    const attempt = view.attempts[0]!;
    expect(attempt.actions.rendering).toBe("28 actions / 25 suggested");
    expect(attempt.actions.exceeded).toBe(true);
    expect(attempt.budgets.map((b) => b.key)).toEqual([
      "maxModelCalls",
      "maxTokens",
      "attemptTimeoutMs",
    ]);
    expect(attempt.budgets.some((b) => b.key.toLowerCase().includes("action"))).toBe(false);
  });

  it("reports budgets as consumed and remaining", () => {
    const view = buildReportView(loadFixture("inconclusive"));
    const budgets = view.attempts[0]!.budgets;
    expect(budgets.find((b) => b.key === "maxModelCalls")).toMatchObject({
      used: 6,
      limit: 6,
      remaining: 0,
    });
    expect(budgets.find((b) => b.key === "maxTokens")).toMatchObject({
      used: 32290,
      limit: 40000,
      remaining: 7710,
    });
  });

  it("preserves individual criterion statuses when the aggregate is error", () => {
    const view = buildReportView(loadFixture("error"));
    expect(view.status).toBe("error");
    expect(view.criteria.map((c) => [c.id, c.status])).toEqual([
      ["c1", "failed"],
      ["c2", "pending"],
    ]);
  });

  it("surfaces evidence references missing from the inventory", () => {
    const view = buildReportView(loadFixture("error"));
    expect(view.criteria[0]!.danglingEvidence).toEqual(["art_9"]);
    expect(view.diagnostics.some((d) => d.message.includes("art_9"))).toBe(true);
  });

  it("lists missing and failed artifacts with their reason", () => {
    const view = buildReportView(loadFixture("inconclusive"));
    const missing = view.artifacts.find((a) => a.artifactId === "art_3")!;
    expect(missing.state).toBe("missing");
    expect(missing.reason).toContain("timed out");
    expect(view.artifactCounts).toEqual({ present: 3, missing: 1, failed: 0 });
  });

  it("flags a run whose journal was never finalised", () => {
    expect(buildReportView(loadFixture("error")).finalized).toBe(false);
    expect(buildReportView(loadFixture("passed")).finalized).toBe(true);
  });

  it("marks a scripted double so it is never read as a real model judgement", () => {
    const view = buildReportView(loadFixture("failed-persistence"));
    expect(view.criteria[0]!.evaluatorKind).toBe("scripted-model");
    expect(view.criteria[0]!.evaluatorLabel).toContain("not a real model judgement");
  });

  it("records which branch of the absence rule produced a verdict", () => {
    expect(buildReportView(loadFixture("inconclusive")).criteria[0]!.absence).toBe(
      "uncertain-navigation",
    );
    expect(buildReportView(loadFixture("failed-persistence")).criteria[1]!.absence).toBe(
      "established-at-checkpoint",
    );
  });
});

describe("HTML escaping", () => {
  const html = renderHtmlReport(loadFixture("error"));

  it("escapes the hostile project name coming from the scenario", () => {
    expect(html).not.toContain(`<img src=x onerror="document.title='PWNED-NAME'">`);
    expect(html).toContain(
      "&lt;img src=x onerror=&quot;document.title=&#39;PWNED-NAME&#39;&quot;&gt;",
    );
  });

  it("escapes the hostile text coming from the model", () => {
    expect(html).not.toContain("<script>document.title='PWNED-MODEL'</script>");
    expect(html).toContain("document.title=&#39;PWNED-MODEL&#39;");
  });

  it("leaves exactly one script element, the inert JSON data island", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual([`<script type="application/json" id="harness-report-data">`]);
  });

  it("carries no inline event handler attribute", () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/);
  });
});

describe("cancellation", () => {
  const base = loadFixture("passed");
  const attempt = base.result.attempts[0]!;
  const cancelled = decodeResult({
    ...base.result,
    status: "cancelled",
    reason: "user interruption (SIGINT) during the agent loop",
    attempts: [
      {
        attemptId: attempt.attemptId,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        durationMs: attempt.durationMs,
        criteria: attempt.criteria.map((c) => ({
          ...c,
          status: "pending",
          observed: "",
          evidence: [],
        })),
        actions: attempt.actions,
        model: attempt.model,
        artifacts: attempt.artifacts,
        status: "cancelled",
        reason: "user interruption",
      },
    ],
  });
  const input = { ...base, result: cancelled };

  it("becomes a run-level <error>, never a skip", () => {
    const xml = renderJUnitReport(input);
    expect(xml).toMatch(/<error type="run-cancelled" message="status=cancelled/);
    expect(xml).not.toContain("<skipped");
    expect(xml).toContain("a cancellation is an &lt;error&gt; at run level");
  });

  it("keeps the unevaluated criteria as errors rather than passes", () => {
    const xml = renderJUnitReport(input);
    expect(xml).toContain('errors="3"');
    expect(xml).toContain('failures="0"');
  });
});

/**
 * A run that died before the contract was frozen (spec §6 step 3) has only the INITIAL manifest of
 * step 2. It must still produce a valid JUnit file and an HTML report: an infrastructure failure
 * that reports nothing is indistinguishable, in CI, from a suite that never ran.
 */
describe("run that failed before the contract was frozen", () => {
  const input = loadFixture("setup-failure");

  it("has no contract and an initial manifest", () => {
    expect(input.contract).toBeUndefined();
    expect(input.manifest.stage).toBe("initial");
    expect(input.manifest.hashes).toBeUndefined();
  });

  it("still emits a valid JUnit file carrying exactly one run-level error", () => {
    const xml = renderJUnitReport(input);
    expect(xml).toContain('tests="1"');
    expect(xml).toContain('errors="1"');
    expect(xml).toContain('failures="0"');
    expect(xml).not.toContain("<skipped");
    expect(xml).toMatch(/<error type="run-error"/);
    expect(xml).toContain("seed API refused the request");
    // The adapter is still attributed, from the initial manifest alone.
    expect(xml).toContain('<property name="harness.adapter" value="anthropic-messages"/>');
  });

  it("still renders an HTML report, and says the contract was never frozen", () => {
    const html = renderHtmlReport(input);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("never frozen");
  });

  it("falls back to the manifest for the budgets it can no longer read from a contract", () => {
    const view = buildReportView(input);
    expect(view.criteria).toEqual([]);
    expect(view.scenarioBody).toBe("");
    expect(view.attempts[0]!.budgets.find((b) => b.key === "maxTokens")!.limit).toBe(200_000);
    expect(view.diagnostics.some((d) => d.source === "contract")).toBe(true);
  });
});
