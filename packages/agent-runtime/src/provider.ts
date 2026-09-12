import type { GenerateRequest, ModelProvider, ProviderResponse } from "@difmp/core"
import { ProviderError } from "@difmp/core"
import { Effect, SchemaAST } from "effect"
import type { Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import type { Response } from "effect/unstable/ai"
import { providerErrorFromAiError, providerErrorFromDefect } from "./errors.js"
import { toAiPrompt } from "./prompt.js"
import { toToolkit } from "./toolkit.js"

export interface LanguageModelProviderOptions {
  /** `"anthropic"` | `"scripted"` — surfaced in the manifest and every model event. */
  readonly id: string
  /** Comes from configuration. No model name is ever hardcoded in this module. */
  readonly modelId: string
}

const objectNameOf = (schema: Schema.Top): string => {
  const identifier = SchemaAST.resolveIdentifier(schema.ast)
  return identifier ?? "structured_output"
}

const usageOf = (usage: Response.Usage): ProviderResponse["usage"] => {
  const inputTokens = usage.inputTokens.total ?? usage.inputTokens.uncached
  const outputTokens = usage.outputTokens.total ?? usage.outputTokens.text
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens })
  }
}

/**
 * The harness may hand us an `AbortSignal`. Racing against it means the losing fiber — the HTTP
 * request — is interrupted, and `HttpClient` turns fiber interruption into `controller.abort()`,
 * so the in-flight request really is cancelled and no late tool call can land.
 */
const abortWatcher = (provider: string, signal: AbortSignal): Effect.Effect<never, ProviderError> =>
  Effect.callback<never, ProviderError>((resume) => {
    const fail = () =>
      resume(Effect.fail(
        new ProviderError({
          provider,
          reason: "the in-flight request was aborted by the harness",
          retryable: false
        })
      ))
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener("abort", fail, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", fail))
  })

const withAbort = <A>(
  provider: string,
  signal: AbortSignal | undefined,
  effect: Effect.Effect<A, ProviderError>
): Effect.Effect<A, ProviderError> =>
  signal === undefined ? effect : Effect.raceFirst(effect, abortWatcher(provider, signal))

/**
 * One `ModelProvider` implementation on top of `LanguageModel`, shared by the real Anthropic
 * adapter and the scripted test double, so both exercise the same prompt plumbing, the same tool
 * derivation and the same usage accounting. Only the `LanguageModel` layer differs.
 *
 * Tool calls are handed BACK to the harness: `disableToolCallResolution: true` guarantees no tool
 * handler ever runs inside `generateText`, and `params` arrive in their encoded (wire) shape for
 * the harness to validate with the Effect Schema that produced the JSON Schema.
 */
export const makeLanguageModelProvider = (
  options: LanguageModelProviderOptions
): Effect.Effect<ModelProvider["Service"], never, LanguageModel.LanguageModel> =>
  Effect.gen(function*() {
    const languageModel = yield* LanguageModel.LanguageModel
    const toProviderError = providerErrorFromAiError(options.id)

    const generateObject = (
      request: GenerateRequest,
      schema: Schema.Top
    ): Effect.Effect<ProviderResponse, ProviderError> =>
      languageModel.generateObject({
        prompt: toAiPrompt(request.prompt),
        schema: schema as unknown as Schema.Codec<unknown, Record<string, unknown>>,
        objectName: objectNameOf(schema)
      }).pipe(
        Effect.map((response): ProviderResponse => {
          const usage = usageOf(response.usage)
          return {
            ...(response.text === "" ? {} : { text: response.text }),
            toolCalls: [],
            object: response.value,
            ...(usage === undefined ? {} : { usage }),
            finishReason: response.finishReason
          }
        }),
        Effect.catch((error) => Effect.fail(toProviderError(error)))
      )

    const fromTextResponse = (
      response: {
        readonly text: string
        readonly usage: Response.Usage
        readonly finishReason: string
        readonly toolCalls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly params: unknown }>
      }
    ): ProviderResponse => {
      const usage = usageOf(response.usage)
      return {
        ...(response.text === "" ? {} : { text: response.text }),
        toolCalls: response.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          params: toolCall.params
        })),
        ...(usage === undefined ? {} : { usage }),
        finishReason: response.finishReason
      }
    }

    const generateText = (request: GenerateRequest): Effect.Effect<ProviderResponse, ProviderError> => {
      const prompt = toAiPrompt(request.prompt)
      const tools = request.tools ?? []
      if (tools.length === 0) {
        return languageModel.generateText({ prompt }).pipe(
          Effect.map(fromTextResponse),
          Effect.catch((error) => Effect.fail(toProviderError(error)))
        )
      }
      return languageModel.generateText({
        prompt,
        toolkit: toToolkit(tools),
        toolChoice: "auto",
        // Tool handlers NEVER run inside the provider: the harness validates params and executes.
        disableToolCallResolution: true
      }).pipe(
        Effect.map(fromTextResponse),
        Effect.catch((error) => Effect.fail(toProviderError(error)))
      )
    }

    const toDefectError = providerErrorFromDefect(options.id)

    const generate = (request: GenerateRequest): Effect.Effect<ProviderResponse, ProviderError> =>
      withAbort(
        options.id,
        request.signal,
        request.responseSchema === undefined
          ? generateText(request)
          : generateObject(request, request.responseSchema)
      ).pipe(
        // The seam promises `ProviderError` and nothing else. An SDK that throws outside the
        // `AiError` channel (a bad payload, a broken stream, a client bug) would otherwise reach
        // the runner as an unlabelled defect that kills the attempt fiber, and a dead fiber is
        // attributed to the browser stage. Translating it here keeps the blame on the provider.
        Effect.catchDefect((defect) => Effect.fail(toDefectError(defect)))
      )

    return { id: options.id, modelId: options.modelId, generate }
  })

