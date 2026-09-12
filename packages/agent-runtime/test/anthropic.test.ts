import { describe, expect, it } from "@effect/vitest";
import type { ModelProvider as ModelProviderService } from "@difmp/core";
import { ModelProvider } from "@difmp/core";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { anthropicModelProviderLayer, CriterionVerdict } from "../src/index.js";

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

const message = (content: ReadonlyArray<Record<string, unknown>>, stopReason: string) => ({
  id: `msg_recorded_${stopReason}`,
  type: "message",
  role: "assistant",
  content,
  model: "claude-sonnet-5",
  stop_reason: stopReason,
  stop_sequence: null,
  usage: {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 17,
    output_tokens: 5,
    service_tier: "standard",
  },
});

const jsonResponse = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": "req_recorded" },
    }),
  );

const bodyOf = (request: Parameters<typeof HttpClientResponse.fromWeb>[0]) => {
  if (request.body._tag !== "Uint8Array") throw new Error("expected a JSON request body");
  return JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>;
};

describe("Anthropic adapter — recorded transport", () => {
  it.effect("serializes tools and structured verdicts, and aborts the underlying request", () =>
    Effect.gen(function* () {
      const recorded: Array<RecordedRequest> = [];
      let cancellationSignal: AbortSignal | undefined;
      const replies = [
        message(
          [
            {
              type: "tool_use",
              id: "toolu_recorded_finish",
              name: "finish",
              input: {},
              caller: { type: "direct" },
            },
          ],
          "tool_use",
        ),
        message(
          [
            {
              type: "text",
              text: JSON.stringify({
                criterionId: "c1",
                status: "passed",
                expected: "The recorded transport works.",
                observed: "The adapter returned a decoded verdict.",
                evidence: ["art_1"],
                limitations: null,
                missingEvidence: [],
                evidenceHint: null,
                absence: null,
              }),
            },
          ],
          "end_turn",
        ),
      ];

      const transport = HttpClient.make((request, url, signal) => {
        recorded.push({
          url: url.toString(),
          method: request.method,
          headers: request.headers,
          body: bodyOf(request),
        });
        const reply = replies.shift();
        if (reply !== undefined) return Effect.succeed(jsonResponse(request, reply));
        cancellationSignal = signal;
        return Effect.never;
      });
      const providerLayer = anthropicModelProviderLayer(
        { model: "claude-sonnet-5", maxTokens: 256 },
        Layer.succeed(HttpClient.HttpClient, transport),
      ).pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ ANTHROPIC_API_KEY: "recorded-key" })),
        ),
      );

      const provider: ModelProviderService["Service"] = yield* ModelProvider.pipe(
        Effect.provide(providerLayer),
      );
      const toolResponse = yield* provider.generate({
        role: "browser",
        prompt: {
          messages: [
            { role: "system", parts: [{ type: "text", text: "Use exactly one tool." }] },
            {
              role: "user",
              parts: [
                { type: "text", text: "Finish now after inspecting this PNG." },
                {
                  type: "image",
                  mediaType: "image/png",
                  data: new Uint8Array([137, 80, 78, 71]),
                  fileName: "art_1.png",
                },
              ],
            },
          ],
        },
        tools: [
          {
            name: "finish",
            description: "Finish the recorded turn",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      });
      expect(toolResponse.toolCalls).toEqual([
        { id: "toolu_recorded_finish", name: "finish", params: {} },
      ]);

      const toolRequest = recorded[0]!;
      expect(toolRequest).toMatchObject({
        url: "https://api.anthropic.com/v1/messages?beta=true",
        method: "POST",
      });
      expect(toolRequest.headers["anthropic-version"]).toBe("2023-06-01");
      expect(toolRequest.headers["x-api-key"]).toBe("recorded-key");
      expect(toolRequest.headers["content-type"]).toBe("application/json");
      expect(toolRequest.headers["anthropic-beta"]).toContain("structured-outputs-2025-11-13");
      expect(toolRequest.body).toMatchObject({
        model: "claude-sonnet-5",
        max_tokens: 256,
        system: [{ type: "text", text: "Use exactly one tool.", cache_control: null }],
        tool_choice: { type: "auto" },
        tools: [
          {
            name: "finish",
            description: "Finish the recorded turn",
            input_schema: { type: "object", properties: {}, additionalProperties: false },
            strict: true,
          },
        ],
      });
      expect(toolRequest.body).not.toHaveProperty("temperature");
      expect(toolRequest.body).not.toHaveProperty("top_p");
      expect(toolRequest.body).not.toHaveProperty("top_k");
      expect(toolRequest.body.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "Finish now after inspecting this PNG.", cache_control: null },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
              cache_control: null,
            },
          ],
        },
      ]);

      const verdictResponse = yield* provider.generate({
        role: "verifier",
        prompt: { messages: [{ role: "user", parts: [{ type: "text", text: "Judge c1." }] }] },
        responseSchema: CriterionVerdict,
      });
      expect(verdictResponse.object).toMatchObject({ criterionId: "c1", status: "passed" });
      expect(recorded[1]!.body).toMatchObject({
        model: "claude-sonnet-5",
        max_tokens: 256,
        output_config: { format: { type: "json_schema" } },
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10);
      const cancelledResult = yield* Effect.result(
        provider.generate({
          role: "browser",
          prompt: { messages: [{ role: "user", parts: [{ type: "text", text: "Wait." }] }] },
          signal: controller.signal,
        }),
      );
      clearTimeout(timer);
      expect(cancelledResult._tag).toBe("Failure");
      if (cancelledResult._tag === "Failure") {
        expect(cancelledResult.failure.message).toContain("aborted by the harness");
      }
      expect(cancellationSignal?.aborted).toBe(true);
    }),
  );
});
