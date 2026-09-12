import { Context, Effect, Schema } from "effect"
import type { HarnessEvent } from "../domain/events.js"
import type { ArtifactInventory, Manifest, RunResult } from "../domain/result.js"
import type { ScenarioContract } from "../domain/spec.js"
import type { RunLayout } from "../store/layout.js"

export class ReporterError extends Schema.TaggedError<ReporterError>()("ReporterError", {
  reporter: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return `reporter ${this.reporter}: ${this.reason}`
  }
}

/**
 * Everything a reporter is allowed to read — all of it persisted. `report <run-directory>`
 * must rebuild the HTML from exactly this, with no model call and no config re-resolution;
 * `manifest.model` is the sole source of "which adapter was used".
 */
export interface ReportInput {
  readonly layout: RunLayout
  readonly manifest: Manifest
  /**
   * Absent when the run died before the contract was frozen (a fixture-setup or input-resolution
   * failure). The reporters still produce `result.json`, `junit.xml` and `report.html` from the
   * initial manifest alone: an infrastructure failure must be reportable, or CI sees nothing.
   */
  readonly contract?: ScenarioContract
  readonly result: RunResult
  readonly inventory: ArtifactInventory
  readonly events: ReadonlyArray<HarnessEvent>
  /** False when the journal ended on a truncated line. */
  readonly finalized: boolean
}

export interface ReportOutput {
  readonly kind: "console" | "json" | "junit" | "html"
  /** Absolute path of the produced file, when the reporter writes one. */
  readonly path?: string
}

export class Reporter extends Context.Service<Reporter, {
  readonly name: string
  readonly report: (input: ReportInput) => Effect.Effect<ReadonlyArray<ReportOutput>, ReporterError>
}>()("@difmp/core/services/Reporter") {}
