import type { ReportInput } from "@harness/core"
import {
  ArtifactInventory,
  Manifest,
  makeRunLayout,
  readRunJournal,
  RunResult,
  ScenarioContract
} from "@harness/core"
import { Effect, FileSystem, Path, Schema } from "effect"
import { ExecutionError } from "./errors.js"

const decodeManifest = Schema.decodeUnknownEffect(Manifest)
const decodeContract = Schema.decodeUnknownEffect(ScenarioContract)
const decodeResult = Schema.decodeUnknownEffect(RunResult)
const decodeInventory = Schema.decodeUnknownEffect(ArtifactInventory)

const readJson = (file: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const raw = yield* fs.readFileString(file).pipe(
      Effect.mapError((cause) => new ExecutionError({ message: `${file}: ${cause.message}` }))
    )
    return yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new ExecutionError({ message: `${file}: not valid JSON — ${cause instanceof Error ? cause.message : String(cause)}` })
    })
  })

const decoded = <A>(
  file: string,
  decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>
) =>
  readJson(file).pipe(
    Effect.flatMap((value) =>
      decode(value).pipe(
        Effect.mapError((error) => new ExecutionError({ message: `${file}: ${error.message}` }))
      )
    )
  )

/**
 * Rebuild everything a reporter is allowed to read from the PERSISTED run directory only —
 * no model call, no replay, no config re-resolution. `manifest.json` is the sole source of
 * "which adapter was used" (design-contracts §14.7). `harness report` and the post-run reporting
 * pass go through this same function, so the two can never drift.
 */
export const loadReportInput = (
  runDirectory: string
): Effect.Effect<ReportInput, ExecutionError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.resolve(runDirectory)
    const exists = yield* fs.exists(root).pipe(
      Effect.mapError((cause) => new ExecutionError({ message: `${root}: ${cause.message}` }))
    )
    if (!exists) {
      return yield* Effect.fail(new ExecutionError({ message: `${root}: no such run directory` }))
    }
    const layout = makeRunLayout(path, path.dirname(root), path.basename(root))

    const manifest = yield* decoded(layout.manifest, decodeManifest)
    const contract = yield* decoded(layout.contract, decodeContract)
    const result = yield* decoded(layout.result, decodeResult)

    const inventoryExists = yield* fs.exists(layout.artifacts).pipe(
      Effect.mapError((cause) => new ExecutionError({ message: `${layout.artifacts}: ${cause.message}` }))
    )
    const inventory = inventoryExists
      ? yield* decoded(layout.artifacts, decodeInventory)
      : { schemaVersion: 1 as const, runId: manifest.runId, artifacts: [] }

    const journal = yield* readRunJournal(layout.events).pipe(
      Effect.mapError((error) => new ExecutionError({ message: error.message }))
    )

    return {
      layout,
      manifest,
      contract,
      result,
      inventory,
      events: journal.events,
      finalized: journal.finalized
    }
  })
