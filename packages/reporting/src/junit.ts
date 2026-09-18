import type { ReportInput } from "@difmp/core";
import { escapeXml } from "./escape.js";
import type { CriterionView, ReportView } from "./view.js";
import { buildReportView } from "./view.js";

/**
 * design-contracts §12: product criterion failures are `<failure>`; technical errors AND
 * indeterminate results are `<error>` with the real status preserved in the message;
 * cancellations are `<error>` too. `skipped` is NEVER emitted — a green skip would turn an
 * unresolved verdict into a pass in every CI dashboard that reads this file.
 */
const CANCELLATION_NOTE =
  "JUnit convention of the harness: a `failed` criterion is a <failure> (the product contradicts " +
  "the expectation); `inconclusive`, `pending` and `error` are <error> (indeterminate or technical); " +
  "a cancellation is an <error> at run level. No <skipped> is ever emitted: an indeterminate " +
  "result must never show up green.";

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const seconds = (ms: number): string => (ms / 1000).toFixed(3);

const attr = (name: string, value: string | number): string =>
  `${name}="${escapeXml(String(value))}"`;

interface CaseOutcome {
  readonly tag: "failure" | "error" | undefined;
  readonly type: string;
  readonly message: string;
}

const outcomeFor = (criterion: CriterionView): CaseOutcome => {
  switch (criterion.status) {
    case "passed":
      return { tag: undefined, type: "", message: "" };
    case "failed":
      return {
        tag: "failure",
        type: "criterion-failed",
        message: `status=failed — ${oneLine(criterion.observed ?? "no observation recorded")}`,
      };
    case "inconclusive":
      return {
        tag: "error",
        type: "criterion-inconclusive",
        message: `status=inconclusive (indeterminate result, not a success) — ${oneLine(
          criterion.observed ?? criterion.limitations ?? "insufficient evidence",
        )}`,
      };
    case "pending":
      return {
        tag: "error",
        type: "criterion-pending",
        message: "status=pending — the criterion was never evaluated",
      };
    case "error":
      return {
        tag: "error",
        type: "criterion-error",
        message: `status=error — ${oneLine(criterion.observed ?? "technical error during the evaluation")}`,
      };
  }
};

const caseBody = (criterion: CriterionView): string =>
  [
    `criterion: ${criterion.id}`,
    `actual status: ${criterion.status}`,
    `method: ${criterion.method}`,
    `evaluator: ${criterion.evaluatorLabel}`,
    criterion.probabilistic
      ? "warning: probabilistic textual evaluation, this is not a deterministic assertion"
      : "deterministic evaluation (TypeScript check)",
    `expectation (frozen contract text): ${criterion.expectation}`,
    `expected: ${criterion.expected ?? "—"}`,
    `observed: ${criterion.observed ?? "—"}`,
    criterion.limitations === undefined ? undefined : `limitations: ${criterion.limitations}`,
    criterion.confidence === undefined
      ? undefined
      : `confidence declared by the evaluator: ${(criterion.confidence * 100).toFixed(0)} % ` +
        "(self-reported, recorded for diagnosis, read by no harness rule)",
    criterion.absence === undefined ? undefined : `absence branch: ${criterion.absence}`,
    `evidence: ${criterion.evidence.map((e) => e.artifactId).join(", ") || "none"}`,
    criterion.danglingEvidence.length === 0
      ? undefined
      : `referenced evidence not found: ${criterion.danglingEvidence.join(", ")}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

/**
 * A run-level `<testcase>`. Emitted for an error or a cancellation, and ALSO whenever there is no
 * criterion at all — a run that died before the contract was frozen has nothing else to report,
 * and an empty `<testsuite>` would tell CI that nothing went wrong.
 */
const runLevelCase = (view: ReportView): string | undefined => {
  const noCriteria = view.criteria.length === 0;
  if (view.status !== "error" && view.status !== "cancelled" && !noCriteria) return undefined;
  const type =
    view.status === "cancelled"
      ? "run-cancelled"
      : view.status === "error"
        ? "run-error"
        : "run-no-criteria";
  const message = `status=${view.status} — ${oneLine(
    view.statusDetail ?? (noCriteria ? "no criterion was evaluated" : "no detail recorded"),
  )}`;
  return [
    `    <testcase ${attr("name", `run:${view.runId}`)} ${attr("classname", view.scenarioId)} ${attr(
      "time",
      seconds(view.durationMs),
    )}>`,
    `      <error ${attr("type", type)} ${attr("message", truncate(message, 900))}>${escapeXml(
      view.status === "cancelled" ? `${message}\n\n${CANCELLATION_NOTE}` : message,
    )}</error>`,
    `    </testcase>`,
  ].join("\n");
};

export const renderJUnitReport = (input: ReportInput): string =>
  renderJUnitFromView(buildReportView(input));

export const renderJUnitFromView = (view: ReportView): string => {
  const cases: Array<string> = [];
  let failures = 0;
  let errors = 0;

  for (const criterion of view.criteria) {
    const outcome = outcomeFor(criterion);
    if (outcome.tag === "failure") failures += 1;
    if (outcome.tag === "error") errors += 1;
    const name = truncate(`${criterion.id} — ${oneLine(criterion.expectation)}`, 200);
    const open = `    <testcase ${attr("name", name)} ${attr("classname", `${view.scenarioId}.${criterion.method}`)} ${attr(
      "time",
      "0.000",
    )}`;
    if (outcome.tag === undefined) {
      cases.push(`${open}/>`);
      continue;
    }
    cases.push(
      `${open}>`,
      `      <${outcome.tag} ${attr("type", outcome.type)} ${attr("message", truncate(outcome.message, 900))}>${escapeXml(
        caseBody(criterion),
      )}</${outcome.tag}>`,
      `    </testcase>`,
    );
  }

  const runCase = runLevelCase(view);
  if (runCase !== undefined) {
    errors += 1;
    cases.push(runCase);
  }

  const total = view.criteria.length + (runCase === undefined ? 0 : 1);
  const properties = [
    ["harness.runId", view.runId],
    ["harness.status", view.status],
    ["harness.specPath", view.specPath],
    ["harness.contractHash", view.contractHash],
    ["harness.provider", view.model.provider],
    ["harness.model", view.model.modelId],
    ["harness.adapter", view.model.adapterId],
    ["harness.finalized", String(view.finalized)],
    ...view.attempts.map((a) => [`harness.actions.${a.attemptId}`, a.actions.rendering] as const),
    ["harness.artifacts.present", String(view.artifactCounts.present)],
    ["harness.artifacts.missing", String(view.artifactCounts.missing)],
    ["harness.artifacts.failed", String(view.artifactCounts.failed)],
  ] as const;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites ${attr("name", "harness")} ${attr("tests", total)} ${attr("failures", failures)} ${attr(
      "errors",
      errors,
    )} ${attr("skipped", 0)} ${attr("time", seconds(view.durationMs))}>`,
    `  <testsuite ${attr("name", view.scenarioId)} ${attr("package", view.specPath)} ${attr("tests", total)} ${attr(
      "failures",
      failures,
    )} ${attr("errors", errors)} ${attr("skipped", 0)} ${attr("time", seconds(view.durationMs))} ${attr(
      "timestamp",
      view.startedAt,
    )} ${attr("hostname", "harness")}>`,
    `    <properties>`,
    ...properties.map(
      ([name, value]) => `      <property ${attr("name", name)} ${attr("value", value)}/>`,
    ),
    `    </properties>`,
    ...cases,
    `    <system-out>${escapeXml(CANCELLATION_NOTE)}</system-out>`,
    `  </testsuite>`,
    `</testsuites>`,
    ``,
  ].join("\n");
};
