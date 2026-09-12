import type { InputsRecord, RunResult } from "@difmp/core"
import { SpecLoader } from "@difmp/core"
import { Crypto, Deferred, Effect, FileSystem, Option, Path } from "effect"
import { resolve } from "node:path"
import { Cancelled, ExecutionError, ScenariosNotPassing, UsageError } from "../errors.js"
import { describeConfig, toOverrides } from "../overrides.js"
import { loadProject } from "../project.js"
import {
  makeSink,
  outputModeOf,
  renderJsonDocument,
  renderRunLines,
  renderSummaryLines
} from "../reporters.js"
import type { RunOutcome } from "../runOne.js"
import { runOne } from "../runOne.js"
import { selectSpecs } from "../select.js"
import type { RunBus } from "../server/bus.js"
import { makeRunBus } from "../server/bus.js"
import { openUiServer } from "../server/server.js"
import { harnessVersion } from "../version.js"
import type { RunFlags } from "./types.js"

/**
 * `difmp run` — discover, execute once, report, exit.
 *
 * Precedence, highest first: `--input` > `--inputs-file` > spec frontmatter > config `inputs`
 * for scenario data; CLI execution flags > `difmp.config.ts` > built-in defaults for everything
 * else.
 */
export const runHandler = (flags: RunFlags): Effect.Effect<
  void,
  Cancelled | ExecutionError | ScenariosNotPassing | UsageError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function*() {
    const cwd = process.cwd()
    const overrides = yield* toOverrides(flags)
    const project = yield* loadProject({
      cwd,
      ...(Option.isSome(flags.config) ? { configPath: flags.config.value } : {}),
      overrides
    })

    const selection = yield* selectSpecs({
      cwd,
      root: project.location.root,
      config: project.config,
      patterns: flags.paths,
      tags: flags.tag,
      source: project.location.source
    }).pipe(Effect.provide(SpecLoader.layer))

    const outputDir = resolve(project.location.root, project.config.outputDir)
    const mode = outputModeOf(project.config.reporters, process.stdout.isTTY === true)
    const sink = makeSink(mode)
    const note = (lines: ReadonlyArray<string>) => Effect.forEach(lines, sink.note, { discard: true })

    // The resolved configuration is printed before launch whatever the reporter is; under
    // `--reporter json` it lands on stderr so stdout stays machine-parseable.
    yield* note(describeConfig({
      config: project.config,
      source: project.location.source,
      outputDir,
      specs: selection.relativePaths
    }))
    yield* sink.note("")

    const fileInputs = Option.getOrUndefined(flags.inputsFile) as InputsRecord | undefined
    const outcomes: Array<RunOutcome> = []
    const results: Array<RunResult> = []

    yield* Effect.scoped(Effect.gen(function*() {
      let bus: RunBus | undefined
      if (flags.ui) {
        bus = yield* makeRunBus()
        const server = yield* openUiServer({
          bus,
          state: () => ({
            harnessVersion,
            config: project.config,
            scenarios: selection.relativePaths,
            completed: results.length,
            total: selection.specs.length
          }),
          host: flags.uiHost,
          port: flags.uiPort
        })
        yield* sink.note(`Live dashboard  ${server.url}`)
        if (server.host !== "127.0.0.1" && server.host !== "localhost" && server.host !== "::1") {
          yield* sink.note(`  ! --ui-host ${server.host} is NOT loopback: the dashboard is reachable from the network.`)
        }
        yield* sink.note("")
        yield* bus.publish("cliStarted", { harnessVersion, scenarios: selection.relativePaths })
      }

      for (let index = 0; index < selection.specs.length; index++) {
        const spec = selection.specs[index]!
        const specPath = selection.relativePaths[index]!
        // `runOne` announces the scenario on the bus once it has minted the run id, so the
        // dashboard can point `/api/contract` and `/api/artifacts/*` at the right run directory.
        if (bus !== undefined && (yield* isCancelled(bus))) break

        const outcome = yield* runOne({
          spec,
          specPath,
          config: project.config,
          registries: project.registries,
          configSource: project.location.source,
          outputDir,
          headless: !flags.headed,
          ...(fileInputs === undefined ? {} : { fileInputs }),
          ...(Object.keys(flags.input).length === 0 ? {} : { cliInputs: flags.input }),
          ...(bus === undefined ? {} : { bus })
        })

        // `result.json`, `junit.xml` and `report.html` are written by `runOne` itself, inside the
        // region that survives a Ctrl-C: doing it here meant an interrupted run lost two of the
        // three (see the comment on `runOne`).
        outcomes.push(outcome)
        results.push(outcome.result)

        if (bus !== undefined) {
          yield* bus.publish("scenarioFinished", {
            specPath,
            status: outcome.result.status,
            runDirectory: outcome.report?.layout.root ?? null,
            report: outcome.report?.layout.report ?? null
          })
        }
        if (mode.console) yield* note(renderRunLines(outcome))
      }

      if (bus !== undefined) {
        yield* bus.publish("cliFinished", { completed: results.length, total: selection.specs.length })
        // Give open SSE connections a beat to flush the final frames before the scope closes.
        yield* Effect.sleep("150 millis")
        yield* bus.close
      }
    }))

    if (mode.console) yield* note(renderSummaryLines(results))
    if (mode.json) yield* sink.out(renderJsonDocument(harnessVersion, outcomes))

    return yield* exitFor(results)
  })

/** A dashboard cancellation stops the whole invocation: remaining scenarios are not started. */
const isCancelled = (bus: RunBus) => Deferred.isDone(bus.cancellation)

/**
 * Aggregation, in order: an explicit cancellation is a user interrupt (130); a blocking execution
 * error is an execution error (2); anything `failed` or `inconclusive` is 1; everything else is 0.
 */
const exitFor = (
  results: ReadonlyArray<RunResult>
): Effect.Effect<void, Cancelled | ExecutionError | ScenariosNotPassing> =>
  Effect.suspend((): Effect.Effect<void, Cancelled | ExecutionError | ScenariosNotPassing> => {
    const cancelled = results.find((r) => r.status === "cancelled")
    if (cancelled !== undefined && cancelled.status === "cancelled") {
      return Effect.fail(new Cancelled({ reason: cancelled.reason }))
    }
    const errored = results.find((r) => r.status === "error")
    if (errored !== undefined && errored.status === "error") {
      return Effect.fail(new ExecutionError({ message: `${errored.specPath}: ${errored.reason}` }))
    }
    const failed = results.filter((r) => r.status === "failed").length
    const inconclusive = results.filter((r) => r.status === "inconclusive").length
    if (failed + inconclusive > 0) return Effect.fail(new ScenariosNotPassing({ failed, inconclusive }))
    return Effect.void
  })
