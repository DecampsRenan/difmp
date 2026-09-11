import type { ActionId, ArtifactId, ArtifactState, BudgetKind, CaptureConfig, CriterionId, CriterionMethod, CriterionResult, CriterionStatus, InputValue, ResolvedConfig, RunStatus, ToolErrorCode, ToolName } from "../types/events.js";
import type { ContractCriterion } from "../types/contract.js";
export type TimelineKind = "lifecycle" | "action" | "observation" | "model" | "verification" | "evidence" | "artifact" | "guidance" | "budget" | "error";
export type TimelineTone = "neutral" | "ok" | "warn" | "bad" | "info";
export interface TimelineEntry {
    /** `seq` of the event that OPENED this row. Also the React key: unique per run. */
    readonly seq: number;
    readonly ts: string;
    readonly kind: TimelineKind;
    readonly tone: TimelineTone;
    readonly label: string;
    readonly detail?: string;
    /** Filled in when a matching `actionFinished` / paired closing event arrives. */
    readonly outcome?: string;
    readonly durationMs?: number;
    readonly actionId?: ActionId;
    readonly criterionId?: CriterionId;
}
export interface ActionView {
    readonly seq: number;
    readonly actionId: ActionId;
    readonly tool: ToolName;
    readonly intent?: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly outcome?: "ok" | "error";
    readonly code?: ToolErrorCode;
    readonly message?: string;
}
export interface ArtifactView {
    readonly seq: number;
    readonly ts: string;
    readonly artifactId: ArtifactId;
    readonly kind: string;
    readonly state: ArtifactState;
    readonly path?: string;
    readonly reason?: string;
    readonly sourceSeq?: number;
    /** The action this artifact was captured during, resolved at ingest time. */
    readonly actionId?: ActionId;
    readonly actionLabel?: string;
}
export interface CriterionView {
    readonly id: CriterionId;
    readonly text?: string;
    readonly method?: CriterionMethod;
    readonly checkName?: string;
    readonly status: CriterionStatus;
    readonly result?: CriterionResult;
    readonly evidenceRequested: boolean;
    readonly note?: string;
}
export interface BudgetBreach {
    readonly budget: BudgetKind;
    readonly limit: number;
    readonly used: number;
    readonly detail?: string;
}
export interface ModelAccounting {
    readonly started: number;
    readonly finished: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly verifierTokens: number;
}
export interface RunModel {
    /** Highest applied `seq`. The whole replay/dedupe guarantee rests on this one number. */
    readonly lastSeq: number;
    readonly applied: number;
    readonly duplicates: number;
    readonly malformed: number;
    readonly runId?: string;
    readonly attemptId?: string;
    readonly scenarioId?: string;
    readonly specPath?: string;
    readonly harnessVersion?: string;
    readonly startedAt?: string;
    readonly finishedAt?: string;
    readonly status: RunStatus | "running";
    readonly failedCriteria: ReadonlyArray<CriterionId>;
    readonly cancellation?: {
        readonly reason: string;
        readonly source: string;
    };
    readonly config?: ResolvedConfig;
    readonly capture?: CaptureConfig;
    readonly baseUrl?: string;
    readonly contractHash?: string;
    readonly specHash?: string;
    readonly fixture?: {
        readonly name: string;
        readonly publicValues: Readonly<Record<string, InputValue>>;
        readonly cleaned?: {
            readonly cleanupsRun: number;
            readonly timedOut: boolean;
        };
    };
    readonly criteria: ReadonlyArray<CriterionView>;
    readonly timeline: ReadonlyArray<TimelineEntry>;
    readonly actions: ReadonlyArray<ActionView>;
    readonly artifacts: ReadonlyArray<ArtifactView>;
    readonly observationCount: number;
    readonly model: ModelAccounting;
    /** Accepted browser tool calls. INDICATIVE accounting — never mixed with `budgets`. */
    readonly actionCount: number;
    readonly guidance?: {
        readonly used: number;
        readonly guidance: number;
        readonly rendering: string;
    };
    readonly budgetBreaches: ReadonlyArray<BudgetBreach>;
    readonly stalls: ReadonlyArray<{
        readonly seq: number;
        readonly reason: string;
        readonly repeatedActions: number;
    }>;
    readonly errors: ReadonlyArray<{
        readonly seq: number;
        readonly ts: string;
        readonly stage: string;
        readonly reason: string;
        readonly fatal: boolean;
        readonly cause?: string;
    }>;
    /** From `contractUrl`; supplies criterion text + method before any verification runs. */
    readonly contractCriteria: ReadonlyArray<ContractCriterion>;
    readonly contractMaxActions?: number;
}
export declare const emptyRunModel: RunModel;
export declare const isFinished: (m: RunModel) => boolean;
//# sourceMappingURL=model.d.ts.map