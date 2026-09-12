import { createHash } from "node:crypto"
import type { Check, CheckResult } from "@difmp/core"
import type { ProbeResult } from "@difmp/fixture-app"
import { lookupWorkspace } from "../fixtures/attempt-state.js"
import { seedTokenEnvVar } from "../fixtures/authenticated-workspace.js"

/**
 * The optional TS check of spec §13. It answers a question the visible list cannot: how many
 * projects with this name were actually PERSISTED. It reads the fixture app's reserved
 * `GET /__probe/projects` endpoint, which is guarded by `x-seed-token` and is deliberately absent
 * from the agent's toolset — the browsing agent has no way to call it.
 *
 * Its verdict is authoritative for the criterion it is bound to (`method: "code"`).
 */

const inconclusive = (expected: string, observed: string): CheckResult => ({
  status: "inconclusive",
  expected,
  observed,
  evidence: []
})

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

/** French/English wordings this check is written to prove. */
const uniquenessMarkers = ["exactement un", "exactly one", "un seul", "une seule"]

/**
 * A `checks:` mapping binds this check to a criterion ID, and IDs are positional (`c1`, `c2`, …).
 * Reordering the expectations would therefore hand this check a different sentence under the same
 * id. Two guards make that a loud failure instead of a silent rebind:
 *
 *  1. the frozen hash must be the hash of the text handed over (the harness checks this too; doing
 *     it here as well means the check never trusts a caller it did not verify), and
 *  2. the text must actually be the uniqueness statement about this attempt's project name.
 */
const bindingProblem = (
  criterion: { readonly id: string; readonly text: string; readonly hash: string },
  projectName: string
): string | undefined => {
  const actual = sha256Hex(criterion.text)
  if (actual !== criterion.hash) {
    return `the text of ${criterion.id} does not match the hash frozen in the contract ` +
      `(contract ${criterion.hash.slice(0, 16)}, actual ${actual.slice(0, 16)})`
  }
  const normalised = criterion.text.toLowerCase()
  if (!criterion.text.includes(projectName)) {
    return `${criterion.id} does not mention the project name ${JSON.stringify(projectName)}, so ` +
      "this check is bound to a criterion it was not written for — did the expectations move?"
  }
  if (!uniquenessMarkers.some((marker) => normalised.includes(marker))) {
    return `${criterion.id} is not a uniqueness statement (expected one of: ` +
      `${uniquenessMarkers.join(", ")}), so this check is bound to a criterion it was not written for`
  }
  return undefined
}

export const projectUniqueInStorage: Check = async (ctx): Promise<CheckResult> => {
  const expected = "exactly one project with this attempt's name persisted in the server-side store"

  const projectName = ctx.inputs["projectName"]
  if (typeof projectName !== "string" || projectName === "") {
    return inconclusive(
      expected,
      "the scenario declares no string input named `projectName`, so there is no name to probe for"
    )
  }

  const problem = bindingProblem(ctx.criterion, projectName)
  if (problem !== undefined) return inconclusive(expected, `refusing to answer: ${problem}`)

  const workspace = lookupWorkspace(ctx.runId, ctx.attemptId)
  if (workspace === undefined) {
    return inconclusive(
      expected,
      "no workspace was seeded for this attempt — this check requires the `authenticated-workspace` fixture"
    )
  }

  // The probe is a harness-side operation, never an agent tool; its token is a secret from the env.
  const seedToken = process.env[seedTokenEnvVar]
  if (seedToken === undefined || seedToken.trim() === "") {
    return inconclusive(expected, `${seedTokenEnvVar} is not set, so the reserved probe cannot be called`)
  }

  const url = new URL("/__probe/projects", ctx.baseUrl)
  url.searchParams.set("workspaceId", workspace.workspaceId)
  url.searchParams.set("name", projectName)

  let response: Response
  try {
    response = await fetch(url, { headers: { "x-seed-token": seedToken } })
  } catch (cause) {
    return inconclusive(
      expected,
      `the reserved probe at ${url.origin} could not be reached: ` +
        (cause instanceof Error ? cause.message : String(cause))
    )
  }

  if (!response.ok) {
    // 403 = wrong token, 404 = the app runs with seedEnabled: false. Either way the invariant is
    // unproven, which is `inconclusive` — never a pass, and never a product failure.
    const evidenceId = await ctx.recordEvidence({
      label: "probe:/__probe/projects (rejected)",
      data: { endpoint: "/__probe/projects", workspaceId: workspace.workspaceId, name: projectName, status: response.status }
    })
    return {
      status: "inconclusive",
      expected,
      observed: `the reserved probe answered HTTP ${response.status}, so persistence could not be established`,
      evidence: [evidenceId]
    }
  }

  const probe = (await response.json()) as ProbeResult

  // Journalled as evidence BEFORE the verdict, so the verdict always has something to point at.
  // No token, no cookie, no session: only the probe coordinates and what the store answered.
  const evidenceId = await ctx.recordEvidence({
    label: "probe:/__probe/projects",
    data: {
      endpoint: "/__probe/projects",
      query: { workspaceId: workspace.workspaceId, name: projectName },
      status: response.status,
      count: probe.count,
      projects: probe.projects.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt }))
    }
  })

  const observed = probe.count === 0
    ? `the store holds no project named ${JSON.stringify(projectName)} in workspace ${workspace.workspaceId}`
    : `the store holds ${probe.count} project(s) named ${JSON.stringify(projectName)} in workspace ` +
      `${workspace.workspaceId} (ids: ${probe.projects.map((p) => p.id).join(", ")})`

  return {
    status: probe.count === 1 ? "passed" : "failed",
    expected,
    observed,
    evidence: [evidenceId]
  }
}
