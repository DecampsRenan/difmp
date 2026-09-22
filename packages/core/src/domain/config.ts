import { Effect, Schema } from "effect";
import { Budgets, defaultBudgets } from "./budgets.js";
import { InputsRecord } from "./spec.js";

/** Always merged into `exclude`, whatever the project configures. */
export const alwaysExcluded: ReadonlyArray<string> = [
  "**/node_modules/**",
  "**/runs/**",
  "**/dist/**",
];

export const CaptureMode = Schema.Literals(["on", "off"]);
export const ScreenshotPolicy = Schema.Literals(["checkpoints", "every-action", "off"]);
export const TraceRetention = Schema.Literals(["all", "failure"]);
export const ProviderName = Schema.Literals(["scripted", "anthropic", "opencode-go"]);
export type ProviderName = (typeof ProviderName)["Type"];

/** Backends `jev-use` can judge with. `mock` is a keyless dry run, not the scripted adapter. */
export const JevBackendName = Schema.Literals(["typesafe", "openrouter", "vercel", "mock"]);
export type JevBackendName = (typeof JevBackendName)["Type"];

const unitInterval = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/**
 * Criterion judge, separate from the navigation `provider`. Omitted means the navigation model
 * also evaluates the criteria. Jev answers typed questions about evidence text; it does not
 * navigate and it does not see screenshot pixels.
 */
export const JevEvaluatorConfig = Schema.Struct({
  provider: Schema.Literal("jev"),
  /** Pinned model id (`jev-latest` moves). Never defaulted in code. */
  model: Schema.NonEmptyString,
  backend: Schema.optionalKey(JevBackendName),
  /**
   * Escalate every verdict below this confidence, whichever source produced it. Omit it to keep
   * jev-use's own bars (0.5 reported, 0.4 estimated). This is evaluator policy, not a threshold
   * invented from the wording of a criterion.
   */
  confidenceThreshold: Schema.optionalKey(unitInterval),
}).annotate({ identifier: "JevEvaluatorConfig" });
export type JevEvaluatorConfig = (typeof JevEvaluatorConfig)["Type"];
export const ReporterName = Schema.Literals(["console", "json", "junit", "html"]);
export type ReporterName = (typeof ReporterName)["Type"];

export const defaultCapture = {
  trace: "on",
  video: "off",
  screenshots: "checkpoints",
  retainTraceOn: "all",
} as const;

export const CaptureConfig = Schema.Struct({
  trace: CaptureMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultCapture.trace))),
  video: CaptureMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultCapture.video))),
  screenshots: ScreenshotPolicy.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultCapture.screenshots)),
  ),
  retainTraceOn: TraceRetention.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultCapture.retainTraceOn)),
  ),
}).annotate({ identifier: "CaptureConfig" });
export type CaptureConfig = (typeof CaptureConfig)["Type"];

export const defaultConfig = {
  include: ["**/*.e2e.md"],
  exclude: alwaysExcluded,
  baseUrl: "http://127.0.0.1:3000",
  allowedOrigins: [] as ReadonlyArray<string>,
  inputs: {},
  provider: "scripted",
  providerOptions: {},
  maxActions: 25,
  budgets: defaultBudgets,
  capture: defaultCapture,
  outputDir: "runs",
  reporters: ["console"],
} as const;

const withDefault = <S extends Schema.Codec<any, any, never, never>>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

/**
 * The serialisable half of `difmp.config.ts`. Fixtures and checks are functions and are
 * validated separately (see registry/) — everything here round-trips to `manifest.json`.
 */
export const ResolvedConfig = Schema.Struct({
  include: withDefault(Schema.Array(Schema.NonEmptyString), defaultConfig.include),
  exclude: withDefault(Schema.Array(Schema.NonEmptyString), defaultConfig.exclude),
  baseUrl: withDefault(Schema.NonEmptyString, defaultConfig.baseUrl),
  /** The baseUrl origin is always allowed; the resolver adds it. */
  allowedOrigins: withDefault(Schema.Array(Schema.NonEmptyString), defaultConfig.allowedOrigins),
  inputs: withDefault(InputsRecord, defaultConfig.inputs),
  provider: withDefault(ProviderName, defaultConfig.provider),
  /** Provider-specific model id. Never defaulted in core. */
  model: Schema.optionalKey(Schema.NonEmptyString),
  /** Absent: the navigation provider evaluates criteria too. */
  evaluator: Schema.optionalKey(JevEvaluatorConfig),
  providerOptions: withDefault(
    Schema.Record(Schema.String, Schema.Unknown),
    defaultConfig.providerOptions,
  ),
  /** INDICATIVE threshold. Never blocks, never degrades a status. */
  maxActions: withDefault(Schema.Int.check(Schema.isGreaterThan(0)), defaultConfig.maxActions),
  budgets: Budgets.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultBudgets))),
  capture: CaptureConfig.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultCapture))),
  outputDir: withDefault(Schema.NonEmptyString, defaultConfig.outputDir),
  reporters: withDefault(Schema.Array(ReporterName), defaultConfig.reporters),
}).annotate({ identifier: "ResolvedConfig" });

export type ResolvedConfig = (typeof ResolvedConfig)["Type"];
