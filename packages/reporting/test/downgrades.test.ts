import type { AttemptResult, CriterionResult, ReportInput } from "@difmp/core"
import { describe, expect, it } from "vitest"
import { renderHtmlReport } from "../src/html.js"
import { buildReportView } from "../src/view.js"
import { loadFixture } from "./fixtures.js"

/**
 * A criterion the harness refused to conclude must say WHICH rule refused, and a verdict the agent
 * tried to overturn must still be visible. A bare `inconclusive` is exactly the information the
 * reader is missing, so these are rendered as their own blocks, not folded into "limites".
 */
const withVerdictHistory = (input: ReportInput): ReportInput => {
  const attempt = input.result.attempts[0]!
  const [first, ...rest] = attempt.criteria
  const patched: CriterionResult = {
    ...first!,
    status: "inconclusive",
    absence: "uncertain-navigation",
    downgrades: [
      {
        reason: "absence-uncertain-navigation",
        from: "failed",
        to: "inconclusive",
        detail: "navigation did not settle, so absence cannot be distinguished from a page that never rendered"
      },
      {
        reason: "evidence-persistence-failed",
        from: "passed",
        to: "inconclusive",
        detail: "mandatory evidence could not be persisted: checkpoint capture for c1 (art_9): disk full"
      }
    ],
    reChecks: [
      {
        status: "passed",
        observed: "cette fois le projet est visible",
        evidence: ["art_2"],
        requestedBy: "agent",
        evaluatedAtSeq: 42,
        applied: false,
        note: "the criterion was already failed; a later agent evaluation reported passed and was kept " +
          "as an observation — asking again never upgrades a verdict"
      }
    ]
  }
  const attempts: ReadonlyArray<AttemptResult> = [
    { ...attempt, criteria: [patched, ...rest] } as AttemptResult,
    ...input.result.attempts.slice(1)
  ]
  return { ...input, result: { ...input.result, attempts } as ReportInput["result"] }
}

describe("the report explains why the harness refused to conclude", () => {
  const input = withVerdictHistory(loadFixture("inconclusive"))

  it("carries the downgrades and the later evaluations into the view", () => {
    const view = buildReportView(input)
    const criterion = view.criteria.find((c) => c.id === "c1")!
    expect(criterion.downgrades.map((d) => d.reason)).toEqual([
      "absence-uncertain-navigation",
      "evidence-persistence-failed"
    ])
    expect(criterion.reChecks).toHaveLength(1)
    const sources = view.diagnostics.map((d) => d.source)
    expect(sources).toContain("absence après navigation incertaine c1")
    expect(sources).toContain("preuve obligatoire non enregistrée c1")
    expect(sources).toContain("re-vérification c1")
  })

  it("names the rule, the status it replaced and the reason in the HTML", () => {
    const html = renderHtmlReport(input)
    expect(html).toContain("Statut imposé par le harness")
    expect(html).toContain("absence après navigation incertaine")
    expect(html).toContain("preuve obligatoire non enregistrée")
    expect(html).toContain("Évaluations ultérieures de ce critère")
    expect(html).toContain("observation seulement")
    // The rejected upgrade is shown as what it was, not silently dropped.
    expect(html).toContain("cette fois le projet est visible")
  })

  it("escapes a downgrade detail like every other piece of text", () => {
    const attempt = input.result.attempts[0]!
    const criterion = attempt.criteria[0]!
    const hostile: ReportInput = {
      ...input,
      result: {
        ...input.result,
        attempts: [{
          ...attempt,
          criteria: [{
            ...criterion,
            downgrades: [{
              reason: "rejected-evidence",
              from: "passed",
              to: "inconclusive",
              detail: `<script>alert("xss")</script>`
            }]
          }, ...attempt.criteria.slice(1)]
        } as AttemptResult]
      } as ReportInput["result"]
    }
    const html = renderHtmlReport(hostile)
    expect(html).not.toContain("<script>alert")
    expect(html).toContain("&lt;script&gt;")
  })
})
