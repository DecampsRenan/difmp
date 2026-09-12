import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeLanguageModelProvider } from "../src/index.js";

/** A `LanguageModel` that THROWS instead of failing — an SDK bug, not an `AiError`. */
const dyingLanguageModel = (message: string): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.die(new Error(message)),
      streamText: () => Stream.die(new Error(message)),
    }),
  );

describe("language-model provider", () => {
  it.effect("reports a provider DEFECT as a typed ProviderError", () =>
    Effect.gen(function* () {
      // The `ModelProvider` seam declares `ProviderError` and nothing else. A defect escaping it
      // killed the runner's attempt fiber, and the runner attributes a dead fiber to the `browser`
      // stage — so an exploding adapter was reported as a browser failure. `providerErrorFromDefect`
      // existed for exactly this and had no caller.
      const provider = yield* makeLanguageModelProvider({
        id: "exploding",
        modelId: "exploding-v1",
      });
      const outcome = yield* Effect.result(
        provider.generate({
          role: "browser",
          prompt: { messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] },
        }),
      );
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.failure._tag).toBe("ProviderError");
        expect(outcome.failure.provider).toBe("exploding");
        expect(outcome.failure.retryable).toBe(false);
        expect(outcome.failure.message).toContain("the SDK threw");
      }
    }).pipe(Effect.provide(dyingLanguageModel("the SDK threw"))),
  );
});
