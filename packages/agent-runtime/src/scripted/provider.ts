import type { ObserveResult, Prompt as HarnessPrompt } from "@difmp/core";
import { ModelProvider } from "@difmp/core";
import { Effect, Layer, Ref, Stream } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";
import { fromAiPrompt } from "../prompt.js";
import { makeLanguageModelProvider } from "../provider.js";
import type { CriterionVerdictShape } from "../verifier/verdict.js";
import { readCriterionMarker } from "../verifier/verdict.js";
import type { AgentScript, ScriptContext, ScriptedToolOutcome } from "./script.js";
import { resolveParams, resolveStep } from "./script.js";
import type { VerdictScript } from "./verdicts.js";
import { renderVerdict } from "./verdicts.js";

export const scriptedProviderId = "scripted";
/** Never let a scripted run be mistaken for a model validation. */
export const scriptedAdapterId = "scripted-double (deterministic, no network)";
export const scriptedModelId = "scripted-double";

export interface ScriptedProviderScript {
  readonly agent: AgentScript;
  readonly verdicts?: VerdictScript;
  /** Token usage reported for every turn unless a step overrides it — exercises the budgets. */
  readonly defaultUsage?: { readonly inputTokens: number; readonly outputTokens: number };
}

const isObserveResult = (value: unknown): value is ObserveResult =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { observationId?: unknown }).observationId === "string" &&
  Array.isArray((value as { elements?: unknown }).elements);

const readConversation = (
  prompt: HarnessPrompt,
): {
  readonly results: ReadonlyArray<ScriptedToolOutcome>;
  readonly observationIds: ReadonlyArray<string>;
  readonly observation?: ObserveResult;
} => {
  const results: Array<ScriptedToolOutcome> = [];
  const observationIds: Array<string> = [];
  let observation: ObserveResult | undefined;
  for (const message of prompt.messages) {
    for (const part of message.parts) {
      if (part.type !== "toolResult") continue;
      results.push({
        id: part.id,
        name: part.name,
        result: part.result,
        isError: part.isError === true,
      });
      if (part.name === "observe" && isObserveResult(part.result)) {
        observationIds.push(part.result.observationId);
        observation = part.result;
      }
    }
  }
  return { results, observationIds, ...(observation === undefined ? {} : { observation }) };
};

/**
 * A canned verdict cannot know the artifactIds an attempt will mint, so a scripted answer may use
 * `$first` / `$last` / `$all` and the double resolves them against the ids present in its prompt.
 * Anything else is passed through untouched — that is how the "invented reference" case is written.
 */
const resolveEvidenceTokens = (
  verdict: CriterionVerdictShape,
  available: ReadonlyArray<string>,
): CriterionVerdictShape => ({
  ...verdict,
  evidence: verdict.evidence.flatMap((entry) =>
    entry === "$first"
      ? available.slice(0, 1)
      : entry === "$last"
        ? available.slice(-1)
        : entry === "$all"
          ? available
          : [entry],
  ),
});

const finishPart = (
  reason: "stop" | "tool-calls",
  usage: { readonly inputTokens: number; readonly outputTokens: number },
): Response.PartEncoded => ({
  type: "finish",
  reason,
  usage: { inputTokens: { total: usage.inputTokens }, outputTokens: { total: usage.outputTokens } },
});

const scriptFailure = (reason: string): AiError.AiError =>
  AiError.make({
    module: "ScriptedLanguageModel",
    method: "generateText",
    reason: new AiError.UnknownError({ description: reason }),
  });

interface ScriptedState {
  readonly turn: number;
  readonly calls: number;
  readonly verdicts: Readonly<Record<string, number>>;
}

/**
 * A deterministic `LanguageModel`, network-free. It is the same seam a real provider plugs into, so
 * the scripted run exercises the real prompt construction, the real tool derivation and the real
 * usage accounting — only the answers are canned.
 */
export const scriptedLanguageModelLayer = (
  script: ScriptedProviderScript,
  /** Optional spy: every request the provider actually received, for assertions. */
  seen?: Array<LanguageModel.ProviderOptions>,
): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const state = yield* Ref.make<ScriptedState>({ turn: 0, calls: 0, verdicts: {} });
      const usage = script.defaultUsage ?? { inputTokens: 120, outputTokens: 40 };

      const verifierTurn = (options: LanguageModel.ProviderOptions) =>
        Effect.gen(function* () {
          const prompt = fromAiPrompt(options.prompt);
          const text = prompt.messages
            .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))
            .join("\n");
          const criterionId = readCriterionMarker(text);
          if (criterionId === undefined) {
            return yield* Effect.fail(
              scriptFailure(
                "the scripted verifier could not find a `criterion_id:` marker in the prompt",
              ),
            );
          }
          const occurrence = yield* Ref.modify(state, (s) => {
            const n = s.verdicts[criterionId] ?? 0;
            return [n, { ...s, verdicts: { ...s.verdicts, [criterionId]: n + 1 } }] as const;
          });
          const available = [...new Set(text.match(/\bart_[0-9]+\b/g) ?? [])];
          const verdict = resolveEvidenceTokens(
            renderVerdict(script.verdicts ?? {}, criterionId, occurrence),
            available,
          );
          return [
            { type: "text", text: JSON.stringify(verdict) } satisfies Response.PartEncoded,
            finishPart("stop", usage),
          ];
        });

      const browsingTurn = (options: LanguageModel.ProviderOptions) =>
        Effect.gen(function* () {
          const prompt = fromAiPrompt(options.prompt);
          const conversation = readConversation(prompt);
          const turn = yield* Ref.modify(
            state,
            (s) => [s.turn, { ...s, turn: s.turn + 1 }] as const,
          );
          const ctx: ScriptContext = { turn, prompt, ...conversation };
          const step = resolveStep(script.agent, ctx);
          if (step === undefined) {
            return [
              {
                type: "text",
                text: `scripted agent "${script.agent.id}" has no step ${turn}`,
              } satisfies Response.PartEncoded,
              finishPart("stop", usage),
            ];
          }
          const parts: Array<Response.PartEncoded> = [];
          if (step.text !== undefined) parts.push({ type: "text", text: step.text });
          const calls = step.calls ?? [];
          for (const call of calls) {
            const id = yield* Ref.modify(
              state,
              (s) => [s.calls + 1, { ...s, calls: s.calls + 1 }] as const,
            );
            const params = yield* Effect.try({
              try: () => resolveParams(call.params, ctx),
              catch: (cause) =>
                scriptFailure(cause instanceof Error ? cause.message : String(cause)),
            });
            parts.push({ type: "tool-call", id: `call_${id}`, name: call.tool, params });
          }
          parts.push(
            finishPart(
              calls.length === 0 ? "stop" : "tool-calls",
              step.usage === undefined
                ? usage
                : {
                    inputTokens: step.usage.inputTokens ?? usage.inputTokens,
                    outputTokens: step.usage.outputTokens ?? usage.outputTokens,
                  },
            ),
          );
          return parts;
        });

      const turn = (options: LanguageModel.ProviderOptions) => {
        seen?.push(options);
        return options.responseFormat.type === "json"
          ? verifierTurn(options)
          : browsingTurn(options);
      };

      return yield* LanguageModel.make({
        generateText: turn,
        streamText: (options) =>
          Stream.unwrap(
            Effect.map(turn(options), (parts) =>
              Stream.fromIterable(parts as ReadonlyArray<Response.StreamPartEncoded>),
            ),
          ),
      });
    }),
  );

export const scriptedModelProviderLayer = (
  script: ScriptedProviderScript,
  options?: { readonly modelId?: string; readonly seen?: Array<LanguageModel.ProviderOptions> },
): Layer.Layer<ModelProvider> =>
  Layer.effect(
    ModelProvider,
    makeLanguageModelProvider({
      id: scriptedProviderId,
      modelId: options?.modelId ?? scriptedModelId,
    }),
  ).pipe(Layer.provide(scriptedLanguageModelLayer(script, options?.seen)));
