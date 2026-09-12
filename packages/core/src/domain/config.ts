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
export const ProviderName = Schema.Literals(["scripted", "anthropic"]);
export type ProviderName = (typeof ProviderName)["Type"];
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
