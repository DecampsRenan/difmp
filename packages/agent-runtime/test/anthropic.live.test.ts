import { ModelProvider } from "@difmp/core";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { anthropicModelProviderLayer, CriterionVerdict } from "../src/index.js";

const live = process.env["DIFMP_REAL_PROVIDER"] === "1" ? describe : describe.skip;
const model = process.env["DIFMP_MODEL"] ?? "claude-sonnet-5";

const providerLayer = (httpClient?: Layer.Layer<HttpClient.HttpClient>) =>
  anthropicModelProviderLayer({ model, maxTokens: 512 }, httpClient);

const run = <A, E>(effect: Effect.Effect<A, E, ModelProvider>) =>
  Effect.runPromise(effect.pipe(Effect.provide(providerLayer())));

/**
 * Paid, opt-in probes. The ordinary test suite registers these tests as skipped; CI enables them
 * only in the scheduled/manual real-provider job with ANTHROPIC_API_KEY from repository secrets.
 */
live("Anthropic adapter — live provider smoke", () => {
  it("sends an accepted Sonnet 5 request and returns a tool call in harness wire shape", async () => {
    const token = `probe-${Date.now()}`;
    const response = await run(
      Effect.gen(function* () {
        const provider = yield* ModelProvider;
        return yield* provider.generate({
          role: "browser",
          prompt: {
            messages: [
              {
                role: "user",
                parts: [
                  {
                    type: "text",
                    text:
                      `This is an integration probe. Call report_probe exactly once with ` +
                      `{"token":${JSON.stringify(token)}}. Do not answer in prose.`,
                  },
                ],
              },
            ],
          },
          tools: [
            {
              name: "report_probe",
              description: "Return the opaque integration probe token",
              parameters: {
                type: "object",
                properties: { token: { type: "string" } },
                required: ["token"],
                additionalProperties: false,
              },
            },
          ],
        });
      }),
    );

    expect(response.toolCalls).toEqual([
      expect.objectContaining({ name: "report_probe", params: { token } }),
    ]);
  }, 30_000);

  it("round-trips the verifier's native structured verdict schema", async () => {
    const response = await run(
      Effect.gen(function* () {
        const provider = yield* ModelProvider;
        return yield* provider.generate({
          role: "verifier",
          prompt: {
            messages: [
              {
                role: "user",
                parts: [
                  {
                    type: "text",
                    text:
                      "Return a verdict for criterion c1. The expected statement and observed " +
                      "evidence are both: provider smoke is reachable. Mark it passed, cite " +
                      "art_live, use no limitations or missing evidence, and set absence to null.",
                  },
                ],
              },
            ],
          },
          responseSchema: CriterionVerdict,
        });
      }),
    );

    expect(response.object).toMatchObject({
      criterionId: "c1",
      status: "passed",
      evidence: ["art_live"],
      limitations: null,
      missingEvidence: [],
      absence: null,
    });
  }, 30_000);

  it("cancels a request after the real HTTP transport has started", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const observedFetch = Layer.effect(
      HttpClient.HttpClient,
      Effect.map(HttpClient.HttpClient, (client) =>
        client.pipe(HttpClient.tapRequest(() => Effect.sync(markStarted))),
      ),
    ).pipe(Layer.provide(FetchHttpClient.layer));
    const controller = new AbortController();
    const result = Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* ModelProvider;
        return yield* Effect.result(
          provider.generate({
            role: "browser",
            prompt: {
              messages: [
                {
                  role: "user",
                  parts: [
                    {
                      type: "text",
                      text: "Write a very long, detailed history of browser automation.",
                    },
                  ],
                },
              ],
            },
            signal: controller.signal,
          }),
        );
      }).pipe(Effect.provide(providerLayer(observedFetch))),
    );

    await started;
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const outcome = await result;
    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect(outcome.failure.message).toContain("aborted by the harness");
    }
  }, 30_000);
});
