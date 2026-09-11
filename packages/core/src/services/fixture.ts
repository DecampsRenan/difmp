import { Context, Effect, Schema } from "effect"
import type { InputsRecord } from "../domain/spec.js"
import type { StorageStateLike } from "../registry/index.js"

export class FixtureError extends Schema.TaggedError<FixtureError>()("FixtureError", {
  fixtureName: Schema.String,
  phase: Schema.Literals(["setup", "cleanup"]),
  reason: Schema.String
}) {
  override get message(): string {
    return `fixture "${this.fixtureName}" ${this.phase} failed: ${this.reason}`
  }
}

export interface FixtureSetupRequest {
  readonly fixtureName: string
  readonly runId: string
  readonly attemptId: string
  readonly inputs: InputsRecord
  readonly baseUrl: string
  /**
   * `budgets.fixtureCleanupTimeoutMs`. A setup that fails or is cancelled halfway tears down what
   * it acquired under this deadline, so the manager needs it before the session exists.
   */
  readonly cleanupTimeoutMs: number
}

export interface FixtureCleanupReport {
  readonly cleanupsRun: number
  /** True when the bounded deadline fired before every registered cleanup completed. */
  readonly timedOut: boolean
  readonly errors: ReadonlyArray<string>
}

export interface FixtureSession {
  readonly fixtureName: string
  /** Exposed as `{{ fixture.<key> }}` and visible to the model. */
  readonly publicValues: InputsRecord
  /** PRIVATE — browser only. */
  readonly storageState?: StorageStateLike
  /**
   * Every secret VALUE the fixture actually read through `ctx.secrets`. design-contracts §13 can
   * only redact what the harness was told about, so an implementation that hands out secrets must
   * report them here; the runner strips these strings from prompts, journal and reports.
   */
  readonly secretValues?: ReadonlyArray<string>
  /**
   * Runs after success, failure AND cancellation, bounded by `budgets.fixtureCleanupTimeoutMs`.
   * Never fails: problems come back in the report so they can be journalled.
   */
  readonly cleanup: (options: { readonly timeoutMs: number }) => Effect.Effect<FixtureCleanupReport>
}

export class FixtureManager extends Context.Service<FixtureManager, {
  /**
   * Cleanups are registered at ACQUISITION time, so a partially failed setup is still torn down.
   * Setup must tear down on failure AND on interruption, and must hand the fixture an
   * `AbortSignal` so a cancelled setup is aborted rather than abandoned.
   */
  readonly setup: (request: FixtureSetupRequest) => Effect.Effect<FixtureSession, FixtureError>
}>()("@harness/core/services/FixtureManager") {}
