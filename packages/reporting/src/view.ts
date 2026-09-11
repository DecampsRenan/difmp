import type {
  AbsenceBranch,
  ArtifactRecord,
  AttemptResult,
  Criterion,
  CriterionResult,
  CriterionStatus,
  HarnessEvent,
  ReportInput,
  RunStatus
} from "@harness/core"
import { renderActionGuidance } from "@harness/core"

/**
 * The one derived model the three reporters share. It is built from persisted data only —
 * `result.json`, `contract.json`, `artifacts.json`, `manifest.json`, `events.jsonl` — so
 * `harness report <run-directory>` reproduces it with no model call and no replay.
 */
export interface ReportView {
  readonly runId: string
  readonly scenarioId: string
  readonly specPath: string
  readonly status: RunStatus
  readonly statusLabel: string
  /** The run-level explanation: error reason, inconclusive detail, cancellation reason. */
  readonly statusDetail?: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly finalized: boolean
  readonly contractHash: string
  readonly model: { readonly provider: string; readonly modelId: string; readonly adapterId: string }
  readonly harnessVersion: string
  readonly nodeVersion: string
  readonly baseUrl: string
  readonly scenarioBody: string
  readonly attempts: ReadonlyArray<AttemptView>
  readonly criteria: ReadonlyArray<CriterionView>
  readonly timeline: ReadonlyArray<TimelineEntry>
  readonly artifacts: ReadonlyArray<ArtifactView>
  readonly artifactCounts: { readonly present: number; readonly missing: number; readonly failed: number }
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly counts: Readonly<Record<CriterionStatus, number>>
}

export interface AttemptView {
  readonly attemptId: string
  readonly status: AttemptResult["status"]
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  /** Indicative only. Never mixed into `budgets` — see design-contracts §7. */
  readonly actions: {
    readonly used: number
    readonly guidance: number
    readonly exceeded: boolean
    readonly rendering: string
  }
  /** The BLOCKING budgets, consumed vs remaining. */
  readonly budgets: ReadonlyArray<BudgetLine>
}

export interface BudgetLine {
  readonly key: string
  readonly label: string
  readonly used: number
  readonly limit: number
  readonly remaining: number
  readonly unit: "calls" | "tokens" | "ms"
  readonly note?: string
}

export interface CriterionView {
  readonly id: string
  /** The frozen contract text, verbatim. */
  readonly expectation: string
  readonly sourceText: string
  readonly location: string
  readonly contractHash: string
  readonly resultHash?: string
  /** True when the evaluated hash is not the contract's — the verdict may be bound to other text. */
  readonly hashMismatch: boolean
  readonly method: "model" | "code"
  readonly status: CriterionStatus
  readonly evaluatorKind: "model" | "scripted-model" | "code"
  readonly evaluatorLabel: string
  /** A textual evaluation is probabilistic; a `code` check is a deterministic assertion. */
  readonly probabilistic: boolean
  readonly expected?: string
  readonly observed?: string
  readonly limitations?: string
  readonly absence?: AbsenceBranch
  readonly evidence: ReadonlyArray<ArtifactView>
  /** Referenced ids with no matching inventory entry — surfaced, never silently dropped. */
  readonly danglingEvidence: ReadonlyArray<string>
  readonly evaluatedAtSeq?: number
  readonly attemptId?: string
}

export interface ArtifactView {
  readonly artifactId: string
  readonly attemptId: string
  readonly kind: string
  readonly label?: string
  readonly state: "present" | "missing" | "failed"
  /** Relative to the run directory, exactly as persisted. */
  readonly path?: string
  readonly reason?: string
  readonly bytes?: number
  readonly ts: string
  readonly sourceSeq?: number
}

export type TimelineCategory =
  | "lifecycle"
  | "observation"
  | "action"
  | "model"
  | "verification"
  | "evidence"
  | "artifact"
  | "guidance"
  | "budget"
  | "error"

export interface TimelineEntry {
  readonly seq: number
  readonly ts: string
  readonly attemptId?: string
  readonly durationMs?: number
  readonly type: HarnessEvent["type"]
  readonly category: TimelineCategory
  readonly title: string
  readonly fields: ReadonlyArray<{ readonly label: string; readonly value: string }>
}

export type DiagnosticSeverity = "info" | "warning" | "error"

/**
 * An interpretation, not an observed fact. Spec §9 requires the report to keep these apart from
 * the factual timeline and from the evaluations.
 */
export interface Diagnostic {
  readonly severity: DiagnosticSeverity
  readonly source: string
  readonly message: string
  readonly seq?: number
}

const statusLabels: Record<RunStatus, string> = {
  passed: "Réussi",
  failed: "Échoué",
  inconclusive: "Non concluant",
  error: "Erreur",
  cancelled: "Annulé"
}

export const runStatusLabel = (status: RunStatus): string => statusLabels[status]

const criterionStatusLabels: Record<CriterionStatus, string> = {
  pending: "En attente",
  passed: "Réussi",
  failed: "Échoué",
  inconclusive: "Non concluant",
  error: "Erreur"
}

export const criterionStatusLabel = (status: CriterionStatus): string => criterionStatusLabels[status]

const inconclusiveReasonLabels: Record<string, string> = {
  "unresolved-criteria": "critères non résolus",
  "insufficient-evidence": "preuves insuffisantes",
  "budget-exhausted": "budget bloquant épuisé"
}

const field = (label: string, value: unknown): { label: string; value: string } => ({
  label,
  value: value === undefined || value === null
    ? ""
    : typeof value === "string"
    ? value
    : JSON.stringify(value)
})

const eventCategories: Record<HarnessEvent["type"], TimelineCategory> = {
  runStarted: "lifecycle",
  configResolved: "lifecycle",
  contractFrozen: "lifecycle",
  fixtureReady: "lifecycle",
  fixtureCleaned: "lifecycle",
  browserContextOpened: "lifecycle",
  observationTaken: "observation",
  modelCallStarted: "model",
  modelCallFinished: "model",
  actionStarted: "action",
  actionFinished: "action",
  evidenceRequested: "evidence",
  verificationFinished: "verification",
  artifactAvailable: "artifact",
  actionGuidanceExceeded: "guidance",
  budgetExhausted: "budget",
  progressStalled: "error",
  error: "error",
  cancellationRequested: "error",
  runFinished: "lifecycle"
}

const describeEvent = (
  event: HarnessEvent
): { title: string; fields: ReadonlyArray<{ label: string; value: string }> } => {
  switch (event.type) {
    case "runStarted":
      return { title: "Run démarré", fields: [field("scénario", event.scenarioId), field("spec", event.specPath)] }
    case "configResolved":
      return {
        title: "Configuration résolue",
        fields: [field("baseUrl", event.config.baseUrl), field("fournisseur", event.config.provider)]
      }
    case "contractFrozen":
      return {
        title: "Contrat gelé",
        fields: [field("hash", event.contractHash), field("critères", event.criterionIds.join(", "))]
      }
    case "fixtureReady":
      return { title: "Fixture prête", fields: [field("fixture", event.fixtureName)] }
    case "fixtureCleaned":
      return {
        title: "Fixture nettoyée",
        fields: [field("fixture", event.fixtureName), field("timeout", event.timedOut)]
      }
    case "browserContextOpened":
      return {
        title: "Contexte navigateur ouvert",
        fields: [field("baseUrl", event.baseUrl), field("storageState", event.usedStorageState)]
      }
    case "observationTaken":
      return {
        title: "Observation",
        fields: [
          field("id", event.observationId),
          field("url", event.url),
          field("titre", event.title),
          field("éléments", event.elementCount)
        ]
      }
    case "modelCallStarted":
      return {
        title: `Appel modèle (${event.role})`,
        fields: [field("modèle", `${event.provider}/${event.model}`), field("callId", event.callId)]
      }
    case "modelCallFinished":
      return {
        title: `Appel modèle terminé (${event.role})`,
        fields: [
          field("tokens entrée", event.inputTokens),
          field("tokens sortie", event.outputTokens),
          field("outils", event.toolCalls),
          field("fin", event.finishReason)
        ]
      }
    case "actionStarted":
      return {
        title: `Action ${event.tool}`,
        fields: [field("id", event.actionId), field("intention", event.intent), field("params", event.params)]
      }
    case "actionFinished":
      return {
        title: `Action ${event.tool} — ${event.outcome}`,
        fields: [field("id", event.actionId), field("code", event.code), field("message", event.message)]
      }
    case "evidenceRequested":
      return {
        title: "Preuve demandée",
        fields: [field("critère", event.criterionId), field("par", event.requestedBy), field("note", event.note)]
      }
    case "verificationFinished":
      return {
        title: `Vérification ${event.criterionId} — ${event.result.status}`,
        fields: [
          field("méthode", event.result.method),
          field("évaluateur", event.result.evaluator.kind),
          field("preuves", event.result.evidence.join(", "))
        ]
      }
    case "artifactAvailable":
      return {
        title: `Artefact ${event.artifactId} (${event.state})`,
        fields: [field("type", event.kind), field("chemin", event.path), field("raison", event.reason)]
      }
    case "actionGuidanceExceeded":
      return { title: "Seuil indicatif d'actions dépassé", fields: [field("compte", event.rendering)] }
    case "budgetExhausted":
      return {
        title: `Budget bloquant épuisé : ${event.budget}`,
        fields: [field("utilisé", event.used), field("limite", event.limit), field("détail", event.detail)]
      }
    case "progressStalled":
      return {
        title: "Progression bloquée",
        fields: [field("raison", event.reason), field("actions répétées", event.repeatedActions)]
      }
    case "error":
      return {
        title: `Erreur (${event.stage})`,
        fields: [field("raison", event.reason), field("fatale", event.fatal), field("cause", event.cause)]
      }
    case "cancellationRequested":
      return { title: "Annulation demandée", fields: [field("raison", event.reason), field("source", event.source)] }
    case "runFinished":
      return {
        title: `Run terminé — ${event.status}`,
        fields: [field("critères", event.criteriaCount), field("échoués", event.failedCriteria.join(", "))]
      }
  }
}

const toArtifactView = (record: ArtifactRecord): ArtifactView => ({
  artifactId: record.artifactId,
  attemptId: record.attemptId,
  kind: record.kind,
  state: record.state,
  ts: record.ts,
  ...(record.label === undefined ? {} : { label: record.label }),
  ...(record.path === undefined ? {} : { path: record.path }),
  ...(record.reason === undefined ? {} : { reason: record.reason }),
  ...(record.bytes === undefined ? {} : { bytes: record.bytes }),
  ...(record.sourceSeq === undefined ? {} : { sourceSeq: record.sourceSeq })
})

const evaluatorLabel = (evaluator: CriterionResult["evaluator"]): string => {
  switch (evaluator.kind) {
    case "model":
      return `modèle ${evaluator.provider}/${evaluator.model}`
    case "scripted-model":
      // Named explicitly so a deterministic double is never read as a real model judgement.
      return "double scripté déterministe (pas un jugement de modèle réel)"
    case "code":
      return `check TypeScript « ${evaluator.checkName} »`
  }
}

const budgetLines = (attempt: AttemptResult, budgets: ReportInput["contract"]["budgets"]): ReadonlyArray<BudgetLine> => {
  const tokens = attempt.model.inputTokens + attempt.model.outputTokens
  return [
    {
      key: "maxModelCalls",
      label: "Appels modèle",
      used: attempt.model.calls,
      limit: budgets.maxModelCalls,
      remaining: budgets.maxModelCalls - attempt.model.calls,
      unit: "calls"
    },
    {
      key: "maxTokens",
      label: "Tokens",
      used: tokens,
      limit: budgets.maxTokens,
      remaining: budgets.maxTokens - tokens,
      unit: "tokens",
      note: `dont ${attempt.model.verifierTokens} pour le vérificateur ; ` +
        `réserve vérificateur retenue : ${budgets.verifierReserveTokens}`
    },
    {
      key: "attemptTimeoutMs",
      label: "Durée de la tentative",
      used: attempt.durationMs,
      limit: budgets.attemptTimeoutMs,
      remaining: budgets.attemptTimeoutMs - attempt.durationMs,
      unit: "ms"
    }
  ]
}

const collectDiagnostics = (input: ReportInput, criteria: ReadonlyArray<CriterionView>): ReadonlyArray<Diagnostic> => {
  const out: Array<Diagnostic> = []
  const { events, inventory, result } = input

  if (!input.finalized) {
    out.push({
      severity: "warning",
      source: "journal",
      message: "Le journal ne se termine pas sur un `runFinished` intact : l'exécution n'a pas été finalisée " +
        "et ce rapport peut être incomplet."
    })
  }
  if (result.status === "error") {
    out.push({ severity: "error", source: `étape ${result.stage}`, message: result.reason })
  }
  if (result.status === "cancelled") {
    out.push({ severity: "warning", source: "annulation", message: result.reason })
  }
  if (result.status === "inconclusive") {
    out.push({
      severity: "warning",
      source: `non concluant (${inconclusiveReasonLabels[result.reason] ?? result.reason})`,
      message: result.detail ?? "aucun détail enregistré"
    })
  }
  for (const event of events) {
    if (event.type === "error") {
      out.push({
        severity: event.fatal ? "error" : "warning",
        source: `événement error / ${event.stage}`,
        message: event.cause === undefined ? event.reason : `${event.reason} (${event.cause})`,
        seq: event.seq
      })
    } else if (event.type === "budgetExhausted") {
      out.push({
        severity: "warning",
        source: `budget ${event.budget}`,
        message: `${event.used}/${event.limit}${event.detail === undefined ? "" : ` — ${event.detail}`}`,
        seq: event.seq
      })
    } else if (event.type === "progressStalled") {
      out.push({
        severity: "warning",
        source: "progression",
        message: `${event.reason} (${event.repeatedActions} actions répétées)`,
        seq: event.seq
      })
    }
  }
  for (const criterion of criteria) {
    if (criterion.limitations !== undefined) {
      out.push({ severity: "info", source: `limite ${criterion.id}`, message: criterion.limitations })
    }
    if (criterion.hashMismatch) {
      out.push({
        severity: "error",
        source: `hash ${criterion.id}`,
        message: `Le hash évalué (${criterion.resultHash ?? "absent"}) ne correspond pas au hash du contrat ` +
          `(${criterion.contractHash}) : le verdict peut porter sur un autre texte.`
      })
    }
    if (criterion.danglingEvidence.length > 0) {
      out.push({
        severity: "error",
        source: `preuves ${criterion.id}`,
        message: `Références de preuve absentes de l'inventaire : ${criterion.danglingEvidence.join(", ")}.`
      })
    }
  }
  for (const artifact of inventory.artifacts) {
    if (artifact.state !== "present") {
      out.push({
        severity: artifact.state === "failed" ? "error" : "warning",
        source: `artefact ${artifact.artifactId} (${artifact.state})`,
        message: artifact.reason ?? "aucune raison enregistrée"
      })
    }
  }
  return out
}

export const buildReportView = (input: ReportInput): ReportView => {
  const { contract, inventory, manifest, result } = input

  const artifacts = inventory.artifacts.map(toArtifactView)
  const artifactsById = new Map(artifacts.map((a) => [a.artifactId, a]))

  const criterionResults = new Map<string, { result: CriterionResult; attemptId: string }>()
  for (const attempt of result.attempts) {
    for (const criterion of attempt.criteria) {
      criterionResults.set(criterion.criterionId, { result: criterion, attemptId: attempt.attemptId })
    }
  }

  const criteria = contract.criteria.map((criterion: Criterion): CriterionView => {
    const found = criterionResults.get(criterion.id)
    const contractHash = contract.hashes.criteria[criterion.id] ?? ""
    const evidence: Array<ArtifactView> = []
    const dangling: Array<string> = []
    for (const id of found?.result.evidence ?? []) {
      const artifact = artifactsById.get(id)
      if (artifact === undefined) dangling.push(id)
      else evidence.push(artifact)
    }
    const evaluator = found?.result.evaluator
    return {
      id: criterion.id,
      expectation: criterion.text,
      sourceText: criterion.sourceText,
      location: `${contract.specPath}:${criterion.line}:${criterion.column}`,
      contractHash,
      hashMismatch: found !== undefined && contractHash !== "" && found.result.criterionHash !== contractHash,
      method: criterion.method,
      status: found?.result.status ?? "pending",
      evaluatorKind: evaluator?.kind ?? (criterion.method === "code" ? "code" : "model"),
      evaluatorLabel: evaluator === undefined ? "non évalué" : evaluatorLabel(evaluator),
      probabilistic: criterion.method === "model",
      evidence,
      danglingEvidence: dangling,
      ...(found === undefined ? {} : {
        resultHash: found.result.criterionHash,
        expected: found.result.expected,
        observed: found.result.observed,
        evaluatedAtSeq: found.result.evaluatedAtSeq,
        attemptId: found.attemptId
      }),
      ...(found?.result.limitations === undefined ? {} : { limitations: found.result.limitations }),
      ...(found?.result.absence === undefined ? {} : { absence: found.result.absence })
    }
  })

  const counts: Record<CriterionStatus, number> = {
    pending: 0,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    error: 0
  }
  for (const criterion of criteria) counts[criterion.status] += 1

  const attempts = result.attempts.map((attempt): AttemptView => ({
    attemptId: attempt.attemptId,
    status: attempt.status,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    durationMs: attempt.durationMs,
    actions: {
      used: attempt.actions.used,
      guidance: attempt.actions.guidance,
      exceeded: attempt.actions.guidanceExceeded,
      rendering: renderActionGuidance(attempt.actions.used, attempt.actions.guidance)
    },
    budgets: budgetLines(attempt, contract.budgets)
  }))

  const timeline = input.events.map((event): TimelineEntry => {
    const described = describeEvent(event)
    return {
      seq: event.seq,
      ts: event.ts,
      type: event.type,
      category: eventCategories[event.type],
      title: described.title,
      fields: described.fields.filter((f) => f.value !== ""),
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs })
    }
  })

  const statusDetail = result.status === "error"
    ? `${result.stage} : ${result.reason}`
    : result.status === "cancelled"
    ? result.reason
    : result.status === "inconclusive"
    ? `${inconclusiveReasonLabels[result.reason] ?? result.reason}${
      result.detail === undefined ? "" : ` — ${result.detail}`
    }`
    : result.status === "failed"
    ? `critères en échec : ${result.failedCriteria.join(", ")}`
    : undefined

  return {
    runId: result.runId,
    scenarioId: result.scenarioId,
    specPath: result.specPath,
    status: result.status,
    statusLabel: runStatusLabel(result.status),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    finalized: input.finalized,
    contractHash: result.contractHash,
    model: manifest.model,
    harnessVersion: manifest.harnessVersion,
    nodeVersion: manifest.nodeVersion,
    baseUrl: manifest.config.baseUrl,
    scenarioBody: contract.body,
    attempts,
    criteria,
    timeline,
    artifacts,
    artifactCounts: {
      present: artifacts.filter((a) => a.state === "present").length,
      missing: artifacts.filter((a) => a.state === "missing").length,
      failed: artifacts.filter((a) => a.state === "failed").length
    },
    diagnostics: collectDiagnostics(input, criteria),
    counts,
    ...(statusDetail === undefined ? {} : { statusDetail })
  }
}
