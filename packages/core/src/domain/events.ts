import { Schema } from "effect"
import { CaptureConfig, ResolvedConfig } from "./config.js"
import { BudgetKind, RunStage } from "./errors.js"
import { ActionId, ArtifactId, AttemptId, CriterionId, ObservationId, RunId } from "./ids.js"
import { CriterionResult, RunStatus } from "./result.js"
import { InputsRecord } from "./spec.js"
import { ToolErrorCode, ToolName } from "./tools.js"

export const ModelRole = Schema.Literals(["browser", "verifier"])
export type ModelRole = typeof ModelRole["Type"]

/** Envelope shared by every journal line. `seq` increases by exactly 1 per run. */
const envelope = {
  schemaVersion: Schema.Literal(1),
  seq: Schema.Int,
  runId: RunId,
  attemptId: Schema.optionalKey(AttemptId),
  ts: Schema.String,
  durationMs: Schema.optionalKey(Schema.Int)
}

const event = <const T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ ...envelope, type: Schema.tag(type), ...fields })

export const RunStartedEvent = event("runStarted", {
  specPath: Schema.String,
  scenarioId: Schema.String,
  harnessVersion: Schema.String
})

export const ConfigResolvedEvent = event("configResolved", {
  config: ResolvedConfig,
  configPath: Schema.optionalKey(Schema.String)
})

export const ContractFrozenEvent = event("contractFrozen", {
  contractHash: Schema.String,
  specHash: Schema.String,
  criterionIds: Schema.Array(CriterionId)
})

export const FixtureReadyEvent = event("fixtureReady", {
  fixtureName: Schema.String,
  /** Public values only. `storageState` and secrets never reach the journal. */
  publicValues: InputsRecord
})

export const FixtureCleanedEvent = event("fixtureCleaned", {
  fixtureName: Schema.String,
  cleanupsRun: Schema.Int,
  /** True when the bounded cleanup deadline fired before every finalizer completed. */
  timedOut: Schema.Boolean
})

export const BrowserContextOpenedEvent = event("browserContextOpened", {
  baseUrl: Schema.String,
  usedStorageState: Schema.Boolean,
  capture: CaptureConfig
})

export const ObservationTakenEvent = event("observationTaken", {
  observationId: ObservationId,
  url: Schema.String,
  title: Schema.String,
  elementCount: Schema.Int
})

export const ModelCallStartedEvent = event("modelCallStarted", {
  role: ModelRole,
  callId: Schema.String,
  provider: Schema.String,
  model: Schema.String
})

export const ModelCallFinishedEvent = event("modelCallFinished", {
  role: ModelRole,
  callId: Schema.String,
  inputTokens: Schema.optionalKey(Schema.Int),
  outputTokens: Schema.optionalKey(Schema.Int),
  toolCalls: Schema.Int,
  finishReason: Schema.optionalKey(Schema.String)
})

export const ActionStartedEvent = event("actionStarted", {
  actionId: ActionId,
  tool: ToolName,
  params: Schema.Record(Schema.String, Schema.Unknown),
  intent: Schema.optionalKey(Schema.String)
})

export const ActionFinishedEvent = event("actionFinished", {
  actionId: ActionId,
  tool: ToolName,
  outcome: Schema.Literals(["ok", "error"]),
  code: Schema.optionalKey(ToolErrorCode),
  message: Schema.optionalKey(Schema.String)
})

export const EvidenceRequestedEvent = event("evidenceRequested", {
  criterionId: CriterionId,
  requestedBy: Schema.Literals(["agent", "verifier", "runner"]),
  note: Schema.optionalKey(Schema.String)
})

export const VerificationFinishedEvent = event("verificationFinished", {
  criterionId: CriterionId,
  result: CriterionResult,
  /**
   * Present when the evaluation that just ran is NOT what got recorded — a later `check` on a
   * criterion that had already reached a terminal verdict. It names the rule that was applied.
   */
  note: Schema.optionalKey(Schema.String)
})

export const ArtifactAvailableEvent = event("artifactAvailable", {
  artifactId: ArtifactId,
  kind: Schema.String,
  state: Schema.Literals(["present", "missing", "failed"]),
  path: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  sourceSeq: Schema.optionalKey(Schema.Int)
})

/** Emitted EXACTLY ONCE, on the first crossing. Nothing is refused and no status is degraded. */
export const ActionGuidanceExceededEvent = event("actionGuidanceExceeded", {
  used: Schema.Int,
  guidance: Schema.Int,
  /** Ready-to-display rendering, e.g. `28 actions / 25 suggested`. */
  rendering: Schema.String
})

export const BudgetExhaustedEvent = event("budgetExhausted", {
  budget: BudgetKind,
  limit: Schema.Number,
  used: Schema.Number,
  detail: Schema.optionalKey(Schema.String)
})

export const ProgressStalledEvent = event("progressStalled", {
  reason: Schema.String,
  repeatedActions: Schema.Int
})

export const ErrorEvent = event("error", {
  stage: RunStage,
  reason: Schema.String,
  fatal: Schema.Boolean,
  cause: Schema.optionalKey(Schema.String)
})

export const CancellationRequestedEvent = event("cancellationRequested", {
  reason: Schema.String,
  source: Schema.Literals(["user", "signal", "api"])
})

export const RunFinishedEvent = event("runFinished", {
  status: RunStatus,
  criteriaCount: Schema.Int,
  failedCriteria: Schema.Array(CriterionId)
})

/** Exhaustive — every type listed in design-contracts §6. */
export const HarnessEvent = Schema.Union([
  RunStartedEvent,
  ConfigResolvedEvent,
  ContractFrozenEvent,
  FixtureReadyEvent,
  FixtureCleanedEvent,
  BrowserContextOpenedEvent,
  ObservationTakenEvent,
  ModelCallStartedEvent,
  ModelCallFinishedEvent,
  ActionStartedEvent,
  ActionFinishedEvent,
  EvidenceRequestedEvent,
  VerificationFinishedEvent,
  ArtifactAvailableEvent,
  ActionGuidanceExceededEvent,
  BudgetExhaustedEvent,
  ProgressStalledEvent,
  ErrorEvent,
  CancellationRequestedEvent,
  RunFinishedEvent
]).annotate({ identifier: "HarnessEvent" })

export type HarnessEvent = typeof HarnessEvent["Type"]
export type HarnessEventType = HarnessEvent["type"]

export const harnessEventTypes: ReadonlyArray<HarnessEventType> = [
  "runStarted",
  "configResolved",
  "contractFrozen",
  "fixtureReady",
  "fixtureCleaned",
  "browserContextOpened",
  "observationTaken",
  "modelCallStarted",
  "modelCallFinished",
  "actionStarted",
  "actionFinished",
  "evidenceRequested",
  "verificationFinished",
  "artifactAvailable",
  "actionGuidanceExceeded",
  "budgetExhausted",
  "progressStalled",
  "error",
  "cancellationRequested",
  "runFinished"
]

/**
 * What a caller hands to `RunStore.emit`: the envelope fields owned by the single serialised
 * writer (`schemaVersion`, `seq`, `runId`, `ts`) are stamped there, never by the producer.
 */
export type HarnessEventInput = HarnessEvent extends infer E
  ? E extends HarnessEvent ? Omit<E, "schemaVersion" | "seq" | "runId" | "ts">
  : never
  : never
