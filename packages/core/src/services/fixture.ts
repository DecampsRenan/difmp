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
   * Runs after success, failure AND cancellation, bounded by `budgets.fixtureCleanupTimeoutMs`.
   * Never fails: problems come back in the report so they can be journalled.
   */
  readonly cleanup: (options: { readonly timeoutMs: number }) => Effect.Effect<FixtureCleanupReport>
}

export class FixtureManager extends Context.Service<FixtureManager, {
  /** Cleanups are registered at ACQUISITION time, so a partially failed setup is still torn down. */
  readonly setup: (request: FixtureSetupRequest) => Effect.Effect<FixtureSession, FixtureError>
}>()("@harness/core/services/FixtureManager") {}
