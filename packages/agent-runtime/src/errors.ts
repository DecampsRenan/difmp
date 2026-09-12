import { ProviderError } from "@difmp/core"
import type { AiError } from "effect/unstable/ai"

const statusOf = (reason: AiError.AiErrorReason): number | undefined => {
  const http = (reason as { readonly http?: { readonly response?: { readonly status?: number } } }).http
  return http?.response?.status
}

/**
 * `AiError` is one class with 18 reason variants; the tag is on `reason`, not on the error.
 * Retryability comes from the reason itself — we never invent our own retry policy here.
 */
export const providerErrorFromAiError = (provider: string) => (error: AiError.AiError): ProviderError => {
  const status = statusOf(error.reason)
  return new ProviderError({
    provider,
    reason: `${error.reason._tag}: ${error.message}`,
    retryable: error.isRetryable,
    ...(status === undefined ? {} : { status })
  })
}

export const providerErrorFromDefect = (provider: string) => (cause: unknown): ProviderError =>
  new ProviderError({
    provider,
    reason: cause instanceof Error ? cause.message : String(cause),
    retryable: false
  })
