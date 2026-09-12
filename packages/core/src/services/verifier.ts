import { Context, Effect, Schema } from "effect"
import type { ArtifactKind, CriterionResult } from "../domain/result.js"
import type { Criterion, InputsRecord } from "../domain/spec.js"

export class VerifierError extends Schema.TaggedError<VerifierError>()("VerifierError", {
  criterionId: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return `verification of ${this.criterionId} failed: ${this.reason}`
  }
}

/** A timestamped raw observation handed to the verifier — not the browser agent's summary. */
export interface EvidenceItem {
  readonly artifactId: string
  readonly kind: ArtifactKind
  readonly label?: string
  readonly capturedAt: string
  readonly sourceSeq?: number
  /** Short textual rendering safe to put in a prompt (already redacted and escaped). */
  readonly summary: string
  /** Structured payload for code checks. Never sent to a model verbatim. */
  readonly data?: unknown
}

export interface VerificationRequest {
  readonly attemptId: string
  readonly criterion: Criterion
  /** Full sha256 of the criterion text, as frozen in the contract. */
  readonly criterionHash: string
  readonly evidence: ReadonlyArray<EvidenceItem>
  readonly scenario: {
    readonly id: string
    readonly body: string
    readonly inputs: InputsRecord
    readonly fixturePublic: InputsRecord
  }
  readonly baseUrl: string
  /** Journal seq at which this evaluation was requested. */
  readonly seq: number
  /**
   * Aborted when the run is cancelled or the evaluation exceeds `budgets.operationTimeoutMs`.
   * An implementation that calls a model MUST pass it on as `GenerateRequest.signal`, so the
   * in-flight HTTP request is aborted instead of being left to finish unobserved.
   */
  readonly signal?: AbortSignal
}

/**
 * Either a verdict, or a structured request for more evidence. The runner may continue
 * navigating within the remaining budgets — it never rewrites the expectation.
 */
export type VerificationOutcome =
  | { readonly _tag: "verdict"; readonly result: CriterionResult }
  | {
    readonly _tag: "needsEvidence"
    readonly criterionId: string
    readonly missing: ReadonlyArray<string>
    readonly hint: string
  }

export interface VerificationResponse {
  readonly outcome: VerificationOutcome
  /** Verifier consumption counts toward `budgets.maxTokens`; the reserve exists for it. */
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
  readonly modelCalls?: number
}

export class Verifier extends Context.Service<Verifier, {
  readonly id: string
  readonly verify: (request: VerificationRequest) => Effect.Effect<VerificationResponse, VerifierError>
}>()("@difmp/core/services/Verifier") {}
