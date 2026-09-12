import type { ContractView } from "../types/contract.js"
import type { ActionId, HarnessEvent } from "../types/events.js"
import type { ActionView, ArtifactView, CriterionView, RunModel, TimelineEntry } from "./model.js"
import { emptyRunModel } from "./model.js"

export type RunAction =
  | { readonly kind: "event"; readonly event: HarnessEvent }
  | { readonly kind: "malformed" }
  | { readonly kind: "contract"; readonly contract: ContractView }
  | { readonly kind: "reset" }

const truncate = (value: string, max = 220): string => (value.length <= max ? value : `${value.slice(0, max)}…`)

const describeParams = (params: Readonly<Record<string, unknown>>): string | undefined => {
  const entries = Object.entries(params)
  if (entries.length === 0) return undefined
  return truncate(
    entries
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("  ")
  )
}

/** The action a screenshot (or any artifact) belongs to: the last action opened at or before it. */
const actionAtSeq = (actions: ReadonlyArray<ActionView>, seq: number | undefined): ActionView | undefined => {
  if (actions.length === 0) return undefined
  const ceiling = seq ?? Number.MAX_SAFE_INTEGER
  let found: ActionView | undefined
  for (const action of actions) {
    if (action.seq <= ceiling) found = action
    else break
  }
  return found
}

const closeTimelineRow = (
  timeline: ReadonlyArray<TimelineEntry>,
  actionId: ActionId,
  patch: Partial<TimelineEntry>
): ReadonlyArray<TimelineEntry> => {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const row = timeline[i]
    if (row !== undefined && row.kind === "action" && row.actionId === actionId && row.outcome === undefined) {
      const next = timeline.slice()
      next[i] = { ...row, ...patch }
      return next
    }
  }
  return timeline
}

const upsertCriterion = (
  criteria: ReadonlyArray<CriterionView>,
  id: string,
  patch: (current: CriterionView) => CriterionView
): ReadonlyArray<CriterionView> => {
  const index = criteria.findIndex((c) => c.id === id)
  if (index === -1) {
    return [...criteria, patch({ id, status: "pending", evidenceRequested: false })]
  }
  const current = criteria[index]
  if (current === undefined) return criteria
  const next = criteria.slice()
  next[index] = patch(current)
  return next
}

const mergeContract = (model: RunModel, contract: ContractView): RunModel => {
  let criteria = model.criteria
  for (const c of contract.criteria) {
    criteria = upsertCriterion(criteria, c.id, (current) => ({
      ...current,
      text: c.text,
      method: c.method,
      ...(c.checkName === undefined ? {} : { checkName: c.checkName })
    }))
  }
  return {
    ...model,
    criteria,
    contractCriteria: contract.criteria,
    ...(contract.maxActions === undefined ? {} : { contractMaxActions: contract.maxActions }),
    ...(model.specPath === undefined && contract.specPath !== undefined ? { specPath: contract.specPath } : {}),
    ...(model.scenarioId === undefined && contract.id !== undefined ? { scenarioId: contract.id } : {})
  }
}

/**
 * Fold one journal event into the view model.
 *
 * DEDUPE CONTRACT: `seq` increases by exactly 1 per run (design-contracts §6) and SSE delivers in
 * order, so "apply iff `seq > lastSeq`" is both necessary and sufficient. A reconnect that replays
 * inclusively, or a server that re-sends a frame, is silently absorbed and counted in `duplicates`.
 */
export const runReducer = (model: RunModel, action: RunAction): RunModel => {
  if (action.kind === "reset") return emptyRunModel
  if (action.kind === "malformed") return { ...model, malformed: model.malformed + 1 }
  if (action.kind === "contract") return mergeContract(model, action.contract)

  const event = action.event
  if (event.seq <= model.lastSeq) return { ...model, duplicates: model.duplicates + 1 }

  const base: RunModel = {
    ...model,
    lastSeq: event.seq,
    applied: model.applied + 1,
    runId: event.runId,
    ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId })
  }

  const row = (entry: Omit<TimelineEntry, "seq" | "ts">): RunModel => ({
    ...base,
    timeline: [...base.timeline, { seq: event.seq, ts: event.ts, ...entry }]
  })

  switch (event.type) {
    case "runStarted":
      return {
        ...row({ kind: "lifecycle", tone: "info", label: "Run started", detail: event.specPath }),
        specPath: event.specPath,
        scenarioId: event.scenarioId,
        harnessVersion: event.harnessVersion,
        startedAt: event.ts
      }

    case "configResolved":
      return {
        ...row({
          kind: "lifecycle",
          tone: "neutral",
          label: "Configuration resolved",
          ...(event.configPath === undefined ? {} : { detail: event.configPath })
        }),
        config: event.config,
        capture: event.config.capture,
        baseUrl: event.config.baseUrl
      }

    case "contractFrozen": {
      let criteria = base.criteria
      for (const id of event.criterionIds) {
        criteria = upsertCriterion(criteria, id, (current) => current)
      }
      // Core does not send this today; honoured if it ever does (see types/events.ts).
      for (const c of event.criteria ?? []) {
        criteria = upsertCriterion(criteria, c.id, (current) => ({
          ...current,
          text: c.text,
          method: c.method,
          ...(c.checkName === undefined ? {} : { checkName: c.checkName })
        }))
      }
      return {
        ...row({
          kind: "lifecycle",
          tone: "info",
          label: "Contract frozen",
          detail: `${event.criterionIds.length} ${event.criterionIds.length === 1 ? "criterion" : "criteria"} · ${
            event.contractHash.slice(0, 16)
          }`
        }),
        criteria,
        contractHash: event.contractHash,
        specHash: event.specHash
      }
    }

    case "fixtureReady":
      return {
        ...row({ kind: "lifecycle", tone: "neutral", label: `Fixture ready: ${event.fixtureName}` }),
        fixture: { name: event.fixtureName, publicValues: event.publicValues }
      }

    case "fixtureCleaned":
      return {
        ...row({
          kind: "lifecycle",
          tone: event.timedOut ? "warn" : "neutral",
          label: `Fixture cleaned: ${event.fixtureName}`,
          detail: `${event.cleanupsRun} finalizer(s)${event.timedOut ? " — timed out" : ""}`
        }),
        ...(base.fixture === undefined ? {} : {
          fixture: {
            ...base.fixture,
            cleaned: { cleanupsRun: event.cleanupsRun, timedOut: event.timedOut }
          }
        })
      }

    case "browserContextOpened":
      return {
        ...row({ kind: "lifecycle", tone: "neutral", label: "Browser context opened", detail: event.baseUrl }),
        baseUrl: event.baseUrl,
        capture: event.capture
      }

    case "observationTaken":
      return {
        ...row({
          kind: "observation",
          tone: "neutral",
          label: `Observation ${event.observationId}`,
          detail: `${event.title || "(untitled)"} — ${event.url} · ${event.elementCount} element(s)`
        }),
        observationCount: base.observationCount + 1
      }

    case "modelCallStarted":
      return {
        ...row({
          kind: "model",
          tone: "neutral",
          label: `Model call (${event.role})`,
          detail: `${event.provider} / ${event.model}`
        }),
        model: { ...base.model, started: base.model.started + 1 }
      }

    case "modelCallFinished": {
      const input = event.inputTokens ?? 0
      const output = event.outputTokens ?? 0
      return {
        ...row({
          kind: "model",
          tone: "neutral",
          label: `Model reply (${event.role})`,
          detail: `${input + output} tokens · ${event.toolCalls} tool call(s)${
            event.finishReason === undefined ? "" : ` · ${event.finishReason}`
          }`,
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs })
        }),
        model: {
          started: base.model.started,
          finished: base.model.finished + 1,
          inputTokens: base.model.inputTokens + input,
          outputTokens: base.model.outputTokens + output,
          verifierTokens: base.model.verifierTokens + (event.role === "verifier" ? input + output : 0)
        }
      }
    }

    case "actionStarted": {
      const view: ActionView = {
        seq: event.seq,
        actionId: event.actionId,
        tool: event.tool,
        params: event.params,
        ...(event.intent === undefined ? {} : { intent: event.intent })
      }
      const detailParts = [event.intent, describeParams(event.params)].filter(
        (p): p is string => p !== undefined && p.length > 0
      )
      return {
        ...row({
          kind: "action",
          tone: "neutral",
          label: `${event.actionId} · ${event.tool}`,
          actionId: event.actionId,
          ...(detailParts.length === 0 ? {} : { detail: detailParts.join(" — ") })
        }),
        actions: [...base.actions, view],
        actionCount: base.actionCount + 1
      }
    }

    case "actionFinished": {
      const actions = base.actions.map((a) =>
        a.actionId === event.actionId
          ? {
            ...a,
            outcome: event.outcome,
            ...(event.code === undefined ? {} : { code: event.code }),
            ...(event.message === undefined ? {} : { message: event.message })
          }
          : a
      )
      const outcomeText = event.outcome === "ok"
        ? "ok"
        : `error${event.code === undefined ? "" : ` (${event.code})`}${
          event.message === undefined ? "" : ` — ${truncate(event.message, 160)}`
        }`
      return {
        ...base,
        actions,
        timeline: closeTimelineRow(base.timeline, event.actionId, {
          outcome: outcomeText,
          tone: event.outcome === "ok" ? "ok" : "bad",
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs })
        })
      }
    }

    case "evidenceRequested":
      return {
        ...row({
          kind: "evidence",
          tone: "info",
          label: `Evidence requested · ${event.criterionId}`,
          criterionId: event.criterionId,
          detail: `by ${event.requestedBy}${event.note === undefined ? "" : ` — ${truncate(event.note)}`}`
        }),
        criteria: upsertCriterion(base.criteria, event.criterionId, (current) => ({
          ...current,
          evidenceRequested: true,
          ...(event.note === undefined ? {} : { note: event.note })
        }))
      }

    case "verificationFinished": {
      const result = event.result
      const tone = result.status === "passed" ? "ok" : result.status === "failed" ? "bad" : "warn"
      return {
        ...row({
          kind: "verification",
          tone,
          label: `Verification ${event.criterionId} — ${result.status}`,
          criterionId: event.criterionId,
          detail: truncate(result.observed),
          outcome: result.method === "code" ? "method: code" : "method: model",
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs })
        }),
        criteria: upsertCriterion(base.criteria, event.criterionId, (current) => ({
          ...current,
          status: result.status,
          method: result.method,
          result,
          ...(result.evaluator.kind === "code" ? { checkName: result.evaluator.checkName } : {})
        }))
      }
    }

    case "artifactAvailable": {
      const owner = actionAtSeq(base.actions, event.sourceSeq)
      const detail = event.state === "present" ? event.path : event.reason
      const view: ArtifactView = {
        seq: event.seq,
        ts: event.ts,
        artifactId: event.artifactId,
        kind: event.kind,
        state: event.state,
        ...(event.path === undefined ? {} : { path: event.path }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.sourceSeq === undefined ? {} : { sourceSeq: event.sourceSeq }),
        ...(owner === undefined ? {} : { actionId: owner.actionId, actionLabel: `${owner.actionId} · ${owner.tool}` })
      }
      return {
        ...row({
          kind: "artifact",
          tone: event.state === "present" ? "neutral" : "warn",
          label: `Artifact ${event.artifactId} (${event.kind}) — ${event.state}`,
          ...(detail === undefined ? {} : { detail }),
          ...(owner === undefined ? {} : { actionId: owner.actionId })
        }),
        artifacts: [...base.artifacts, view]
      }
    }

    case "actionGuidanceExceeded":
      return {
        ...row({
          kind: "guidance",
          tone: "info",
          label: "Indicative action threshold crossed",
          detail: `${event.rendering} — guidance only, no action refused, no status degraded`
        }),
        guidance: { used: event.used, guidance: event.guidance, rendering: event.rendering }
      }

    case "budgetExhausted":
      return {
        ...row({
          kind: "budget",
          tone: "bad",
          label: `Blocking budget exhausted: ${event.budget}`,
          detail: `${event.used} / ${event.limit}${event.detail === undefined ? "" : ` — ${event.detail}`}`
        }),
        budgetBreaches: [
          ...base.budgetBreaches,
          {
            budget: event.budget,
            limit: event.limit,
            used: event.used,
            ...(event.detail === undefined ? {} : { detail: event.detail })
          }
        ]
      }

    case "progressStalled":
      return {
        ...row({
          kind: "error",
          tone: "warn",
          label: "Progress stalled",
          detail: `${event.reason} · ${event.repeatedActions} repeated action(s)`
        }),
        stalls: [...base.stalls, { seq: event.seq, reason: event.reason, repeatedActions: event.repeatedActions }]
      }

    case "error":
      return {
        ...row({
          kind: "error",
          tone: event.fatal ? "bad" : "warn",
          label: `Error (${event.stage})${event.fatal ? " — fatal" : ""}`,
          detail: event.cause === undefined ? event.reason : `${event.reason} — ${truncate(event.cause)}`
        }),
        errors: [
          ...base.errors,
          {
            seq: event.seq,
            ts: event.ts,
            stage: event.stage,
            reason: event.reason,
            fatal: event.fatal,
            ...(event.cause === undefined ? {} : { cause: event.cause })
          }
        ]
      }

    case "cancellationRequested":
      return {
        ...row({
          kind: "lifecycle",
          tone: "warn",
          label: "Cancellation requested",
          detail: `${event.reason} (source: ${event.source})`
        }),
        cancellation: { reason: event.reason, source: event.source }
      }

    case "runFinished": {
      // Any criterion still pending when the run ends is unresolved, not silently passed.
      const criteria = base.criteria.map((c) =>
        c.status === "pending" ? { ...c, status: "inconclusive" as const } : c
      )
      return {
        ...row({
          kind: "lifecycle",
          tone: event.status === "passed" ? "ok" : event.status === "failed" ? "bad" : "warn",
          label: `Run finished — ${event.status}`,
          detail: `${event.criteriaCount} ${event.criteriaCount === 1 ? "criterion" : "criteria"}${
            event.failedCriteria.length === 0 ? "" : ` · failures: ${event.failedCriteria.join(", ")}`
          }`
        }),
        criteria,
        status: event.status,
        failedCriteria: event.failedCriteria,
        finishedAt: event.ts
      }
    }
  }
}
