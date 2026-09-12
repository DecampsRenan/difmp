import { Context, Effect, Schema } from "effect"
import type { Scope } from "effect/Scope"
import type { CaptureConfig } from "../domain/config.js"
import type { ArtifactKind, ArtifactState } from "../domain/result.js"
import type { InteractionResult, NavigateResult, ObserveResult } from "../domain/tools.js"
import type { StorageStateLike } from "../registry/index.js"

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  operation: Schema.String,
  kind: Schema.Literals(["launch", "navigation", "stale-reference", "timeout", "capture", "closed", "other"]),
  reason: Schema.String
}) {
  override get message(): string {
    return `browser/${this.kind} during ${this.operation}: ${this.reason}`
  }
}

/** Mirrors the artifact inventory so a capture failure is recorded, never hidden. */
export interface CaptureOutcome {
  readonly kind: ArtifactKind
  readonly state: ArtifactState
  readonly label?: string
  readonly path?: string
  readonly reason?: string
  readonly bytes?: number
}

export interface ConsoleEntry {
  readonly ts: string
  readonly level: string
  readonly text: string
}

export interface NetworkEntry {
  readonly ts: string
  readonly method: string
  readonly url: string
  readonly status?: number
  readonly failure?: string
}

export interface OpenContextOptions {
  readonly attemptId: string
  readonly baseUrl: string
  /** PRIVATE fixture output — the browser gets it, the model never does. */
  readonly storageState?: StorageStateLike
  readonly capture: CaptureConfig
  /** Where trace / video / screenshots for this attempt are written. */
  readonly attemptDir: string
  readonly screenshotsDir: string
  readonly operationTimeoutMs: number
}

/**
 * One live browser context. Exactly ONE `observationId` is valid at a time: a ref from an older
 * observation must be rejected WITHOUT touching the page, and the agent asked to re-observe.
 * `observe` is the only thing allowed to take an accessibility snapshot.
 */
export interface BrowserSession {
  readonly observe: (observationId: string) => Effect.Effect<ObserveResult, BrowserError>
  readonly navigate: (params: { readonly url: string }) => Effect.Effect<NavigateResult, BrowserError>
  readonly click: (
    params: { readonly observationId: string; readonly ref: string }
  ) => Effect.Effect<InteractionResult, BrowserError>
  readonly fill: (
    params: { readonly observationId: string; readonly ref: string; readonly value: string }
  ) => Effect.Effect<InteractionResult, BrowserError>
  readonly press: (
    params: { readonly observationId?: string; readonly ref?: string; readonly key: string }
  ) => Effect.Effect<InteractionResult, BrowserError>
  readonly scroll: (
    params: { readonly direction: "up" | "down"; readonly amount?: number }
  ) => Effect.Effect<InteractionResult, BrowserError>
  /** Never fails the run: an unsuccessful capture comes back as a `failed` CaptureOutcome. */
  readonly screenshot: (
    params: { readonly fileName: string; readonly label?: string; readonly fullPage?: boolean }
  ) => Effect.Effect<CaptureOutcome>
  readonly currentUrl: Effect.Effect<string, BrowserError>
  readonly consoleEntries: Effect.Effect<ReadonlyArray<ConsoleEntry>>
  readonly networkEntries: Effect.Effect<ReadonlyArray<NetworkEntry>>
  /**
   * Close the context and settle trace/video. Called on success, failure AND cancellation;
   * must never throw and must report every expected artifact's final state.
   */
  readonly finalize: (options: { readonly retainTrace: boolean }) => Effect.Effect<ReadonlyArray<CaptureOutcome>>
}

export class BrowserDriver extends Context.Service<BrowserDriver, {
  readonly id: string
  /** Scoped: closing the scope must close the context and prevent any late action. */
  readonly openContext: (
    options: OpenContextOptions
  ) => Effect.Effect<BrowserSession, BrowserError, Scope>
}>()("@difmp/core/services/BrowserDriver") {}
