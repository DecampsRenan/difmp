/**
 * LOCAL MIRROR of `packages/core/src/domain/events.ts` (design-contracts §6).
 *
 * Why a mirror and not `import type { HarnessEvent } from "@harness/core"`: `@harness/core` is not
 * a dependency of `@harness/ui` and adding one requires a `pnpm install` this lane is not allowed
 * to run. The shapes below are transcribed field-for-field from the core schemas; `Schema.optionalKey`
 * becomes `?`, `Schema.Literals([...])` becomes a string-literal union. If core changes an event,
 * this file must change with it — `packages/core/src/domain/events.ts` remains authoritative.
 */
export type RunId = string;
export type AttemptId = string;
export type ActionId = string;
export type ObservationId = string;
export type ArtifactId = string;
export type CriterionId = string;
export type ModelRole = "browser" | "verifier";
export type CriterionMethod = "model" | "code";
export type CriterionStatus = "pending" | "passed" | "failed" | "inconclusive" | "error";
export type RunStatus = "passed" | "failed" | "inconclusive" | "error" | "cancelled";
export type ArtifactState = "present" | "missing" | "failed";
export type AbsenceBranch = "uncertain-navigation" | "established-at-checkpoint";
export type InputValue = string | number | boolean;
export type ToolName = "observe" | "navigate" | "click" | "fill" | "press" | "scroll" | "screenshot" | "check" | "finish";
export type ToolErrorCode = "invalid-params" | "stale-observation" | "unknown-reference" | "ambiguous-reference" | "origin-not-allowed" | "unknown-criterion" | "operation-failed" | "run-finished";
export type BudgetKind = "attemptTimeout" | "operationTimeout" | "maxModelCalls" | "maxTokens";
export type RunStage = "validate" | "manifest" | "fixture-setup" | "contract" | "browser" | "capture" | "agent-loop" | "verification" | "evidence" | "aggregate" | "fixture-cleanup" | "report";
export type Evaluator = {
    readonly kind: "model";
    readonly provider: string;
    readonly model: string;
} | {
    readonly kind: "scripted-model";
} | {
    readonly kind: "code";
    readonly checkName: string;
};
export interface CriterionResult {
    readonly criterionId: CriterionId;
    readonly criterionHash: string;
    readonly status: CriterionStatus;
    readonly method: CriterionMethod;
    readonly evaluator: Evaluator;
    readonly expected: string;
    readonly observed: string;
    readonly evidence: ReadonlyArray<ArtifactId>;
    readonly limitations?: string;
    readonly absence?: AbsenceBranch;
    readonly evaluatedAtSeq: number;
}
export interface Budgets {
    readonly attemptTimeoutMs: number;
    readonly operationTimeoutMs: number;
    readonly maxModelCalls: number;
    readonly maxTokens: number;
    readonly verifierReserveTokens: number;
    readonly fixtureCleanupTimeoutMs: number;
}
export interface CaptureConfig {
    readonly trace: "on" | "off";
    readonly video: "on" | "off";
    readonly screenshots: "checkpoints" | "every-action" | "off";
    readonly retainTraceOn: "all" | "failure";
}
export interface ResolvedConfig {
    readonly include: ReadonlyArray<string>;
    readonly exclude: ReadonlyArray<string>;
    readonly baseUrl: string;
    readonly allowedOrigins: ReadonlyArray<string>;
    readonly inputs: Readonly<Record<string, InputValue>>;
    readonly provider: "scripted" | "anthropic";
    readonly model?: string;
    readonly providerOptions: Readonly<Record<string, unknown>>;
    readonly maxActions: number;
    readonly budgets: Budgets;
    readonly capture: CaptureConfig;
    readonly outputDir: string;
    readonly reporters: ReadonlyArray<"console" | "json" | "junit" | "html">;
}
/** Envelope shared by every journal line. `seq` increases by exactly 1 per run. */
export interface EventEnvelope {
    readonly schemaVersion: 1;
    readonly seq: number;
    readonly runId: RunId;
    readonly attemptId?: AttemptId;
    readonly ts: string;
    readonly durationMs?: number;
}
type Ev<T extends string, F> = EventEnvelope & {
    readonly type: T;
} & F;
export type RunStartedEvent = Ev<"runStarted", {
    readonly specPath: string;
    readonly scenarioId: string;
    readonly harnessVersion: string;
}>;
export type ConfigResolvedEvent = Ev<"configResolved", {
    readonly config: ResolvedConfig;
    readonly configPath?: string;
}>;
export type ContractFrozenEvent = Ev<"contractFrozen", {
    readonly contractHash: string;
    readonly specHash: string;
    readonly criterionIds: ReadonlyArray<CriterionId>;
    /**
     * NOT in core today. `contractFrozen` carries ids only, so the live view cannot show criterion
     * text or `model` vs `code` from the stream alone — it fetches `contractUrl` for that. Accepted
     * here so that if core ever widens the event, the UI picks the detail up without a change.
     */
    readonly criteria?: ReadonlyArray<{
        readonly id: CriterionId;
        readonly text: string;
        readonly method: CriterionMethod;
        readonly checkName?: string;
    }>;
}>;
export type FixtureReadyEvent = Ev<"fixtureReady", {
    readonly fixtureName: string;
    readonly publicValues: Readonly<Record<string, InputValue>>;
}>;
export type FixtureCleanedEvent = Ev<"fixtureCleaned", {
    readonly fixtureName: string;
    readonly cleanupsRun: number;
    readonly timedOut: boolean;
}>;
export type BrowserContextOpenedEvent = Ev<"browserContextOpened", {
    readonly baseUrl: string;
    readonly usedStorageState: boolean;
    readonly capture: CaptureConfig;
}>;
export type ObservationTakenEvent = Ev<"observationTaken", {
    readonly observationId: ObservationId;
    readonly url: string;
    readonly title: string;
    readonly elementCount: number;
}>;
export type ModelCallStartedEvent = Ev<"modelCallStarted", {
    readonly role: ModelRole;
    readonly callId: string;
    readonly provider: string;
    readonly model: string;
}>;
export type ModelCallFinishedEvent = Ev<"modelCallFinished", {
    readonly role: ModelRole;
    readonly callId: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly toolCalls: number;
    readonly finishReason?: string;
}>;
export type ActionStartedEvent = Ev<"actionStarted", {
    readonly actionId: ActionId;
    readonly tool: ToolName;
    readonly params: Readonly<Record<string, unknown>>;
    readonly intent?: string;
}>;
export type ActionFinishedEvent = Ev<"actionFinished", {
    readonly actionId: ActionId;
    readonly tool: ToolName;
    readonly outcome: "ok" | "error";
    readonly code?: ToolErrorCode;
    readonly message?: string;
}>;
export type EvidenceRequestedEvent = Ev<"evidenceRequested", {
    readonly criterionId: CriterionId;
    readonly requestedBy: "agent" | "verifier" | "runner";
    readonly note?: string;
}>;
export type VerificationFinishedEvent = Ev<"verificationFinished", {
    readonly criterionId: CriterionId;
    readonly result: CriterionResult;
}>;
export type ArtifactAvailableEvent = Ev<"artifactAvailable", {
    readonly artifactId: ArtifactId;
    readonly kind: string;
    readonly state: ArtifactState;
    readonly path?: string;
    readonly reason?: string;
    readonly sourceSeq?: number;
}>;
/** Emitted EXACTLY ONCE, on the first crossing. Nothing is refused and no status is degraded. */
export type ActionGuidanceExceededEvent = Ev<"actionGuidanceExceeded", {
    readonly used: number;
    readonly guidance: number;
    readonly rendering: string;
}>;
export type BudgetExhaustedEvent = Ev<"budgetExhausted", {
    readonly budget: BudgetKind;
    readonly limit: number;
    readonly used: number;
    readonly detail?: string;
}>;
export type ProgressStalledEvent = Ev<"progressStalled", {
    readonly reason: string;
    readonly repeatedActions: number;
}>;
export type ErrorEvent = Ev<"error", {
    readonly stage: RunStage;
    readonly reason: string;
    readonly fatal: boolean;
    readonly cause?: string;
}>;
export type CancellationRequestedEvent = Ev<"cancellationRequested", {
    readonly reason: string;
    readonly source: "user" | "signal" | "api";
}>;
export type RunFinishedEvent = Ev<"runFinished", {
    readonly status: RunStatus;
    readonly criteriaCount: number;
    readonly failedCriteria: ReadonlyArray<CriterionId>;
}>;
export type HarnessEvent = RunStartedEvent | ConfigResolvedEvent | ContractFrozenEvent | FixtureReadyEvent | FixtureCleanedEvent | BrowserContextOpenedEvent | ObservationTakenEvent | ModelCallStartedEvent | ModelCallFinishedEvent | ActionStartedEvent | ActionFinishedEvent | EvidenceRequestedEvent | VerificationFinishedEvent | ArtifactAvailableEvent | ActionGuidanceExceededEvent | BudgetExhaustedEvent | ProgressStalledEvent | ErrorEvent | CancellationRequestedEvent | RunFinishedEvent;
export type HarnessEventType = HarnessEvent["type"];
export declare const harnessEventTypes: ReadonlyArray<HarnessEventType>;
/**
 * Structural gate on data that arrives over the wire. It checks the envelope and that `type` is one
 * we know; it is deliberately NOT a full decode (core owns the schemas). Anything that fails here is
 * counted and dropped rather than rendered.
 */
export declare const isHarnessEvent: (value: unknown) => value is HarnessEvent;
export {};
//# sourceMappingURL=events.d.ts.map