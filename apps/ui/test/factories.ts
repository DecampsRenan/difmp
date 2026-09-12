/**
 * Builders for the shapes the components render.
 *
 * They exist so a test can state ONLY what it is about — a criterion that failed, an artifact whose
 * capture failed — and inherit a coherent run for everything else. A test that spells out all
 * thirty fields of `RunModel` hides its own subject.
 */
import type {
  ArtifactView,
  BudgetBreach,
  CriterionView,
  RunModel,
  TimelineEntry,
} from "../src/state/model.js";
import { emptyRunModel } from "../src/state/model.js";
import type {
  Budgets,
  CaptureConfig,
  CriterionResult,
  HarnessEvent,
  ResolvedConfig,
} from "../src/types/events.js";

export const budgets: Budgets = {
  attemptTimeoutMs: 120_000,
  operationTimeoutMs: 15_000,
  maxModelCalls: 30,
  maxTokens: 200_000,
  verifierReserveTokens: 20_000,
  fixtureCleanupTimeoutMs: 5_000,
};

export const capture: CaptureConfig = {
  trace: "on",
  video: "off",
  screenshots: "checkpoints",
  retainTraceOn: "all",
};

/**
 * An override may name an optional field explicitly `undefined` to mean "this one has none".
 * `exactOptionalPropertyTypes` forbids that value on the views themselves, so such a key is
 * dropped rather than set: `artifact({ path: undefined })` yields an artifact with no path.
 */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

const withOverrides = <T extends object>(base: T, over: Overrides<T>): T => {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out as T;
};

export const resolvedConfig = (over: Overrides<ResolvedConfig> = {}): ResolvedConfig =>
  withOverrides(
    {
      include: ["**/*.e2e.md"],
      exclude: [],
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins: ["http://127.0.0.1:3000"],
      inputs: {},
      provider: "scripted",
      providerOptions: {},
      maxActions: 25,
      budgets,
      capture,
      outputDir: "runs",
      reporters: ["console"],
    },
    over,
  );

export const runModel = (over: Overrides<RunModel> = {}): RunModel =>
  withOverrides(
    {
      ...emptyRunModel,
      runId: "run-1",
      attemptId: "attempt-1",
      scenarioId: "checkout-flow",
      specPath: "specs/checkout.e2e.md",
      harnessVersion: "0.1.0",
      startedAt: "2026-09-12T10:00:00.000Z",
    },
    over,
  );

export const criterion = (over: Overrides<CriterionView> = {}): CriterionView =>
  withOverrides(
    {
      id: "c1",
      text: "The order confirmation is displayed",
      method: "model",
      status: "pending",
      evidenceRequested: false,
    },
    over,
  );

export const criterionResult = (over: Overrides<CriterionResult> = {}): CriterionResult =>
  withOverrides(
    {
      criterionId: "c1",
      criterionHash: "hash-c1",
      status: "passed",
      method: "model",
      evaluator: { kind: "model", provider: "anthropic", model: "claude-sonnet-5" },
      expected: "An order number is visible",
      observed: "Order #4821 is visible in the confirmation panel",
      evidence: ["shot-1"],
      evaluatedAtSeq: 12,
    },
    over,
  );

export const artifact = (over: Overrides<ArtifactView> = {}): ArtifactView =>
  withOverrides(
    {
      seq: 5,
      ts: "2026-09-12T10:00:05.250Z",
      artifactId: "shot-1",
      kind: "screenshot",
      state: "present",
      path: "screenshots/shot-1.png",
    },
    over,
  );

export const timelineEntry = (over: Overrides<TimelineEntry> = {}): TimelineEntry =>
  withOverrides(
    {
      seq: 1,
      ts: "2026-09-12T10:00:01.000Z",
      kind: "lifecycle",
      tone: "info",
      label: "Run started",
    },
    over,
  );

export const breach = (over: Overrides<BudgetBreach> = {}): BudgetBreach =>
  withOverrides(
    {
      budget: "maxTokens",
      limit: 200_000,
      used: 200_412,
    },
    over,
  );

/** A sequence counter so a test can emit events without hand-numbering `seq`. */
export const eventStream = (runId = "run-1") => {
  let seq = 0;
  let clock = Date.parse("2026-09-12T10:00:00.000Z");
  return <T extends HarnessEvent["type"]>(
    type: T,
    fields: Omit<Extract<HarnessEvent, { type: T }>, keyof EnvelopeKeys | "type">,
    over: { readonly seq?: number; readonly ts?: string } = {},
  ): HarnessEvent => {
    seq += 1;
    clock += 1000;
    return {
      schemaVersion: 1,
      seq: over.seq ?? seq,
      runId,
      attemptId: "attempt-1",
      ts: over.ts ?? new Date(clock).toISOString(),
      type,
      ...fields,
      // The envelope is assembled from a generic `T`, so TypeScript cannot narrow the literal back
      // to one union member. What it DOES check is `fields` — `Omit<Extract<HarnessEvent, …>>` —
      // so a caller still cannot pass the wrong payload for the event type it names.
    } as unknown as HarnessEvent;
  };
};

type EnvelopeKeys = {
  schemaVersion: 1;
  seq: number;
  runId: string;
  attemptId?: string;
  ts: string;
};
