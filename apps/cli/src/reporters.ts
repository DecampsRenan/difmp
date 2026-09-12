import type { ReportInput, ReportOutput, ReporterName, RunResult } from "@difmp/core"
import { Reporter } from "@difmp/core"
import type { RunOutcome } from "./runOne.js"
import { fileReporterLayer } from "@difmp/reporting"
import { Console, Effect, FileSystem, Path } from "effect"
import { ExecutionError } from "./errors.js"

export interface OutputMode {
  /** `--reporter json`: stdout carries ONE machine-parseable JSON document and nothing else. */
  readonly json: boolean
  readonly console: boolean
  readonly junit: boolean
  readonly tty: boolean
}

export interface Sink {
  /** Machine-readable stdout. Used by the JSON reporter only. */
  readonly out: (line: string) => Effect.Effect<void>
  /** Human output and diagnostics. stdout normally, stderr as soon as stdout is machine-owned. */
  readonly note: (line: string) => Effect.Effect<void>
}

export const makeSink = (mode: OutputMode): Sink => ({
  out: (line) => Console.log(line),
  note: (line) => (mode.json ? Console.error(line) : Console.log(line))
})

export const outputModeOf = (reporters: ReadonlyArray<ReporterName>, tty: boolean): OutputMode => ({
  json: reporters.includes("json"),
  console: reporters.includes("console") || !reporters.includes("json"),
  junit: reporters.includes("junit"),
  tty
})

export const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`

/** ASCII, fixed width, no animation — identical on a TTY and in a CI log. */
const statusLabel: Record<RunResult["status"], string> = {
  passed: "PASS",
  failed: "FAIL",
  inconclusive: "INCO",
  error: "ERR ",
  cancelled: "CANC"
}

const truncate = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * One block per scenario: name, status, duration, the indicative-threshold crossing when there is
 * one, and — when the verdict is not `passed` — the criteria that explain it.
 *
 * A run that died before freezing its contract still gets a report (from the initial manifest of
 * spec §6 step 2); the block says so, so a JUnit file with no criteria is never mistaken for a
 * scenario that had none. `report` itself is absent only when not even the manifest was written.
 */
export const renderRunLines = (outcome: RunOutcome): ReadonlyArray<string> => {
  const { report, result } = outcome
  const attempt = result.attempts[result.attempts.length - 1]
  const lines: Array<string> = []
  lines.push(
    `${statusLabel[result.status]}  ${result.scenarioId}  ${formatDuration(result.durationMs)}  ${result.specPath}`
  )
  if (attempt !== undefined) {
    const actions = attempt.actions
    // maxActions is INDICATIVE: crossing it is surfaced, never a refusal and never a status change.
    if (actions.guidanceExceeded) {
      lines.push(
        `      ! ${actions.used} actions / ${actions.guidance} suggested — indicative threshold only, the verdict is unchanged`
      )
    } else if (actions.used > 0 || attempt.model.calls > 0) {
      lines.push(
        `      actions ${actions.used}/${actions.guidance} suggested · model calls ${attempt.model.calls} · tokens ${
          attempt.model.inputTokens + attempt.model.outputTokens
        }`
      )
    }
    if (result.status !== "passed") {
      for (const criterion of attempt.criteria) {
        if (criterion.status === "passed") continue
        lines.push(`      ${criterion.criterionId} ${criterion.status}: ${truncate(criterion.expected, 100)}`)
        lines.push(`         observed: ${truncate(criterion.observed, 100)}`)
        if (criterion.limitations !== undefined) {
          lines.push(`         limitation: ${truncate(criterion.limitations, 100)}`)
        }
      }
    }
  }
  if (result.status === "inconclusive") {
    lines.push(`      reason: ${result.reason}${result.detail === undefined ? "" : ` — ${result.detail}`}`)
  }
  if (result.status === "error") lines.push(`      error at stage ${result.stage}: ${truncate(result.reason)}`)
  if (result.status === "cancelled") lines.push(`      cancelled: ${truncate(result.reason)}`)
  if (report !== undefined) {
    if (!report.finalized) {
      lines.push("      ! the journal was not finalised — the run was interrupted while writing")
    }
    if (report.contract === undefined) {
      lines.push("      ! the contract was never frozen — the report describes an infrastructure failure only")
    }
    lines.push(
      `      criteria: ${report.contract?.criteria.length ?? 0} · run ${result.runId} · report ${report.layout.report}`
    )
  } else {
    lines.push(`      run ${result.runId} · no report: the run directory has no manifest`)
  }
  return lines
}

export interface Tally {
  readonly passed: number
  readonly failed: number
  readonly inconclusive: number
  readonly error: number
  readonly cancelled: number
  readonly durationMs: number
}

export const tally = (results: ReadonlyArray<RunResult>): Tally =>
  results.reduce<Tally>(
    (acc, result) => ({
      passed: acc.passed + (result.status === "passed" ? 1 : 0),
      failed: acc.failed + (result.status === "failed" ? 1 : 0),
      inconclusive: acc.inconclusive + (result.status === "inconclusive" ? 1 : 0),
      error: acc.error + (result.status === "error" ? 1 : 0),
      cancelled: acc.cancelled + (result.status === "cancelled" ? 1 : 0),
      durationMs: acc.durationMs + result.durationMs
    }),
    { passed: 0, failed: 0, inconclusive: 0, error: 0, cancelled: 0, durationMs: 0 }
  )

export const renderSummaryLines = (results: ReadonlyArray<RunResult>): ReadonlyArray<string> => {
  const counts = tally(results)
  return [
    "",
    `Summary  ${results.length} scenario${results.length === 1 ? "" : "s"}  ${formatDuration(counts.durationMs)}`,
    `         ${counts.passed} passed · ${counts.failed} failed · ${counts.inconclusive} inconclusive · ${counts.error} error · ${counts.cancelled} cancelled`
  ]
}

/** The single JSON document `--reporter json` puts on stdout. */
export const renderJsonDocument = (
  harnessVersion: string,
  outcomes: ReadonlyArray<RunOutcome>
): string => {
  const counts = tally(outcomes.map((o) => o.result))
  return JSON.stringify(
    {
      schemaVersion: 1,
      harnessVersion,
      summary: {
        total: outcomes.length,
        passed: counts.passed,
        failed: counts.failed,
        inconclusive: counts.inconclusive,
        error: counts.error,
        cancelled: counts.cancelled,
        durationMs: counts.durationMs
      },
      runs: outcomes.map(({ report, result }) => ({
        runDirectory: report?.layout.root ?? null,
        report: report?.layout.report ?? null,
        junit: report?.layout.junit ?? null,
        finalized: report?.finalized ?? false,
        model: report?.manifest.model ?? null,
        result
      }))
    },
    null,
    2
  )
}

/**
 * `result.json`, `junit.xml` and `report.html` are always rendered: they are the run directory of
 * design-contracts §9 and they are what `difmp report` replays from.
 */
export const writeReportFiles = (
  input: ReportInput
): Effect.Effect<ReadonlyArray<ReportOutput>, ExecutionError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const reporter = yield* Reporter
    return yield* reporter.report(input)
  }).pipe(
    Effect.provide(fileReporterLayer(["json", "junit", "html"])),
    Effect.mapError((error) => new ExecutionError({ message: error.message }))
  )
