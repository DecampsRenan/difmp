import type { LoadedSpec, ResolvedConfig } from "@harness/core"
import { formatSchemaError, ModelProvider } from "@harness/core"
import {
  anthropicAdapterId,
  anthropicModelProviderLayerFromConfig,
  happyPathScript,
  prematureFinishScript,
  scriptedAdapterId,
  scriptedModelId,
  scriptedModelProviderLayer
} from "@harness/agent-runtime"
import type { ScriptedProviderScript } from "@harness/agent-runtime"
import { Cause, Effect, Layer, Schema } from "effect"
import { UsageError } from "./errors.js"

/**
 * `providerOptions` understood by the deterministic double. It exists so a scripted run can be
 * steered from `harness.config.ts` without writing an orchestration script; it is a TEST DOUBLE
 * and its verdicts are labelled `scripted-model`, never presentable as a model judgement.
 */
export const ScriptedProviderOptions = Schema.Struct({
  scenario: Schema.optionalKey(Schema.Literals(["happy-path", "premature-finish"])),
  /** Accessible name of the control that submits the form, when the walkthrough has one. */
  submit: Schema.optionalKey(Schema.NonEmptyString),
  fills: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.NonEmptyString, value: Schema.String }))
  ),
  /** Canned verdict for every criterion. Defaults to `inconclusive` — evidence is never assumed. */
  verdict: Schema.optionalKey(Schema.Literals(["passed", "failed", "inconclusive"])),
  observed: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "ScriptedProviderOptions" })
export type ScriptedProviderOptions = typeof ScriptedProviderOptions["Type"]

// Deliberately NOT strict: `providerOptions` is provider-scoped, and a config that also carries
// Anthropic options must still be usable with `--provider scripted`.
const decodeScriptedOptions = Schema.decodeUnknownEffect(ScriptedProviderOptions)

export const scriptFor = (
  config: ResolvedConfig,
  spec: LoadedSpec
): Effect.Effect<ScriptedProviderScript, UsageError> =>
  Effect.gen(function*() {
    const options = yield* decodeScriptedOptions(config.providerOptions).pipe(
      Effect.mapError((error) =>
        new UsageError({ message: formatSchemaError(error, { source: "providerOptions", summary: "invalid scripted provider options" }) })
      )
    )
    const criterionIds = spec.criteria.map((c) => c.id)
    const agent = options.scenario === "premature-finish"
      ? prematureFinishScript()
      : happyPathScript({
        criterionIds,
        ...(options.fills === undefined ? {} : { fills: options.fills }),
        ...(options.submit === undefined ? {} : { submit: options.submit })
      })
    return {
      agent,
      verdicts: {
        fallback: {
          status: options.verdict ?? "inconclusive",
          // `$last` resolves against the artifactIds actually present in the prompt, so a canned
          // verdict can never reference evidence that does not exist.
          evidence: options.verdict === undefined || options.verdict === "inconclusive" ? [] : ["$last"],
          expected: "(scripted verifier: expectation not restated)",
          observed: options.observed ?? "(scripted test double)",
          limitations: "scripted test double — this is not a model judgement"
        }
      }
    }
  })

const describeCause = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

export interface ProviderChoice {
  readonly layer: Layer.Layer<ModelProvider, UsageError>
  readonly providerId: string
  readonly modelId: string
  readonly adapterId: string
}

/** Wire the provider named by `--provider` or by `harness.config.ts`. */
export const modelProviderFor = (
  config: ResolvedConfig,
  spec: LoadedSpec
): Effect.Effect<ProviderChoice, UsageError> =>
  Effect.gen(function*() {
    if (config.provider === "anthropic") {
      return {
        layer: anthropicModelProviderLayerFromConfig(config).pipe(
          Layer.catchCause((cause) =>
            Layer.effect(
              ModelProvider,
              Effect.fail(
                new UsageError({
                  message: `provider "anthropic" could not be configured: ${describeCause(cause)}`
                })
              )
            )
          )
        ),
        providerId: "anthropic",
        modelId: config.model ?? "unknown",
        adapterId: anthropicAdapterId
      }
    }
    const script = yield* scriptFor(config, spec)
    return {
      layer: scriptedModelProviderLayer(script),
      providerId: "scripted",
      modelId: scriptedModelId,
      adapterId: scriptedAdapterId
    }
  })
