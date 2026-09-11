import type {
  Check,
  CriterionResult,
  Evaluator,
  Registry,
  VerificationRequest,
  VerificationResponse,
  Verifier as VerifierService
} from "@harness/core"
import {
  decodeStrict,
  formatSchemaError,
  ModelProvider,
  verifyCriterionBinding,
  Verifier,
  VerifierError
} from "@harness/core"
import { Crypto, Effect, Layer, Ref } from "effect"
import { scriptedProviderId } from "../scripted/provider.js"
import { verifierPrompt } from "./prompt.js"
import { validateVerdict } from "./validate.js"
import type { CriterionVerdictShape } from "./verdict.js"
import { CriterionVerdict } from "./verdict.js"

export interface VerifierOptions {
  /** Needed only for `method: "code"` criteria. */
  readonly checks?: Registry<Check>
  readonly runId?: string
  /** Journals a check's probe output and returns the minted artifactId. */
  readonly recordEvidence?: (entry: { readonly label: string; readonly data: unknown }) => Promise<string>
  /**
   * How many times one criterion may come back as "needs more evidence" before the verifier stops
   * asking and settles for `inconclusive`. Without this, a stubborn evaluator would spend the
   * whole action budget on the same criterion.
   */
  readonly maxEvidenceRequests?: number
}

/** A scripted judgement must never be presentable as a real model judgement. */
export const evaluatorFor = (provider: { readonly id: string; readonly modelId: string }): Evaluator =>
  provider.id === scriptedProviderId
    ? { kind: "scripted-model" }
    : { kind: "model", provider: provider.id, model: provider.modelId }

const verifierError = (criterionId: string, reason: string): VerifierError =>
  new VerifierError({ criterionId, reason })

export const makeVerifier = (
  options: VerifierOptions = {}
): Effect.Effect<VerifierService["Service"], never, ModelProvider | Crypto.Crypto> =>
  Effect.gen(function*() {
    const provider = yield* ModelProvider
    const crypto = yield* Crypto.Crypto
    const evidenceRequests = yield* Ref.make<Readonly<Record<string, number>>>({})
    const maxEvidenceRequests = options.maxEvidenceRequests ?? 1
    const evaluator = evaluatorFor(provider)
    const decodeVerdict = decodeStrict(CriterionVerdict)

    /**
     * `method: "code"` — a registered TS check takes authority for its criterion. The binding is
     * re-hashed first, so a reordered expectation can never silently rebind a check.
     */
    const runCodeCheck = (request: VerificationRequest): Effect.Effect<CriterionResult, VerifierError> =>
      Effect.gen(function*() {
        const { criterion } = request
        const checkName = criterion.checkName
        const base: Omit<CriterionResult, "status" | "observed" | "evidence"> = {
          criterionId: criterion.id,
          criterionHash: request.criterionHash,
          method: "code",
          evaluator: { kind: "code", checkName: checkName ?? "(unbound)" },
          expected: criterion.text,
          evaluatedAtSeq: request.seq
        }
        if (checkName === undefined || options.checks === undefined) {
          return yield* Effect.fail(verifierError(
            criterion.id,
            checkName === undefined
              ? "the criterion is declared `method: code` but carries no check name"
              : `no check registry was supplied, so "${checkName}" cannot run`
          ))
        }
        const check = yield* options.checks.lookup(checkName).pipe(
          Effect.mapError((error) => verifierError(criterion.id, error.message))
        )
        yield* verifyCriterionBinding({
          checkName,
          criterionId: criterion.id,
          text: criterion.text,
          contractHash: request.criterionHash
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((error) => verifierError(criterion.id, error.message))
        )
        const outcome = yield* Effect.tryPromise({
          try: () =>
            check({
              runId: options.runId ?? "",
              attemptId: request.attemptId,
              criterion: { id: criterion.id, text: criterion.text, hash: request.criterionHash },
              inputs: request.scenario.inputs,
              fixture: { public: request.scenario.fixturePublic },
              baseUrl: request.baseUrl,
              recordEvidence: options.recordEvidence ?? (() => {
                throw new Error("recordEvidence is not wired for this verifier")
              })
            }),
          catch: (cause) => verifierError(criterion.id, cause instanceof Error ? cause.message : String(cause))
        })
        const known = new Set(request.evidence.map((item) => item.artifactId))
        const accepted = outcome.evidence.filter((id) => known.has(id))
        const rejected = outcome.evidence.filter((id) => !known.has(id))
        // A code check also cannot cite evidence that does not exist.
        const status = rejected.length > 0 && outcome.status === "passed" ? "inconclusive" : outcome.status
        return {
          ...base,
          status,
          observed: outcome.observed,
          evidence: accepted,
          ...(rejected.length === 0 ? {} : {
            limitations: `check evidence references do not exist in this attempt: ${rejected.join(", ")}`
          })
        }
      })

    const runModelCheck = (request: VerificationRequest): Effect.Effect<VerificationResponse, VerifierError> =>
      Effect.gen(function*() {
        const { criterion } = request
        const response = yield* provider.generate({
          role: "verifier",
          // A dedicated call in a context of its own — the browsing conversation is never reused.
          prompt: verifierPrompt({
            criterion,
            criterionHash: request.criterionHash,
            evidence: request.evidence,
            scenario: request.scenario,
            baseUrl: request.baseUrl
          }),
          responseSchema: CriterionVerdict
        }).pipe(Effect.mapError((error) => verifierError(criterion.id, error.message)))

        const verdict: CriterionVerdictShape = yield* decodeVerdict(response.object).pipe(
          Effect.mapError((error) =>
            verifierError(
              criterion.id,
              formatSchemaError(error, { source: "verifier response", summary: "malformed verdict" })
            )
          )
        )

        const usage = response.usage
        const asked = yield* Ref.get(evidenceRequests).pipe(Effect.map((r) => r[criterion.id] ?? 0))
        if (verdict.missingEvidence.length > 0 && verdict.status === "inconclusive" && asked < maxEvidenceRequests) {
          yield* Ref.update(evidenceRequests, (r) => ({ ...r, [criterion.id]: asked + 1 }))
          return {
            outcome: {
              _tag: "needsEvidence",
              criterionId: criterion.id,
              missing: verdict.missingEvidence,
              // A request for more evidence, never a modified expectation.
              hint: verdict.evidenceHint ?? "capture the state the criterion names, then re-run the check"
            },
            ...(usage === undefined ? {} : { usage }),
            modelCalls: 1
          }
        }

        const validated = validateVerdict({
          verdict,
          criterion,
          criterionHash: request.criterionHash,
          evaluator,
          evidence: request.evidence,
          seq: request.seq
        })
        return {
          outcome: { _tag: "verdict", result: validated.result },
          ...(usage === undefined ? {} : { usage }),
          modelCalls: 1
        }
      })

    const verify = (request: VerificationRequest): Effect.Effect<VerificationResponse, VerifierError> =>
      request.criterion.method === "code"
        ? Effect.map(runCodeCheck(request), (result) => ({
          outcome: { _tag: "verdict", result },
          modelCalls: 0
        }))
        : runModelCheck(request)

    return { id: `verifier/${provider.id}`, verify }
  })

export const verifierLayer = (
  options: VerifierOptions = {}
): Layer.Layer<Verifier, never, ModelProvider | Crypto.Crypto> => Layer.effect(Verifier, makeVerifier(options))
