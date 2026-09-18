import { describe, expect, it } from "@effect/vitest";
import { Duration } from "effect";
import { providerErrorFromAiError } from "../src/errors.js";
import type { AiError } from "effect/unstable/ai";

/**
 * A structural stand-in for `AiError.AiError` over a `RateLimitError`-shaped reason: the adapter
 * reads `reason._tag`, `reason.message`, `reason.http?.response?.status` and `reason.retryAfter`
 * only, and the real classes demand a full `HttpRequestDetails` to construct.
 */
const aiErrorWith = (reasonExtra: Record<string, unknown>, isRetryable = true): AiError.AiError =>
  ({
    _tag: "AiError",
    module: "anthropic",
    method: "generateText",
    message: "anthropic.generateText: too many requests",
    isRetryable,
    reason: {
      _tag: "RateLimitError",
      message: "too many requests",
      isRetryable,
      ...reasonExtra,
    },
  }) as unknown as AiError.AiError;

describe("providerErrorFromAiError", () => {
  it("carries retryability and the reported status through", () => {
    const error = providerErrorFromAiError("opencode-go")(
      aiErrorWith({ http: { request: {}, response: { status: 500 } } }, false),
    );
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(500);
  });

  it("maps the server Retry-After onto retryAfterMs in milliseconds", () => {
    const error = providerErrorFromAiError("opencode-go")(
      aiErrorWith({ retryAfter: Duration.seconds(2) }),
    );
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(2_000);
  });

  it("leaves retryAfterMs out when the reason carries none", () => {
    const error = providerErrorFromAiError("anthropic")(aiErrorWith({}));
    expect(error.retryAfterMs).toBeUndefined();
  });
});
