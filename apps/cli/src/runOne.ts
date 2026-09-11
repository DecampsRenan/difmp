import type { LoadedSpec, ReportInput, ResolvedConfig, Registries, RunResult } from "@harness/core"
import {
  attemptId as makeAttemptId,
  makeRunId,
  resolveInputPrecedence,
  resolveInputs,
  RunStore,
  runScenario,
  Verifier
} from "@harness/core"
import * as BrowserPlaywright from "@harness/browser-playwright"
import { makeVerifier } from "@harness/agent-runtime"
import { Crypto, Effect, FiberSet, FileSystem, Layer, Path, Stream } from "effect"
import { ExecutionError } from "./errors.js"
import { modelProviderFor } from "./providers.js"
import { fixtureManagerLayer } from "./fixtures.js"
import { loadReportInput } from "./reportInput.js"
import type { RunBus } from "./server/bus.js"
import { dependencyVersions, harnessVersion } from "./version.js"

const attemptId = makeAttemptId(1)

export interface RunOneOptions {
  readonly spec: LoadedSpec
  /** Path recorded in the contract, relative to the config root. */
  readonly specPath: string
  readonly config: ResolvedConfig
  readonly registries: Registries
  readonly configSource: string
  /** Absolute; `--output` has already been folded into the resolved config. */
  readonly outputDir: string
  readonly headless: boolean
  readonly fileInputs?: Record<string, string | number | boolean>
  readonly cliInputs?: Record<string, string>
  /** Present only under `--ui`. A run must progress with no dashboard attached. */
  readonly bus?: RunBus
}

export interface RunOutcome {
  readonly result: RunResult
  /**
   * Absent only when even the initial manifest could not be written — the run directory then holds
   * nothing a reporter could attribute. A run that failed AFTER step 2 (fixture setup, contract
   * freeze) still has a report; `report.contract` is what is absent there.
   */
  readonly report?: ReportInput
}

/**
 * One scenario, end to end: mint the run id, assemble the service layers, run, then rebuild the
 * report input from what was PERSISTED — the same path `harness report` takes.
 */
export const runOne = (
  options: RunOneOptions
): Effect.Effect<RunOutcome, ExecutionError, FileSystem.FileSystem | Path.Path | Crypto.Crypto> =>
  Effect.gen(function*() {
    const { config, registries, spec } = options
    const runId = yield* makeRunId.pipe(
      Effect.mapError((cause) => new ExecutionError({ message: `could not mint a run id: ${cause.message}` }))
    )
    const runDirectory = `${options.outputDir}/${runId}`
    if (options.bus !== undefined) {
      yield* options.bus.startRun({ runId, directory: runDirectory, specPath: options.specPath })
    }
    // A scripted script factory needs the values the run will actually use, so the same input
    // resolution the runner performs is done here first. It is pure and deterministic, so doing it
    // twice cannot diverge; a failure is left for the runner to journal and report properly.
    const scriptInputs = yield* resolveInputPrecedence({
      source: options.configSource,
      configInputs: config.inputs,
      specInputs: spec.frontmatter.inputs ?? {},
      ...(options.fileInputs === undefined ? {} : { fileInputs: options.fileInputs }),
      ...(options.cliInputs === undefined ? {} : { cliInputs: options.cliInputs })
    }).pipe(
      Effect.flatMap((declared) =>
        resolveInputs({
          declared,
          source: spec.specPath,
          run: { id: runId },
          attempt: { id: attemptId },
          ...(spec.fieldLines === undefined ? {} : { anchors: spec.fieldLines })
        })
      ),
      Effect.orElseSucceed(() => ({}))
    )

    const provider = yield* modelProviderFor(config, spec, registries, {
      runId,
      attemptId,
      specPath: options.specPath,
      inputs: scriptInputs
    }).pipe(
      Effect.mapError((error) => new ExecutionError({ message: error.message }))
    )

    const base = Layer.mergeAll(
      RunStore.layer({ runId, outputDir: options.outputDir }),
      provider.layer,
      BrowserPlaywright.layer({
        headless: options.headless,
        launchTimeoutMs: config.budgets.operationTimeoutMs,
        // Second application of the navigation policy, inside the driver.
        allowedOrigins: config.allowedOrigins
      }),
      fixtureManagerLayer(registries)
    )

    // The verifier journals a code check's probe output through the store, so it is built once the
    // store exists rather than being wired from the outside.
    const verifier = Layer.effect(
      Verifier,
      Effect.gen(function*() {
        const store = yield* RunStore
        // Writes run on fibers owned by the LAYER's scope, not on detached root fibers: when the
        // run's scope closes, an outstanding write is interrupted instead of landing in
        // `artifacts.json` after `result.json` has been written.
        const runEvidence = yield* FiberSet.makeRuntimePromise<never, string>()
        return yield* makeVerifier({
          checks: registries.checks,
          runId,
          // A blocking budget like any other: declared in `harness.config.ts`, printed with the
          // resolved configuration, recorded in `manifest.json`.
          maxEvidenceRequests: config.budgets.maxEvidenceRequests,
          recordEvidence: (entry) =>
            runEvidence(
              Effect.gen(function*() {
                const artifactId = yield* store.mintArtifactId(attemptId)
                const relative = `attempts/${attemptId}/evidence/${artifactId}.json`
                yield* store.writeRunFile(
                  relative,
                  `${JSON.stringify({ label: entry.label, data: entry.data }, null, 2)}\n`
                )
                yield* store.recordArtifact({
                  artifactId,
                  attemptId,
                  kind: "check-evidence",
                  label: entry.label,
                  path: relative,
                  state: "present",
                  ts: new Date().toISOString()
                })
                return artifactId
              }).pipe(Effect.orDie)
            )
        })
      })
    )

    const services = verifier.pipe(Layer.provideMerge(base))

    const result = yield* Effect.gen(function*() {
      const store = yield* RunStore
      if (options.bus !== undefined) {
        const bus = options.bus
        // Fan-out to the dashboard. The store's PubSub is `dropping`, so a stalled consumer here
        // can never make the runner wait; the journal + Last-Event-ID resume is what closes gaps.
        yield* Stream.fromPubSub(store.events).pipe(
          Stream.runForEach((event) => bus.publishEvent(runId, event)),
          Effect.forkScoped
        )
      }
      return yield* runScenario({
        spec,
        specPath: options.specPath,
        config,
        registries,
        runId,
        attemptId,
        harnessVersion,
        dependencies: dependencyVersions(),
        configSource: options.configSource,
        ...(options.fileInputs === undefined ? {} : { fileInputs: options.fileInputs }),
        ...(options.cliInputs === undefined ? {} : { cliInputs: options.cliInputs }),
        ...(options.bus === undefined ? {} : { cancellation: options.bus.cancellation })
      })
    }).pipe(
      Effect.provide(services),
      Effect.scoped,
      Effect.mapError((error) => new ExecutionError({ message: error.message }))
    )

    // The initial manifest is written at spec §6 step 2, before the fixture and the freeze, so a
    // run that failed in infrastructure setup is still reportable: CI gets a JUnit file naming the
    // failure instead of an empty directory. `contract.json` may legitimately be absent.
    const fs = yield* FileSystem.FileSystem
    const reportable = yield* fs.exists(`${runDirectory}/manifest.json`).pipe(Effect.orElseSucceed(() => false))
    if (!reportable) return { result }
    const report = yield* loadReportInput(runDirectory)
    return { result, report }
  })
