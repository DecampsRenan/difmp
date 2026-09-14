import { describe, expect, it } from "@effect/vitest";
import type { ModelProvider as ModelProviderService, ResolvedConfig } from "@difmp/core";
import { ModelProvider, defaultBudgets, defaultCapture } from "@difmp/core";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  defaultOpencodeGoApiUrl,
  opencodeGoModelProviderLayer,
  opencodeGoOptionsFromConfig,
  opencodeGoUserAgent,
} from "../src/index.js";

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

const baseConfig = (
  overrides: Partial<ResolvedConfig> & Pick<ResolvedConfig, "provider" | "model">,
): ResolvedConfig => ({
  include: ["**/*.e2e.md"],
  exclude: [],
  baseUrl: "http://127.0.0.1:3000",
  allowedOrigins: ["http://127.0.0.1:3000"],
  inputs: {},
  providerOptions: {},
  maxActions: 25,
  budgets: defaultBudgets,
  capture: defaultCapture,
  outputDir: "runs",
  reporters: ["console"],
  ...overrides,
});

const message = (content: ReadonlyArray<Record<string, unknown>>, stopReason: string) => ({
  id: `msg_recorded_${stopReason}`,
  type: "message",
  role: "assistant",
  content,
  model: "qwen3.7-max",
  stop_reason: stopReason,
  stop_sequence: null,
  usage: {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 11,
    output_tokens: 4,
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

describe("OpenCode Go adapter", () => {
  it.effect("rejects models that are not on the Anthropic Messages surface", () =>
    Effect.gen(function* () {
      const error = yield* opencodeGoOptionsFromConfig(
        baseConfig({ provider: "opencode-go", model: "glm-5.3-flash" }),
        "session-test",
      ).pipe(Effect.flip);
      expect(error.message).toContain("glm-5.3-flash");
      expect(error.message).toContain("/v1/messages");
    }),
  );

  it.effect("sends x-opencode-session, User-Agent, and OPENCODE_API_KEY to the Go base URL", () =>
    Effect.gen(function* () {
      const recorded: Array<RecordedRequest> = [];
      const transport = HttpClient.make((request, url) => {
        recorded.push({
          url: url.toString(),
          method: request.method,
          headers: request.headers,
        });
        return Effect.succeed(
          jsonResponse(
            request,
            message(
              [
                {
                  type: "tool_use",
                  id: "toolu_go_finish",
                  name: "finish",
                  input: {},
                  caller: { type: "direct" },
                },
              ],
              "tool_use",
            ),
          ),
        );
      });
      const providerLayer = opencodeGoModelProviderLayer(
        {
          model: "qwen3.7-max",
          sessionId: "run_session_abc",
          maxTokens: 128,
        },
        Layer.succeed(HttpClient.HttpClient, transport),
      ).pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_API_KEY: "go-recorded-key" })),
        ),
      );

      const provider: ModelProviderService["Service"] = yield* ModelProvider.pipe(
        Effect.provide(providerLayer),
      );
      expect(provider.id).toBe("opencode-go");
      expect(provider.modelId).toBe("qwen3.7-max");

      yield* provider.generate({
        role: "browser",
        prompt: {
          messages: [{ role: "user", parts: [{ type: "text", text: "Finish." }] }],
        },
        tools: [
          {
            name: "finish",
            description: "Finish",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      });

      expect(recorded).toHaveLength(1);
      const req = recorded[0]!;
      expect(req.url).toBe(`${defaultOpencodeGoApiUrl}/v1/messages?beta=true`);
      expect(req.headers["x-api-key"]).toBe("go-recorded-key");
      expect(req.headers["x-opencode-session"]).toBe("run_session_abc");
      expect(req.headers["user-agent"]).toBe(opencodeGoUserAgent);
    }),
  );
});
