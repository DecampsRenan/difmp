import type { ResolvedConfig } from "@difmp/core";
import { ProviderError } from "@difmp/core";
import { Effect } from "effect";
import { BackendError, Jev } from "jev-use";
import type { JevBackend, Question, Verdict } from "jev-use";

/** Recorded on `manifest.evaluator.adapterId`. */
export const jevAdapterId = "jev/jev-use";
export const jevProviderId = "jev";

export type JevBackendChoice = "typesafe" | "openrouter" | "vercel" | "mock";

/** The slice of a `jev-use` judgment the verifier maps onto a criterion. */
export interface JevJudgment {
  readonly answers: Readonly<Record<string, Verdict<number | string>>>;
  readonly model?: string;
  readonly backend: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

/**
 * A constructed Jev client. Tests pass a `JevBackend`; production resolves one from the
 * environment. The API key stays inside the backend and never reaches config or the manifest.
 */
export interface JevJudge {
  readonly backendName: string;
  readonly model: string;
  readonly confidenceThreshold?: number;
  readonly judge: (
    state: string,
    questions: Readonly<Record<string, Question>>,
  ) => Promise<JevJudgment>;
  /**
   * The `BackendError` from the last call, if the backend threw one. `jev-use` turns that throw
   * into `escalate: unreachable` and drops `retryAfterMs`; this keeps the transport detail.
   */
  readonly takeTransportError: () => BackendError | undefined;
}

export interface JevJudgeOptions {
  readonly model: string;
  readonly backend?: JevBackendChoice | JevBackend;
  readonly confidenceThreshold?: number;
  /** Defaults to `process.env`. Tests pass a closed record so a developer key cannot leak in. */
  readonly env?: Record<string, string | undefined>;
}

const providerError = (reason: string): ProviderError =>
  new ProviderError({ provider: jevProviderId, reason, retryable: false });

/**
 * Build a client. Construction resolves the backend and checks that a credential exists; it does
 * not call the model. A missing key throws here, which is what `difmp validate` wants.
 */
export const jevJudgeFrom = (options: JevJudgeOptions): Effect.Effect<JevJudge, ProviderError> =>
  Effect.try({
    try: (): JevJudge => {
      let last: BackendError | undefined;
      const resolved = new Jev({
        ...(options.backend === undefined ? {} : { backend: options.backend }),
        model: options.model,
        ...(options.confidenceThreshold === undefined
          ? {}
          : { confidenceThreshold: options.confidenceThreshold }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      const client = new Jev({
        backend: {
          name: resolved.backend.name,
          judge: (request) =>
            resolved.backend.judge(request).catch((error: unknown) => {
              if (error instanceof BackendError) last = error;
              throw error;
            }),
        },
        model: options.model,
        ...(options.confidenceThreshold === undefined
          ? {}
          : { confidenceThreshold: options.confidenceThreshold }),
      });
      return {
        backendName: resolved.backend.name,
        model: options.model,
        ...(options.confidenceThreshold === undefined
          ? {}
          : { confidenceThreshold: options.confidenceThreshold }),
        takeTransportError: () => last,
        judge: async (state, questions) => {
          last = undefined;
          const judgment = await client.judge(state, { ...questions });
          return {
            answers: judgment.answers as JevJudgment["answers"],
            backend: judgment.backend,
            ...(judgment.model === undefined ? {} : { model: judgment.model }),
            ...(judgment.usage === undefined ? {} : { usage: judgment.usage }),
          };
        },
      };
    },
    catch: (cause) => providerError(cause instanceof Error ? cause.message : String(cause)),
  });

/** `undefined` when the config did not ask for a Jev evaluator. */
export const openJevEvaluator = (
  config: ResolvedConfig,
  env?: Record<string, string | undefined>,
): Effect.Effect<JevJudge | undefined, ProviderError> => {
  const evaluator = config.evaluator;
  if (evaluator === undefined) return Effect.succeed(undefined);
  return jevJudgeFrom({
    model: evaluator.model,
    ...(evaluator.backend === undefined ? {} : { backend: evaluator.backend }),
    ...(evaluator.confidenceThreshold === undefined
      ? {}
      : { confidenceThreshold: evaluator.confidenceThreshold }),
    ...(env === undefined ? {} : { env }),
  });
};
