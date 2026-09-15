import type { ResolvedConfig } from "@difmp/core";
import { decodeStrict, formatSchemaError, ModelProvider, ProviderError } from "@difmp/core";
import { Config, Effect, Layer, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { HttpClient as HttpClientModule, HttpClientResponse } from "effect/unstable/http";
import { anthropicModelProviderLayer, type AnthropicAdapterOptions } from "./anthropic.js";

export const opencodeGoProviderId = "opencode-go";
/** Recorded in `manifest.model.adapterId` so a report can name the adapter that really ran. */
export const opencodeGoAdapterId = "opencode-go/@effect/ai-anthropic";
export const defaultOpencodeGoApiKeyEnvVar = "OPENCODE_API_KEY";
export const defaultOpencodeGoApiUrl = "https://opencode.ai/zen/go";
/** OpenCode Go monitors User-Agent; identify as difmp, not a generic HTTP library. */
export const opencodeGoUserAgent = "difmp/0.0.5";

/**
 * OpenCode Go models that speak the Anthropic Messages API (`/v1/messages`). Other Go models use
 * OpenAI chat/completions or responses and need a different adapter — rejected here with a clear
 * message rather than a cryptic InvalidOutputError from the Anthropic client.
 */
const anthropicCompatibleModels = new Set([
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
]);

/**
 * `providerOptions` for `provider: "opencode-go"`. Unknown keys are rejected.
 *
 * Auth is env-only (`OPENCODE_API_KEY` by default). Go requires `x-opencode-session` on every
 * request — the harness sets it from the run id unless `sessionId` overrides.
 */
export const OpencodeGoProviderOptions = Schema.Struct({
  apiKeyEnvVar: Schema.optionalKey(Schema.NonEmptyString),
  apiUrl: Schema.optionalKey(Schema.NonEmptyString),
  apiVersion: Schema.optionalKey(Schema.NonEmptyString),
  /** Stable conversation id for Go routing / prompt cache. Defaults to the run id. */
  sessionId: Schema.optionalKey(Schema.NonEmptyString),
  maxTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  temperature: Schema.optionalKey(Schema.Finite),
  topP: Schema.optionalKey(Schema.Finite),
  topK: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  stopSequences: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /**
   * Anthropic native `json_schema` structured outputs. Defaults to `false`: Go models are detected
   * as "unknown → supports structured output" by `@effect/ai-anthropic`, which then asks for a
   * format they do not honour. Override to `true` only if a specific Go model is known to support it.
   */
  structuredOutputs: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "OpencodeGoProviderOptions" });
export type OpencodeGoProviderOptions = (typeof OpencodeGoProviderOptions)["Type"];

export interface OpencodeGoAdapterOptions extends OpencodeGoProviderOptions {
  readonly model: string;
  /** Required at run time; validation may omit it (no HTTP call yet). */
  readonly sessionId: string;
}

const providerError = (reason: string): ProviderError =>
  new ProviderError({ provider: opencodeGoProviderId, reason, retryable: false });

const assertAnthropicCompatible = (model: string): Effect.Effect<void, ProviderError> =>
  anthropicCompatibleModels.has(model)
    ? Effect.void
    : Effect.fail(
        providerError(
          `model "${model}" is not served on OpenCode Go's Anthropic Messages endpoint ` +
            `(/v1/messages). Supported ids: ${[...anthropicCompatibleModels].toSorted().join(", ")}. ` +
            "Chat/completions and Responses models need a separate adapter.",
        ),
      );

const goErrorTypesToAnthropic = new Set(["AuthError", "MissingSessionID"]);

/**
 * Nullable `usage` keys that Anthropic's beta Messages schema requires as present-even-when-null.
 * OpenCode Go often omits them entirely, which surfaces as
 * `InvalidOutputError: Missing key at ["usage"]["cache_creation"]` (and siblings).
 */
const nullableUsageDefaults = {
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  inference_geo: null,
  service_tier: null,
} as const;

const normalizeMessageUsage = (usage: unknown): unknown => {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return usage;
  const record = usage as Record<string, unknown>;
  const filled: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(nullableUsageDefaults)) {
    if (!Object.hasOwn(filled, key)) filled[key] = value;
  }
  return filled;
};

/**
 * OpenCode Go's Messages responses are Anthropic-shaped but omit required keys the Effect schema
 * expects as present-even-when-null (`stop_sequence`, nullable `usage.*`). Error envelopes also use
 * Go-specific `error.type` values (`AuthError`, …) that fail Anthropic's error union. Rewrite both
 * so the shared Anthropic client can decode them.
 */
export const normalizeOpencodeGoAnthropicJson = (body: unknown): unknown => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;

  if (record["type"] === "error") {
    const error = record["error"];
    if (error !== null && typeof error === "object" && !Array.isArray(error)) {
      const err = error as Record<string, unknown>;
      const goType = err["type"];
      if (typeof goType === "string" && goErrorTypesToAnthropic.has(goType)) {
        return {
          type: "error",
          error: {
            type: "authentication_error",
            message: typeof err["message"] === "string" ? `${goType}: ${err["message"]}` : goType,
          },
        };
      }
    }
    return body;
  }

  if (record["type"] !== "message") return body;
  return {
    ...record,
    ...(!Object.hasOwn(record, "stop_sequence") ? { stop_sequence: null } : {}),
    ...(!Object.hasOwn(record, "stop_reason") ? { stop_reason: null } : {}),
    ...(Object.hasOwn(record, "usage") ? { usage: normalizeMessageUsage(record["usage"]) } : {}),
  };
};

const rewriteJsonResponse = (
  response: HttpClientResponse.HttpClientResponse,
  body: unknown,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    response.request,
    new Response(JSON.stringify(body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    }),
  );

/** HttpClient transform: normalize Go JSON before `@effect/ai-anthropic` decodes it. */
export const withOpencodeGoAnthropicNormalize = (
  client: HttpClient.HttpClient,
): HttpClient.HttpClient =>
  HttpClientModule.transformResponse(client, (effect) =>
    Effect.flatMap(effect, (response) =>
      Effect.gen(function* () {
        const text = yield* response.text;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          return HttpClientResponse.fromWeb(
            response.request,
            new Response(text, { status: response.status }),
          );
        }
        return rewriteJsonResponse(response, normalizeOpencodeGoAnthropicJson(parsed));
      }),
    ),
  );

/** Resolve adapter options from config. `sessionId` falls back to `fallbackSessionId` when unset. */
export const opencodeGoOptionsFromConfig = (
  config: ResolvedConfig,
  fallbackSessionId?: string,
): Effect.Effect<OpencodeGoAdapterOptions, ProviderError> =>
  Effect.gen(function* () {
    if (config.model === undefined) {
      return yield* Effect.fail(
        providerError(
          '`model` is required when `provider: "opencode-go"` — no model id is defaulted in code',
        ),
      );
    }
    yield* assertAnthropicCompatible(config.model);
    const options = yield* decodeStrict(OpencodeGoProviderOptions)(config.providerOptions).pipe(
      Effect.mapError((error) =>
        providerError(
          formatSchemaError(error, {
            source: "providerOptions",
            summary: "invalid provider options",
          }),
        ),
      ),
    );
    const sessionId = options.sessionId ?? fallbackSessionId;
    if (sessionId === undefined || sessionId.length === 0) {
      return yield* Effect.fail(
        providerError(
          "OpenCode Go requires x-opencode-session; pass providerOptions.sessionId or run via `difmp run` (session defaults to the run id)",
        ),
      );
    }
    return { ...options, model: config.model, sessionId };
  });

const toAnthropicAdapterOptions = (options: OpencodeGoAdapterOptions): AnthropicAdapterOptions => ({
  model: options.model,
  providerId: opencodeGoProviderId,
  apiKeyEnvVar: options.apiKeyEnvVar ?? defaultOpencodeGoApiKeyEnvVar,
  apiUrl: options.apiUrl ?? defaultOpencodeGoApiUrl,
  // Go models are not Claude: force the tool-JSON structured-output path unless the user opts in.
  structuredOutputs: options.structuredOutputs ?? false,
  ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
  ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  ...(options.topP === undefined ? {} : { topP: options.topP }),
  ...(options.topK === undefined ? {} : { topK: options.topK }),
  ...(options.stopSequences === undefined ? {} : { stopSequences: options.stopSequences }),
  headers: {
    "user-agent": opencodeGoUserAgent,
    "x-opencode-session": options.sessionId,
  },
  transformClient: withOpencodeGoAnthropicNormalize,
});

/**
 * OpenCode Go over the Anthropic Messages surface. Same LanguageModel plumbing as `anthropic`,
 * with Go's base URL, `OPENCODE_API_KEY`, User-Agent, and required `x-opencode-session`.
 */
export const opencodeGoModelProviderLayer = (
  options: OpencodeGoAdapterOptions,
  httpClient?: Layer.Layer<HttpClient.HttpClient>,
): Layer.Layer<ModelProvider, Config.ConfigError> =>
  anthropicModelProviderLayer(toAnthropicAdapterOptions(options), httpClient);

export const opencodeGoModelProviderLayerFromConfig = (
  config: ResolvedConfig,
  fallbackSessionId?: string,
): Layer.Layer<ModelProvider, ProviderError | Config.ConfigError> =>
  Layer.unwrap(
    Effect.map(
      opencodeGoOptionsFromConfig(config, fallbackSessionId),
      opencodeGoModelProviderLayer,
    ),
  );
