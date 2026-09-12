import type { ReportInput } from "@difmp/core";
import { artifactHref, embedJson, escapeHtml as h } from "./escape.js";
import { reportStyles } from "./styles.js";
import type {
  ArtifactView,
  AttemptView,
  CriterionView,
  Diagnostic,
  ReportView,
  TimelineEntry,
} from "./view.js";
import { buildReportView, criterionStatusLabel, downgradeLabel } from "./view.js";

/**
 * The statement spec §9 demands whenever a verdict came from a textual evaluation. It is rendered
 * next to every `model` criterion, not once in a footnote.
 */
const PROBABILISTIC_NOTE =
  "Textual evaluation by a model: the verdict is probabilistic and argued from the evidence " +
  "collected. It is not a deterministic assertion and it may differ from one run to the next.";

const DETERMINISTIC_NOTE =
  "Evaluation by code: a registered TypeScript check produced this verdict deterministically.";

const SCRIPTED_NOTE = "Deterministic scripted double: a test answer, never a real model judgement.";

const formatDuration = (ms: number): string =>
  ms < 1000
    ? `${ms} ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

const shortHash = (hash: string): string => (hash === "" ? "—" : hash.slice(0, 16));

const badge = (status: string, label: string): string =>
  `<span class="badge s-${h(status)}">${h(label)}</span>`;

/** Neutral on purpose: the method is not a verdict and must not borrow a status colour. */
const methodBadge = (method: "model" | "code"): string =>
  `<span class="badge method">method ${h(method)}</span>`;

/** A path is data too: only a relative, in-directory path becomes a link. */
const artifactLink = (artifact: ArtifactView): string => {
  if (artifact.path === undefined) return `<span class="missing">no file</span>`;
  const href = artifactHref(artifact.path);
  return href === undefined
    ? `<span class="mono wrap">${h(artifact.path)}</span> <span class="missing">(non-relative path, not linked)</span>`
    : `<a class="mono wrap" href="${h(href)}">${h(artifact.path)}</a>`;
};

const definition = (label: string, value: string | undefined, mono = false): string =>
  value === undefined || value === ""
    ? ""
    : `<dt>${h(label)}</dt><dd class="wrap${mono ? " mono" : ""}">${h(value)}</dd>`;

const expectationItem = (criterion: CriterionView): string => {
  const source =
    criterion.sourceText === criterion.expectation
      ? ""
      : `<dt>Source text (before interpolation)</dt><dd><pre>${h(criterion.sourceText)}</pre></dd>`;
  return `<article class="item">
  <header>
    <b class="mono">${h(criterion.id)}</b>
    ${methodBadge(criterion.method)}
    <span class="cat">${h(criterion.location)}</span>
  </header>
  <pre>${h(criterion.expectation)}</pre>
  <dl class="kv">
    ${definition("Criterion hash (contract)", shortHash(criterion.contractHash), true)}
    ${source}
  </dl>
</article>`;
};

/**
 * The harness refusing to conclude is INFORMATION. A criterion that reads `inconclusive` because a
 * rule downgraded it must say which rule, what the evaluator had answered, and why — otherwise the
 * reader cannot tell "the evaluator was unsure" from "the harness would not take its word".
 */
const downgradeBlock = (criterion: CriterionView): string => {
  if (criterion.downgrades.length === 0) return "";
  const rows = criterion.downgrades
    .map(
      (downgrade) =>
        `<li><b>${h(downgradeLabel(downgrade.reason))}</b> — status "${h(
          criterionStatusLabel(downgrade.from),
        )}" brought down to "${h(criterionStatusLabel(downgrade.to))}": ${h(downgrade.detail)}</li>`,
    )
    .join("");
  return `<div class="note d-warning"><b>Status imposed by the harness</b>
  <ul>${rows}</ul>
  <p>The verdict shown is not the one the evaluator proposed: a harness rule refused it.</p></div>`;
};

/** spec §9 forbids losing an earlier verdict when the agent asks again. */
const reCheckBlock = (criterion: CriterionView): string => {
  if (criterion.reChecks.length === 0) return "";
  const rows = criterion.reChecks
    .map(
      (reCheck) =>
        `<tr><td class="mono">seq ${h(String(reCheck.evaluatedAtSeq))}</td><td>${h(
          criterionStatusLabel(reCheck.status),
        )}</td><td>${h(reCheck.requestedBy)}</td><td>${
          reCheck.applied
            ? badge("failed", "replaced the verdict")
            : badge("inconclusive", "observation only")
        }</td><td class="wrap">${h(reCheck.observed)}</td></tr>`,
    )
    .join("");
  return `<div class="note d-warning"><b>Later evaluations of this criterion</b>
  <div class="scroll"><table>
    <thead><tr><th>Event</th><th>Status returned</th><th>Requested by</th><th>Effect</th><th>Observed</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p>${h(criterion.reChecks[criterion.reChecks.length - 1]!.note)}</p></div>`;
};

const evaluationItem = (criterion: CriterionView): string => {
  const note =
    criterion.evaluatorKind === "scripted-model"
      ? `<p class="note">${h(SCRIPTED_NOTE)} ${h(PROBABILISTIC_NOTE)}</p>`
      : criterion.probabilistic
        ? `<p class="note">${h(PROBABILISTIC_NOTE)}</p>`
        : `<p class="note deterministic">${h(DETERMINISTIC_NOTE)}</p>`;

  const evidence =
    criterion.evidence.length === 0
      ? `<dd>no evidence attached</dd>`
      : `<dd><ul>${criterion.evidence
          .map(
            (a) =>
              `<li><span class="mono">${h(a.artifactId)}</span> — ${h(a.kind)} — ${artifactLink(a)}</li>`,
          )
          .join("")}</ul></dd>`;

  const dangling =
    criterion.danglingEvidence.length === 0
      ? ""
      : `<dt>Evidence references not found</dt><dd class="missing mono">${h(
          criterion.danglingEvidence.join(", "),
        )}</dd>`;

  const mismatch = criterion.hashMismatch
    ? `<p class="note d-error">The evaluated hash (${h(
        shortHash(criterion.resultHash ?? ""),
      )}) does not match the frozen contract hash (${h(shortHash(criterion.contractHash))}).</p>`
    : "";

  return `<article class="item">
  <header>
    <b class="mono">${h(criterion.id)}</b>
    ${badge(criterion.status, criterionStatusLabel(criterion.status))}
    ${methodBadge(criterion.method)}
    <span class="cat">${h(criterion.evaluatorLabel)}</span>
  </header>
  ${note}
  ${mismatch}
  ${downgradeBlock(criterion)}
  ${reCheckBlock(criterion)}
  <dl class="kv">
    <dt>Expectation evaluated (frozen text)</dt><dd><pre>${h(criterion.expectation)}</pre></dd>
    <dt>Expected (evaluator)</dt><dd><pre>${h(criterion.expected ?? "—")}</pre></dd>
    <dt>Observed (evaluator)</dt><dd><pre>${h(criterion.observed ?? "—")}</pre></dd>
    ${definition("Declared limitations", criterion.limitations)}
    ${definition(
      "Branch of the absence rule",
      criterion.absence === undefined
        ? undefined
        : criterion.absence === "uncertain-navigation"
          ? "absence after uncertain navigation → inconclusive"
          : "absence established at the intended checkpoint → failed",
    )}
    ${definition("Evaluated at event", criterion.evaluatedAtSeq === undefined ? undefined : `seq ${criterion.evaluatedAtSeq}`)}
    ${definition("Attempt", criterion.attemptId)}
    <dt>Evidence</dt>${evidence}
    ${dangling}
  </dl>
</article>`;
};

const timelineRow = (entry: TimelineEntry): string =>
  `<tr class="c-${h(entry.category)}">
  <td class="mono">${h(String(entry.seq))}</td>
  <td class="mono wrap">${h(entry.ts)}</td>
  <td><span class="cat">${h(entry.category)}</span></td>
  <td class="wrap">${h(entry.title)}${
    entry.durationMs === undefined
      ? ""
      : ` <span class="cat">(${h(formatDuration(entry.durationMs))})</span>`
  }</td>
  <td class="wrap">${entry.fields
    .map((f) => `<div><span class="cat">${h(f.label)}</span> ${h(f.value)}</div>`)
    .join("")}</td>
</tr>`;

const attemptAccounting = (attempt: AttemptView): string => `<div class="item">
  <header><b class="mono">${h(attempt.attemptId)}</b> ${badge(attempt.status, attempt.status)}</header>
  <h3>Blocking budgets — consumed and remaining</h3>
  <div class="scroll"><table>
    <thead><tr><th>Budget</th><th>Consumed</th><th>Limit</th><th>Remaining</th><th>Note</th></tr></thead>
    <tbody>${attempt.budgets
      .map(
        (b) =>
          `<tr><td>${h(b.label)} <span class="cat">${h(b.key)}</span></td><td class="mono">${h(String(b.used))}</td><td class="mono">${h(
            String(b.limit),
          )}</td><td class="mono">${h(String(b.remaining))}</td><td class="wrap">${h(b.note ?? "")}</td></tr>`,
      )
      .join("")}</tbody>
  </table></div>
  <h3>Action counter — INDICATIVE threshold, distinct from the budgets</h3>
  <p class="mono big">${h(attempt.actions.rendering)}</p>
  <p class="note">The <code>maxActions</code> threshold is indicative: crossing it refused nothing, degraded no
  status and counts towards no blocking budget. ${
    attempt.actions.exceeded ? "It was crossed during this attempt." : "It was not crossed."
  }</p>
</div>`;

const artifactRow = (artifact: ArtifactView): string => `<tr>
  <td class="mono">${h(artifact.artifactId)}</td>
  <td class="mono">${h(artifact.attemptId)}</td>
  <td>${h(artifact.kind)}${artifact.label === undefined ? "" : ` <span class="cat">${h(artifact.label)}</span>`}</td>
  <td>${
    artifact.state === "present"
      ? badge("passed", "present")
      : badge(
          artifact.state === "failed" ? "failed" : "inconclusive",
          artifact.state === "failed" ? "failed" : "missing",
        )
  }</td>
  <td>${artifactLink(artifact)}</td>
  <td class="wrap">${h(artifact.reason ?? "")}</td>
  <td class="mono">${artifact.bytes === undefined ? "" : h(formatBytes(artifact.bytes))}</td>
  <td class="mono wrap">${h(artifact.ts)}</td>
</tr>`;

const diagnosticItem = (diagnostic: Diagnostic): string =>
  `<p class="note d-${h(diagnostic.severity)}"><b>${h(diagnostic.source)}</b>${
    diagnostic.seq === undefined ? "" : ` <span class="cat">seq ${h(String(diagnostic.seq))}</span>`
  } — ${h(diagnostic.message)}</p>`;

export const renderHtmlReport = (input: ReportInput): string =>
  renderHtmlFromView(buildReportView(input));

export const renderHtmlFromView = (view: ReportView): string => {
  const title = `Report ${view.scenarioId} — ${view.statusLabel}`;
  const counts = view.counts;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)}</title>
<style>${reportStyles}</style>
</head>
<body>
<main>

<section class="panel" id="verdict">
  <div class="verdict">
    <div>
      <h1>${h(view.scenarioId)}</h1>
      <p class="lede mono">${h(view.specPath)}</p>
    </div>
    <div class="big s-${h(view.status)}">${h(view.statusLabel)}</div>
  </div>
  ${view.statusDetail === undefined ? "" : `<p class="note">${h(view.statusDetail)}</p>`}
  ${
    view.finalized
      ? ""
      : `<p class="note d-error">Run not finalized: the journal ends on an incomplete line.
         This report may be partial.</p>`
  }
  <div class="meta">
    <div><span>Run</span><span class="mono">${h(view.runId)}</span></div>
    <div><span>Started</span><span class="mono">${h(view.startedAt)}</span></div>
    <div><span>Finished</span><span class="mono">${h(view.finishedAt)}</span></div>
    <div><span>Duration</span>${h(formatDuration(view.durationMs))}</div>
    <div><span>Contract hash</span><span class="mono">${h(shortHash(view.contractHash))}</span></div>
    <div><span>Adapter</span><span class="mono">${h(view.model.adapterId)}</span></div>
    <div><span>Model</span><span class="mono">${h(`${view.model.provider}/${view.model.modelId}`)}</span></div>
    <div><span>Base URL</span><span class="mono wrap">${h(view.baseUrl)}</span></div>
    <div><span>Harness / Node</span><span class="mono">${h(`${view.harnessVersion} / ${view.nodeVersion}`)}</span></div>
  </div>
  <div class="tiles">
    <div class="tile s-passed"><b>${h(String(counts.passed))}</b><span>passed</span></div>
    <div class="tile s-failed"><b>${h(String(counts.failed))}</b><span>failed</span></div>
    <div class="tile s-inconclusive"><b>${h(String(counts.inconclusive))}</b><span>inconclusive</span></div>
    <div class="tile s-error"><b>${h(String(counts.error))}</b><span>in error</span></div>
    <div class="tile s-pending"><b>${h(String(counts.pending))}</b><span>pending</span></div>
    <div class="tile"><b>${h(String(view.artifactCounts.present))}</b><span>artifacts present</span></div>
    <div class="tile"><b>${h(
      String(view.artifactCounts.missing + view.artifactCounts.failed),
    )}</b><span>artifacts missing</span></div>
  </div>
</section>

<nav>
  <a href="#expectations">Expectations</a>
  <a href="#evaluations">Evaluations</a>
  <a href="#facts">Factual observations</a>
  <a href="#accounting">Budgets and actions</a>
  <a href="#artifacts">Artifacts</a>
  <a href="#diagnostics">Diagnostic hypotheses</a>
</nav>

<section class="panel" id="expectations">
  <h2>Textual expectations</h2>
  <p class="lede">The frozen contract text, verbatim. Nothing here is a result: this is what was asked for,
  as frozen before any navigation. The browsing agent cannot change it.</p>
  ${view.criteria.map(expectationItem).join("\n")}
  ${
    view.criteria.length === 0
      ? `<p class="note">No expectation was frozen: the run stopped before step 3 of §6 (contract never frozen).
  This report describes an infrastructure failure, not a verdict on the product.</p>`
      : ""
  }
  <h3>Scenario body (interpolated)</h3>
  <pre>${h(view.scenarioBody)}</pre>
</section>

<section class="panel" id="evaluations">
  <h2>Evaluations</h2>
  <p class="lede">The verdicts, with their method and their evaluator. An evaluation by a model is a probabilistic
  textual judgement; an evaluation by code is a deterministic assertion. The two are told apart
  explicitly below.</p>
  ${view.criteria.map(evaluationItem).join("\n")}
  ${view.criteria.length === 0 ? `<p class="note">No criterion could be evaluated.</p>` : ""}
</section>

<section class="panel" id="facts">
  <h2>Factual observations</h2>
  <p class="lede">The journalled chronology of actions, observations, verifications and errors. These are
  facts recorded during the run, with no interpretation.</p>
  <div class="scroll"><table>
    <thead><tr><th>Seq</th><th>Timestamp</th><th>Category</th><th>Event</th><th>Details</th></tr></thead>
    <tbody>${view.timeline.map(timelineRow).join("")}</tbody>
  </table></div>
  ${view.timeline.length === 0 ? `<p class="note">No event journalled.</p>` : ""}
</section>

<section class="panel" id="accounting">
  <h2>Blocking budgets and action counter</h2>
  <p class="lede">Two distinct things, presented separately: the blocking budgets end the run when they are
  exhausted; the action threshold is purely indicative and never changes a verdict.</p>
  ${view.attempts.map(attemptAccounting).join("\n")}
  ${view.attempts.length === 0 ? `<p class="note">No attempt recorded.</p>` : ""}
</section>

<section class="panel" id="artifacts">
  <h2>Artifact inventory</h2>
  <p class="lede">Every expected artifact, present or not. A capture failure is listed with its reason, never
  hidden. The links are paths relative to the run directory.</p>
  <div class="scroll"><table>
    <thead><tr><th>Id</th><th>Attempt</th><th>Type</th><th>State</th><th>File</th><th>Reason</th><th>Size</th><th>Timestamp</th></tr></thead>
    <tbody>${view.artifacts.map(artifactRow).join("")}</tbody>
  </table></div>
  ${view.artifacts.length === 0 ? `<p class="note">No artifact recorded.</p>` : ""}
</section>

<section class="panel" id="diagnostics">
  <h2>Diagnostic hypotheses</h2>
  <p class="lede">Interpretations and signals, not observed facts: reasons for a status, exhausted budgets,
  limitations declared by the evaluators, missing artifacts.</p>
  ${
    view.diagnostics.length === 0
      ? `<p class="note d-info">No diagnostic signal recorded.</p>`
      : view.diagnostics.map(diagnosticItem).join("\n")
  }
</section>

<footer>
  <p>Standalone report: it opens offline from <code>file://</code> and loads no external resource.
  Large artifacts stay as neighbouring files, referenced by relative paths.</p>
  <p>Opening <code>attempts/&lt;attempt&gt;/trace.zip</code> remains a documented external action:
  <code>npx playwright show-trace &lt;path&gt;</code>, or <code>trace.playwright.dev</code>.</p>
  <p>Limitations: traces, videos and DOM captures may contain page data and are not anonymized.
  The allow-list of origins is a tool-level control, not network isolation.</p>
  <script type="application/json" id="harness-report-data">${embedJson(view)}</script>
</footer>

</main>
</body>
</html>
`;
};
