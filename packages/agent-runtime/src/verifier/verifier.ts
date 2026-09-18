import type {
  Check,
  Evaluator,
  Registry,
  VerificationRequest,
  VerificationResponse,
  Verifier as VerifierService,
} from "@difmp/core";
import { formatSchemaError, ModelProvider, Verifier, VerifierError } from "@difmp/core";
import { Crypto, Effect, Layer, Ref, Schema } from "effect";
import { scriptedProviderId } from "../scripted/provider.js";
import { verifierPrompt } from "./prompt.js";
import { validateVerdict } from "./validate.js";
import type { CriterionVerdictShape } from "./verdict.js";
import { CriterionVerdict, criterionVerdictParseOptions } from "./verdict.js";

export interface VerifierOptions {
  /**
   * Accepted for compatibility and IGNORED: `method: "code"` criteria are evaluated by the runner,
   * which is the only place that can re-read the artifact inventory after a check has run.
   */
  readonly checks?: Registry<Check>;
  readonly runId?: string;
  /** Accepted and IGNORED — see `checks`. The runner journals a check's probe output itself. */
  readonly recordEvidence?: (entry: {
    readonly label: string;
    readonly data: unknown;
  }) => Promise<string>;
  /**
   * How many times one criterion may come back as "needs more evidence" before the verifier stops
   * asking and settles for `inconclusive`. Without this, a stubborn evaluator would spend the
   * whole action budget on the same criterion.
   *
   * This is `budgets.maxEvidenceRequests`: the CLI passes the resolved configuration's value, so
   * it is declared in `difmp.config.ts`, printed with the resolved configuration and recorded in
   * `manifest.json` like every other blocking budget. The default here exists only for a verifier
   * built outside a run (tests, probes).
   */
  readonly maxEvidenceRequests?: number;
}

/** A scripted judgement must never be presentable as a real model judgement. */
export const evaluatorFor = (provider: {
  readonly id: string;
  readonly modelId: string;
}): Evaluator =>
  provider.id === scriptedProviderId
    ? { kind: "scripted-model" }
    : { kind: "model", provider: provider.id, model: provider.modelId };

const verifierError = (
  criterionId: string,
  reason: string,
  extra: { readonly retryable?: true; readonly retryAfterMs?: number } = {},
): VerifierError => new VerifierError({ criterionId, reason, ...extra });

export const makeVerifier = (
  options: VerifierOptions = {},
): Effect.Effect<VerifierService["Service"], never, ModelProvider | Crypto.Crypto> =>
  Effect.gen(function* () {
    const provider = yield* ModelProvider;
    const evidenceRequests = yield* Ref.make<Readonly<Record<string, number>>>({});
    const maxEvidenceRequests = options.maxEvidenceRequests ?? 1;
    const evaluator = evaluatorFor(provider);
    const decodeVerdict = Schema.decodeUnknownEffect(
      CriterionVerdict,
      criterionVerdictParseOptions,
    );

    /**
     * `method: "code"` does NOT run here.
     *
     * There used to be a second implementation of the code-check path in this file, and it could
     * only see `request.evidence` — the evidence set as it was BEFORE the check ran — so it both
     * rejected the probe evidence the check had just minted and could not re-read the store to
     * check anything else. The runner owns the only code-check path (`packages/core/src/runner`):
     * it holds the run store, re-reads the artifact inventory after the check has run, and applies
     * the same evidence-integrity, absence and evidence-persistence rules to `code` and `model`
     * criteria alike. Two enforcement paths meant the weaker one decided, so there is now one.
     */
    const refuseCodeCheck = (request: VerificationRequest): Effect.Effect<never, VerifierError> =>
      Effect.fail(
        verifierError(
          request.criterion.id,
          `is declared \`method: "code"\` and must be evaluated by the runner's check path, not by the ` +
            "verifier: only the runner can re-read the artifact inventory after the check has run",
        ),
      );

    const runModelCheck = (
      request: VerificationRequest,
    ): Effect.Effect<VerificationResponse, VerifierError> =>
      Effect.gen(function* () {
        const { criterion } = request;
        // A screenshot is admissible model evidence only when the pixels are attached. Filtering
        // here also constrains verdict validation, so an adapter/capture regression cannot turn a
        // text-only screenshot label back into a citable visual observation.
        const evidence = request.evidence.filter(
          (item) =>
            item.kind !== "screenshot" ||
            (item.image !== undefined && item.image.data.byteLength > 0),
        );
        const response = yield* provider
          .generate({
            role: "verifier",
            // A dedicated call in a context of its own — the browsing conversation is never reused.
            prompt: verifierPrompt({
              criterion,
              criterionHash: request.criterionHash,
              evidence,
              scenario: request.scenario,
              baseUrl: request.baseUrl,
            }),
            responseSchema: CriterionVerdict,
            // The runner's signal, aborted by `operationTimeoutMs` or by a cancellation. Passing it
            // on is what turns "the evaluation was abandoned" into "the HTTP request was aborted".
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
          .pipe(
            // Retryability survives the error mapping: the runner retries a verification call the
            // same way it retries a browsing call, from the same `budgets.modelCallRetries`.
            Effect.mapError((error) =>
              verifierError(criterion.id, error.message, {
                ...(error.retryable ? { retryable: true } : {}),
                ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
              }),
            ),
          );

        const verdict: CriterionVerdictShape = yield* decodeVerdict(response.object).pipe(
          Effect.mapError((error) =>
            verifierError(
              criterion.id,
              formatSchemaError(error, {
                source: "verifier response",
                summary: "malformed verdict",
              }),
            ),
          ),
        );

        const usage = response.usage;
        const asked = yield* Ref.get(evidenceRequests).pipe(
          Effect.map((r) => r[criterion.id] ?? 0),
        );
        if (
          verdict.missingEvidence.length > 0 &&
          verdict.status === "inconclusive" &&
          asked < maxEvidenceRequests
        ) {
          yield* Ref.update(evidenceRequests, (r) => ({ ...r, [criterion.id]: asked + 1 }));
          return {
            outcome: {
              _tag: "needsEvidence",
              criterionId: criterion.id,
              missing: verdict.missingEvidence,
              // A request for more evidence, never a modified expectation.
              hint:
                verdict.evidenceHint ??
                "capture the state the criterion names, then re-run the check",
            },
            ...(usage === undefined ? {} : { usage }),
            modelCalls: 1,
          };
        }

        const validated = validateVerdict({
          verdict,
          criterion,
          criterionHash: request.criterionHash,
          evaluator,
          evidence,
          seq: request.seq,
        });
        return {
          outcome: { _tag: "verdict", result: validated.result },
          ...(usage === undefined ? {} : { usage }),
          modelCalls: 1,
        };
      });

    const verify = (
      request: VerificationRequest,
    ): Effect.Effect<VerificationResponse, VerifierError> =>
      request.criterion.method === "code" ? refuseCodeCheck(request) : runModelCheck(request);

    return { id: `verifier/${provider.id}`, verify };
  });

export const verifierLayer = (
  options: VerifierOptions = {},
): Layer.Layer<Verifier, never, ModelProvider | Crypto.Crypto> =>
  Layer.effect(Verifier, makeVerifier(options));
