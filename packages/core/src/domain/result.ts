import { Schema } from "effect"
import { ResolvedConfig } from "./config.js"
import { RunStage } from "./errors.js"
import { ArtifactId, AttemptId, CriterionId, RunId } from "./ids.js"
import { ContractHashes, CriterionMethod } from "./spec.js"

export const CriterionStatus = Schema.Literals(["pending", "passed", "failed", "inconclusive", "error"])
export type CriterionStatus = typeof CriterionStatus["Type"]

export const RunStatus = Schema.Literals(["passed", "failed", "inconclusive", "error", "cancelled"])
export type RunStatus = typeof RunStatus["Type"]

/** `scripted-model` marks the deterministic test double so it is never read as a real judgement. */
export const Evaluator = Schema.Union([
  Schema.Struct({ kind: Schema.tag("model"), provider: Schema.String, model: Schema.String }),
  Schema.Struct({ kind: Schema.tag("scripted-model") }),
  Schema.Struct({ kind: Schema.tag("code"), checkName: Schema.String })
]).annotate({ identifier: "Evaluator" })
export type Evaluator = typeof Evaluator["Type"]

/** Which branch of the absence rule produced this verdict — recorded, never implicit. */
export const AbsenceBranch = Schema.Literals(["uncertain-navigation", "established-at-checkpoint"])
export type AbsenceBranch = typeof AbsenceBranch["Type"]

/**
 * Why the harness refused to keep the status the evaluator proposed. A downgrade is always
 * recorded so a report can say WHY the harness would not conclude, instead of showing a bare
 * `inconclusive`.
 */
export const DowngradeReason = Schema.Literals([
  "rejected-evidence",
  "absence-uncertain-navigation",
  "evidence-persistence-failed",
  "verdict-already-decided"
])
export type DowngradeReason = typeof DowngradeReason["Type"]

export const CriterionDowngrade = Schema.Struct({
  reason: DowngradeReason,
  /** The status the evaluator proposed. */
  from: CriterionStatus,
  /** The status the harness recorded instead. */
  to: CriterionStatus,
  detail: Schema.String
}).annotate({ identifier: "CriterionDowngrade" })
export type CriterionDowngrade = typeof CriterionDowngrade["Type"]

/**
 * A later evaluation of a criterion that had already reached a terminal verdict. It is kept as an
 * observation — spec §9 forbids losing it — and `applied` says whether it replaced the recorded
 * status. A verdict is only ever replaced toward a WORSE status: asking again never upgrades.
 */
export const CriterionReCheck = Schema.Struct({
  status: CriterionStatus,
  observed: Schema.String,
  evidence: Schema.Array(ArtifactId),
  requestedBy: Schema.Literals(["agent", "runner"]),
  evaluatedAtSeq: Schema.Int,
  applied: Schema.Boolean,
  note: Schema.String
}).annotate({ identifier: "CriterionReCheck" })
export type CriterionReCheck = typeof CriterionReCheck["Type"]

export const CriterionResult = Schema.Struct({
  criterionId: CriterionId,
  criterionHash: Schema.String,
  status: CriterionStatus,
  method: CriterionMethod,
  evaluator: Evaluator,
  expected: Schema.String,
  observed: Schema.String,
  /** artifactIds; every one MUST exist and belong to this attempt or the criterion is forced inconclusive. */
  evidence: Schema.Array(ArtifactId),
  limitations: Schema.optionalKey(Schema.String),
  absence: Schema.optionalKey(AbsenceBranch),
  /** Every status change the harness imposed on the evaluator's answer, in order. */
  downgrades: Schema.optionalKey(Schema.Array(CriterionDowngrade)),
  /** Later evaluations of an already decided criterion, kept as observations. */
  reChecks: Schema.optionalKey(Schema.Array(CriterionReCheck)),
  evaluatedAtSeq: Schema.Int
}).annotate({ identifier: "CriterionResult" })
export type CriterionResult = typeof CriterionResult["Type"]

export const ActionAccounting = Schema.Struct({
  used: Schema.Int,
  /** The INDICATIVE threshold. Exceeding it is a signal, never a refusal. */
  guidance: Schema.Int,
  guidanceExceeded: Schema.Boolean
}).annotate({ identifier: "ActionAccounting" })
export type ActionAccounting = typeof ActionAccounting["Type"]

export const ModelAccounting = Schema.Struct({
  calls: Schema.Int,
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  /** Tokens consumed by the verifier — counted, and covered by the withheld reserve. */
  verifierTokens: Schema.Int
}).annotate({ identifier: "ModelAccounting" })
export type ModelAccounting = typeof ModelAccounting["Type"]

const attemptBase = {
  attemptId: AttemptId,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  durationMs: Schema.Int,
  criteria: Schema.Array(CriterionResult),
  actions: ActionAccounting,
  model: ModelAccounting,
  artifacts: Schema.Array(ArtifactId)
}

export const InconclusiveReason = Schema.Literals([
  "unresolved-criteria",
  "insufficient-evidence",
  "budget-exhausted"
])
export type InconclusiveReason = typeof InconclusiveReason["Type"]

/** One execution of a run. Individual criterion statuses survive even when the aggregate is `error`. */
export const AttemptResult = Schema.Union([
  Schema.Struct({ ...attemptBase, status: Schema.tag("passed") }),
  Schema.Struct({
    ...attemptBase,
    status: Schema.tag("failed"),
    failedCriteria: Schema.Array(CriterionId)
  }),
  Schema.Struct({
    ...attemptBase,
    status: Schema.tag("inconclusive"),
    reason: InconclusiveReason,
    detail: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({
    ...attemptBase,
    status: Schema.tag("error"),
    stage: RunStage,
    reason: Schema.String
  }),
  Schema.Struct({
    ...attemptBase,
    status: Schema.tag("cancelled"),
    reason: Schema.String
  })
]).annotate({ identifier: "AttemptResult" })
export type AttemptResult = typeof AttemptResult["Type"]

const runBase = {
  schemaVersion: Schema.Literal(1),
  runId: RunId,
  specPath: Schema.String,
  scenarioId: Schema.String,
  contractHash: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  durationMs: Schema.Int,
  attempts: Schema.Array(AttemptResult),
  /** False when the journal ends on a truncated line — the run was interrupted. */
  finalized: Schema.Boolean
}

export const RunResult = Schema.Union([
  Schema.Struct({ ...runBase, status: Schema.tag("passed") }),
  Schema.Struct({ ...runBase, status: Schema.tag("failed"), failedCriteria: Schema.Array(CriterionId) }),
  Schema.Struct({
    ...runBase,
    status: Schema.tag("inconclusive"),
    reason: InconclusiveReason,
    detail: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({ ...runBase, status: Schema.tag("error"), stage: RunStage, reason: Schema.String }),
  Schema.Struct({ ...runBase, status: Schema.tag("cancelled"), reason: Schema.String })
]).annotate({ identifier: "RunResult" })
export type RunResult = typeof RunResult["Type"]

export const ModelIdentity = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  /** Which adapter actually ran. A scripted run is never presented as a model validation. */
  adapterId: Schema.String
}).annotate({ identifier: "ModelIdentity" })
export type ModelIdentity = typeof ModelIdentity["Type"]

/**
 * Which of the two writes of `manifest.json` produced this file.
 *
 * `initial` is written at spec §6 step 2, right after the ids are minted and BEFORE fixture setup
 * and the contract freeze — so a run that dies during infrastructure setup still has a record of
 * which adapter and which configuration were in play. `final` replaces it once the contract is
 * frozen and adds `hashes`.
 */
export const ManifestStage = Schema.Literals(["initial", "final"])
export type ManifestStage = typeof ManifestStage["Type"]

/** `manifest.json` — the sole source of "which adapter was used" for the reporter. */
export const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  /** `initial` = written before the contract existed; `final` = enriched after the freeze. */
  stage: ManifestStage,
  runId: RunId,
  createdAt: Schema.String,
  specPath: Schema.String,
  scenarioId: Schema.String,
  harnessVersion: Schema.String,
  nodeVersion: Schema.String,
  dependencies: Schema.Record(Schema.String, Schema.String),
  model: ModelIdentity,
  /** Resolved, non-sensitive configuration. */
  config: ResolvedConfig,
  /** Absent on an `initial` manifest: nothing has been frozen yet, so there is nothing to hash. */
  hashes: Schema.optionalKey(ContractHashes)
}).annotate({ identifier: "Manifest" })
export type Manifest = typeof Manifest["Type"]

export const ArtifactState = Schema.Literals(["present", "missing", "failed"])
export type ArtifactState = typeof ArtifactState["Type"]

export const ArtifactKind = Schema.Literals([
  "screenshot",
  "aria-snapshot",
  "trace",
  "video",
  "console-log",
  "network-log",
  "probe-result",
  "check-evidence"
])
export type ArtifactKind = typeof ArtifactKind["Type"]

export const ArtifactRecord = Schema.Struct({
  artifactId: ArtifactId,
  attemptId: AttemptId,
  kind: ArtifactKind,
  label: Schema.optionalKey(Schema.String),
  /** Relative to the run directory. Absent when the capture never produced a file. */
  path: Schema.optionalKey(Schema.String),
  state: ArtifactState,
  /** Why an expected artifact is missing or failed. A capture failure is never hidden. */
  reason: Schema.optionalKey(Schema.String),
  bytes: Schema.optionalKey(Schema.Int),
  ts: Schema.String,
  sourceSeq: Schema.optionalKey(Schema.Int)
}).annotate({ identifier: "ArtifactRecord" })
export type ArtifactRecord = typeof ArtifactRecord["Type"]

export const ArtifactInventory = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runId: RunId,
  artifacts: Schema.Array(ArtifactRecord)
}).annotate({ identifier: "ArtifactInventory" })
export type ArtifactInventory = typeof ArtifactInventory["Type"]
