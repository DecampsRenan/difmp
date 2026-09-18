import { ProviderError } from "@difmp/core";
import { Duration } from "effect";
import type { AiError } from "effect/unstable/ai";

const statusOf = (reason: AiError.AiErrorReason): number | undefined => {
  const http = (reason as { readonly http?: { readonly response?: { readonly status?: number } } })
    .http;
  return http?.response?.status;
};

/** A rate-limited call carries the server's `Retry-After`; hand it to the runner's backoff. */
const retryAfterMsOf = (reason: AiError.AiErrorReason): number | undefined => {
  const retryAfter = (reason as { readonly retryAfter?: Duration.Duration }).retryAfter;
  return retryAfter === undefined ? undefined : Math.ceil(Duration.toMillis(retryAfter));
};

/**
 * `AiError` is one class with 18 reason variants; the tag is on `reason`, not on the error.
 * Retryability comes from the reason itself — we never invent our own retry policy here.
 */
export const providerErrorFromAiError =
  (provider: string) =>
  (error: AiError.AiError): ProviderError => {
    const status = statusOf(error.reason);
    const retryAfterMs = retryAfterMsOf(error.reason);
    return new ProviderError({
      provider,
      reason: `${error.reason._tag}: ${error.message}`,
      retryable: error.isRetryable,
      ...(status === undefined ? {} : { status }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  };

export const providerErrorFromDefect =
  (provider: string) =>
  (cause: unknown): ProviderError =>
    new ProviderError({
      provider,
      reason: cause instanceof Error ? cause.message : String(cause),
      retryable: false,
    });
