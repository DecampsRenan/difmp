import type { ResolvedConfig } from "@difmp/core"
import { decodeStrict, formatSchemaError, ModelProvider, ProviderError } from "@difmp/core"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Effect, Layer, Schema } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import type { HttpClient } from "effect/unstable/http"
import { FetchHttpClient } from "effect/unstable/http"
import { makeLanguageModelProvider } from "./provider.js"

export const anthropicProviderId = "anthropic"
/** Recorded in `manifest.model.adapterId` so a report can name the adapter that really ran. */
export const anthropicAdapterId = "anthropic/@effect/ai-anthropic"
export const defaultApiKeyEnvVar = "ANTHROPIC_API_KEY"

/**
 * `providerOptions` from `difmp.config.ts`. Unknown keys are rejected: a silently ignored typo in
 * `maxTokens` would change cost and behaviour without anyone noticing.
 */
export const AnthropicProviderOptions = Schema.Struct({
  /** Name of the env var holding the key. The key itself never appears in config, logs or prompts. */
  apiKeyEnvVar: Schema.optionalKey(Schema.NonEmptyString),
  apiUrl: Schema.optionalKey(Schema.NonEmptyString),
  apiVersion: Schema.optionalKey(Schema.NonEmptyString),
  maxTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  temperature: Schema.optionalKey(Schema.Finite),
  topP: Schema.optionalKey(Schema.Finite),
  topK: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  stopSequences: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
}).annotate({ identifier: "AnthropicProviderOptions" })
export type AnthropicProviderOptions = typeof AnthropicProviderOptions["Type"]

export interface AnthropicAdapterOptions extends AnthropicProviderOptions {
  /** Provider-specific model id, always from configuration. */
  readonly model: string
}

const providerError = (reason: string): ProviderError =>
  new ProviderError({ provider: anthropicProviderId, reason, retryable: false })

/** Resolve the adapter options from the validated harness config. */
export const anthropicOptionsFromConfig = (
  config: ResolvedConfig
): Effect.Effect<AnthropicAdapterOptions, ProviderError> =>
  Effect.gen(function*() {
    if (config.model === undefined) {
      return yield* Effect.fail(
        providerError('`model` is required when `provider: "anthropic"` — no model id is defaulted in code')
      )
    }
    const options = yield* decodeStrict(AnthropicProviderOptions)(config.providerOptions).pipe(
      Effect.mapError((error) =>
        providerError(formatSchemaError(error, { source: "providerOptions", summary: "invalid provider options" }))
      )
    )
    return { ...options, model: config.model }
  })

/**
 * `httpClient` exists so a test can drive the REAL adapter against a recorded transport: the
 * request is built, signed and serialised exactly as in production, without reaching the network.
 */
export const anthropicClientLayer = (
  options: Pick<AnthropicAdapterOptions, "apiKeyEnvVar" | "apiUrl" | "apiVersion">,
  httpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer
): Layer.Layer<AnthropicClient.AnthropicClient, Config.ConfigError> =>
  AnthropicClient.layerConfig({
    apiKey: Config.Redacted(options.apiKeyEnvVar ?? defaultApiKeyEnvVar),
    ...(options.apiUrl === undefined ? {} : { apiUrl: Config.succeed(options.apiUrl) }),
    ...(options.apiVersion === undefined ? {} : { apiVersion: Config.succeed(options.apiVersion) })
  }).pipe(Layer.provide(httpClient))

/** Map our neutral option names onto Anthropic's request parameters. */
export const anthropicRequestConfig = (options: AnthropicAdapterOptions): Omit<typeof AnthropicLanguageModel.Config.Service, "model"> => ({
  ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
  ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  ...(options.topP === undefined ? {} : { top_p: options.topP }),
  ...(options.topK === undefined ? {} : { top_k: options.topK }),
  ...(options.stopSequences === undefined ? {} : { stop_sequences: [...options.stopSequences] })
})

export const anthropicLanguageModelLayer = (
  options: AnthropicAdapterOptions,
  httpClient?: Layer.Layer<HttpClient.HttpClient>
): Layer.Layer<LanguageModel.LanguageModel, Config.ConfigError> =>
  AnthropicLanguageModel.layer({ model: options.model, config: anthropicRequestConfig(options) }).pipe(
    Layer.provide(anthropicClientLayer(options, httpClient))
  )

/**
 * The real adapter. Interruption of the returned effect closes the HTTP request (see
 * `withAbort` in provider.ts), so a cancelled run leaves no late tool call in flight.
 */
export const anthropicModelProviderLayer = (
  options: AnthropicAdapterOptions,
  httpClient?: Layer.Layer<HttpClient.HttpClient>
): Layer.Layer<ModelProvider, Config.ConfigError> =>
  Layer.effect(
    ModelProvider,
    makeLanguageModelProvider({ id: anthropicProviderId, modelId: options.model })
  ).pipe(Layer.provide(anthropicLanguageModelLayer(options, httpClient)))

/** Convenience for the CLI: config in, layer out. */
export const anthropicModelProviderLayerFromConfig = (
  config: ResolvedConfig
): Layer.Layer<ModelProvider, ProviderError | Config.ConfigError> =>
  Layer.unwrap(Effect.map(anthropicOptionsFromConfig(config), anthropicModelProviderLayer))
