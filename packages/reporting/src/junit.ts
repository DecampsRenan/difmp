import type { ReportInput } from "@harness/core"
import { escapeXml } from "./escape.js"
import type { CriterionView, ReportView } from "./view.js"
import { buildReportView } from "./view.js"

/**
 * design-contracts §12: product criterion failures are `<failure>`; technical errors AND
 * indeterminate results are `<error>` with the real status preserved in the message;
 * cancellations are `<error>` too. `skipped` is NEVER emitted — a green skip would turn an
 * unresolved verdict into a pass in every CI dashboard that reads this file.
 */
const CANCELLATION_NOTE =
  "Convention JUnit du harness : un critère `failed` est un <failure> (le produit contredit " +
  "l'attente) ; `inconclusive`, `pending` et `error` sont des <error> (indéterminé ou technique) ; " +
  "une annulation est un <error> au niveau du run. Aucun <skipped> n'est émis : un résultat " +
  "indéterminé ne doit jamais apparaître en vert."

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim()

const truncate = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, max - 1)}…`

const seconds = (ms: number): string => (ms / 1000).toFixed(3)

const attr = (name: string, value: string | number): string => `${name}="${escapeXml(String(value))}"`

interface CaseOutcome {
  readonly tag: "failure" | "error" | undefined
  readonly type: string
  readonly message: string
}

const outcomeFor = (criterion: CriterionView): CaseOutcome => {
  switch (criterion.status) {
    case "passed":
      return { tag: undefined, type: "", message: "" }
    case "failed":
      return {
        tag: "failure",
        type: "criterion-failed",
        message: `status=failed — ${oneLine(criterion.observed ?? "aucune observation enregistrée")}`
      }
    case "inconclusive":
      return {
        tag: "error",
        type: "criterion-inconclusive",
        message: `status=inconclusive (résultat indéterminé, pas un succès) — ${
          oneLine(criterion.observed ?? criterion.limitations ?? "preuves insuffisantes")
        }`
      }
    case "pending":
      return {
        tag: "error",
        type: "criterion-pending",
        message: "status=pending — le critère n'a jamais été évalué"
      }
    case "error":
      return {
        tag: "error",
        type: "criterion-error",
        message: `status=error — ${oneLine(criterion.observed ?? "erreur technique pendant l'évaluation")}`
      }
  }
}

const caseBody = (criterion: CriterionView): string =>
  [
    `critère: ${criterion.id}`,
    `statut réel: ${criterion.status}`,
    `méthode: ${criterion.method}`,
    `évaluateur: ${criterion.evaluatorLabel}`,
    criterion.probabilistic
      ? "avertissement: évaluation textuelle probabiliste, ce n'est pas une assertion déterministe"
      : "évaluation déterministe (check TypeScript)",
    `attente (texte gelé du contrat): ${criterion.expectation}`,
    `attendu: ${criterion.expected ?? "—"}`,
    `observé: ${criterion.observed ?? "—"}`,
    criterion.limitations === undefined ? undefined : `limites: ${criterion.limitations}`,
    criterion.absence === undefined ? undefined : `branche d'absence: ${criterion.absence}`,
    `preuves: ${criterion.evidence.map((e) => e.artifactId).join(", ") || "aucune"}`,
    criterion.danglingEvidence.length === 0
      ? undefined
      : `preuves référencées introuvables: ${criterion.danglingEvidence.join(", ")}`
  ].filter((line): line is string => line !== undefined).join("\n")

const runLevelCase = (view: ReportView): string | undefined => {
  if (view.status !== "error" && view.status !== "cancelled") return undefined
  const type = view.status === "cancelled" ? "run-cancelled" : "run-error"
  const message = `status=${view.status} — ${oneLine(view.statusDetail ?? "aucun détail enregistré")}`
  return [
    `    <testcase ${attr("name", `run:${view.runId}`)} ${attr("classname", view.scenarioId)} ${
      attr("time", seconds(view.durationMs))
    }>`,
    `      <error ${attr("type", type)} ${attr("message", truncate(message, 900))}>${
      escapeXml(
        view.status === "cancelled"
          ? `${message}\n\n${CANCELLATION_NOTE}`
          : message
      )
    }</error>`,
    `    </testcase>`
  ].join("\n")
}

export const renderJUnitReport = (input: ReportInput): string => renderJUnitFromView(buildReportView(input))

export const renderJUnitFromView = (view: ReportView): string => {
  const cases: Array<string> = []
  let failures = 0
  let errors = 0

  for (const criterion of view.criteria) {
    const outcome = outcomeFor(criterion)
    if (outcome.tag === "failure") failures += 1
    if (outcome.tag === "error") errors += 1
    const name = truncate(`${criterion.id} — ${oneLine(criterion.expectation)}`, 200)
    const open = `    <testcase ${attr("name", name)} ${attr("classname", `${view.scenarioId}.${criterion.method}`)} ${
      attr("time", "0.000")
    }`
    if (outcome.tag === undefined) {
      cases.push(`${open}/>`)
      continue
    }
    cases.push(
      `${open}>`,
      `      <${outcome.tag} ${attr("type", outcome.type)} ${attr("message", truncate(outcome.message, 900))}>${
        escapeXml(caseBody(criterion))
      }</${outcome.tag}>`,
      `    </testcase>`
    )
  }

  const runCase = runLevelCase(view)
  if (runCase !== undefined) {
    errors += 1
    cases.push(runCase)
  }

  const total = view.criteria.length + (runCase === undefined ? 0 : 1)
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
    ["harness.artifacts.failed", String(view.artifactCounts.failed)]
  ] as const

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites ${attr("name", "harness")} ${attr("tests", total)} ${attr("failures", failures)} ${
      attr("errors", errors)
    } ${attr("skipped", 0)} ${attr("time", seconds(view.durationMs))}>`,
    `  <testsuite ${attr("name", view.scenarioId)} ${attr("package", view.specPath)} ${attr("tests", total)} ${
      attr("failures", failures)
    } ${attr("errors", errors)} ${attr("skipped", 0)} ${attr("time", seconds(view.durationMs))} ${
      attr("timestamp", view.startedAt)
    } ${attr("hostname", "harness")}>`,
    `    <properties>`,
    ...properties.map(([name, value]) => `      <property ${attr("name", name)} ${attr("value", value)}/>`),
    `    </properties>`,
    ...cases,
    `    <system-out>${escapeXml(CANCELLATION_NOTE)}</system-out>`,
    `  </testsuite>`,
    `</testsuites>`,
    ``
  ].join("\n")
}
