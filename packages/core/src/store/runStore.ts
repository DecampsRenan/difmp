import { Context, DateTime, Effect, FileSystem, Layer, Path, PubSub, Result, Schema, Semaphore } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { StoreError } from "../domain/errors.js"
import type { HarnessEventInput } from "../domain/events.js"
import { HarnessEvent } from "../domain/events.js"
import type { ActionId, ArtifactId, ObservationId, RunId } from "../domain/ids.js"
import { actionId as makeActionId, artifactId as makeArtifactId, observationId as makeObservationId } from "../domain/ids.js"
import type { ArtifactInventory, ArtifactRecord, Manifest, RunResult } from "../domain/result.js"
import type { ScenarioContract } from "../domain/spec.js"
import { scanJsonl, toJsonlLine } from "./jsonl.js"
import type { RunLayout } from "./layout.js"
import { makeRunLayout } from "./layout.js"

const storeError = (operation: string, path: string) => (cause: PlatformError) =>
  new StoreError({ operation, path, reason: cause.message })

interface AttemptCounters {
  action: number
  observation: number
  artifact: number
}

export interface RunStoreOptions {
  readonly runId: RunId
  readonly outputDir: string
}

export class RunStore extends Context.Service<RunStore, {
  readonly runId: RunId
  readonly layout: RunLayout
  /**
   * Append one event. `seq`, `ts`, `runId` and `schemaVersion` are stamped here, under the same
   * lock that writes the file, so ordering and strict `seq` monotonicity hold. The journal write
   * happens BEFORE the live fan-out.
   */
  readonly emit: (event: HarnessEventInput) => Effect.Effect<HarnessEvent, StoreError>
  readonly mintActionId: (attemptId: string) => Effect.Effect<ActionId>
  readonly mintObservationId: (attemptId: string) => Effect.Effect<ObservationId>
  readonly mintArtifactId: (attemptId: string) => Effect.Effect<ArtifactId>
  /** Records the artifact in the inventory AND emits `artifactAvailable`. */
  readonly recordArtifact: (record: ArtifactRecord) => Effect.Effect<void, StoreError>
  /** artifactIds known for an attempt — used to reject invented evidence references. */
  readonly attemptArtifacts: (attemptId: string) => Effect.Effect<ReadonlySet<string>>
  readonly inventory: Effect.Effect<ArtifactInventory>
  readonly writeSpecCopy: (content: string) => Effect.Effect<void, StoreError>
  readonly writeContract: (contract: ScenarioContract) => Effect.Effect<void, StoreError>
  readonly writeManifest: (manifest: Manifest) => Effect.Effect<void, StoreError>
  readonly writeResult: (result: RunResult) => Effect.Effect<void, StoreError>
  /** Atomic replace of an arbitrary file under the run directory (reporters use this). */
  readonly writeRunFile: (relativePath: string, content: string) => Effect.Effect<void, StoreError>
  readonly ensureAttemptDirs: (attemptId: string) => Effect.Effect<void, StoreError>
  /** Live fan-out for the SSE server. The runner never depends on a subscriber existing. */
  readonly events: PubSub.PubSub<HarnessEvent>
}>()("@harness/core/store/RunStore") {
  static readonly layer = (
    options: RunStoreOptions
  ): Layer.Layer<RunStore, StoreError, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(RunStore, make(options))
}

const make = (options: RunStoreOptions) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const layout = makeRunLayout(path, options.outputDir, options.runId)

    yield* fs.makeDirectory(layout.root, { recursive: true }).pipe(
      Effect.mapError(storeError("makeDirectory", layout.root))
    )

    const lock = yield* Semaphore.make(1)
    const events = yield* PubSub.dropping<HarnessEvent>({ capacity: 1024, replay: 64 })

    let seq = 0
    const counters = new Map<string, AttemptCounters>()
    const artifacts: Array<ArtifactRecord> = []
    let tempCounter = 0

    const countersFor = (attemptId: string): AttemptCounters => {
      const existing = counters.get(attemptId)
      if (existing !== undefined) return existing
      const fresh: AttemptCounters = { action: 0, observation: 0, artifact: 0 }
      counters.set(attemptId, fresh)
      return fresh
    }

    const atomicWrite = (target: string, content: string) =>
      Effect.gen(function*() {
        const temp = `${target}.tmp-${++tempCounter}`
        yield* fs.writeFileString(temp, content).pipe(Effect.mapError(storeError("write", temp)))
        yield* fs.rename(temp, target).pipe(Effect.mapError(storeError("rename", target)))
      })

    const writeInventory = Effect.suspend(() =>
      atomicWrite(
        layout.artifacts,
        `${JSON.stringify({ schemaVersion: 1, runId: options.runId, artifacts }, null, 2)}\n`
      )
    )

    const emit = (input: HarnessEventInput): Effect.Effect<HarnessEvent, StoreError> =>
      lock.withPermits(1)(
        Effect.gen(function*() {
          const now = yield* DateTime.now
          const event = {
            schemaVersion: 1,
            seq: ++seq,
            runId: options.runId,
            ts: DateTime.formatIso(now),
            ...input
          } as HarnessEvent
          // Journal first, live fan-out second — a subscriber can never observe an unjournalled event.
          yield* fs.writeFileString(layout.events, toJsonlLine(event), { flag: "a" }).pipe(
            Effect.mapError(storeError("append", layout.events))
          )
          yield* PubSub.publish(events, event)
          return event
        })
      )

    const recordArtifact = (record: ArtifactRecord) =>
      Effect.gen(function*() {
        yield* lock.withPermits(1)(Effect.sync(() => {
          artifacts.push(record)
        }))
        yield* writeInventory
        yield* emit({
          type: "artifactAvailable",
          attemptId: record.attemptId,
          artifactId: record.artifactId,
          kind: record.kind,
          state: record.state,
          ...(record.path === undefined ? {} : { path: record.path }),
          ...(record.reason === undefined ? {} : { reason: record.reason }),
          ...(record.sourceSeq === undefined ? {} : { sourceSeq: record.sourceSeq })
        })
      })

    const mint = <A>(attemptId: string, field: keyof AttemptCounters, render: (n: number) => A) =>
      lock.withPermits(1)(Effect.sync(() => {
        const c = countersFor(attemptId)
        c[field] += 1
        return render(c[field])
      }))

    return RunStore.of({
      runId: options.runId,
      layout,
      emit,
      mintActionId: (attemptId) => mint(attemptId, "action", makeActionId),
      mintObservationId: (attemptId) => mint(attemptId, "observation", makeObservationId),
      mintArtifactId: (attemptId) => mint(attemptId, "artifact", makeArtifactId),
      recordArtifact,
      attemptArtifacts: (attemptId) =>
        Effect.sync(() =>
          new Set(artifacts.filter((a) => a.attemptId === attemptId && a.state === "present").map((a) => a.artifactId))
        ),
      inventory: Effect.sync(() => ({ schemaVersion: 1 as const, runId: options.runId, artifacts: [...artifacts] })),
      writeSpecCopy: (content) => atomicWrite(layout.spec, content),
      writeContract: (contract) => atomicWrite(layout.contract, `${JSON.stringify(contract, null, 2)}\n`),
      writeManifest: (manifest) => atomicWrite(layout.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
      writeResult: (result) => atomicWrite(layout.result, `${JSON.stringify(result, null, 2)}\n`),
      writeRunFile: (relativePath, content) =>
        Effect.gen(function*() {
          const target = path.join(layout.root, relativePath)
          yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
            Effect.mapError(storeError("makeDirectory", target))
          )
          yield* atomicWrite(target, content)
        }),
      ensureAttemptDirs: (attemptId) =>
        Effect.forEach(
          [layout.attemptDir(attemptId), layout.screenshotsDir(attemptId)],
          (dir) => fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(storeError("makeDirectory", dir))),
          { discard: true }
        ),
      events
    })
  })

export interface RunJournal {
  readonly events: ReadonlyArray<HarnessEvent>
  /** The last JSONL line was incomplete: the process was interrupted while writing. */
  readonly truncatedTail: boolean
  /** True only when a `runFinished` event was journalled and nothing is truncated. */
  readonly finalized: boolean
  readonly invalid: ReadonlyArray<{ readonly line: number; readonly reason: string }>
  readonly undecodable: ReadonlyArray<{ readonly seq: number | undefined; readonly reason: string }>
}

const decodeEvent = Schema.decodeUnknownResult(HarnessEvent)

/**
 * Reload a run journal. Tolerates a truncated final line and reports the run as not finalised,
 * exactly as design-contracts §6 requires.
 */
export const readRunJournal = (
  eventsPath: string
): Effect.Effect<RunJournal, StoreError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(eventsPath).pipe(Effect.mapError(storeError("exists", eventsPath)))
    if (!exists) {
      return { events: [], truncatedTail: false, finalized: false, invalid: [], undecodable: [] }
    }
    const content = yield* fs.readFileString(eventsPath).pipe(Effect.mapError(storeError("read", eventsPath)))
    const scan = scanJsonl(content)
    const events: Array<HarnessEvent> = []
    const undecodable: Array<{ seq: number | undefined; reason: string }> = []
    for (const record of scan.records) {
      const decoded = decodeEvent(record)
      if (Result.isSuccess(decoded)) {
        events.push(decoded.success)
      } else {
        const seq = typeof record === "object" && record !== null && "seq" in record
          ? (record as { seq?: unknown }).seq
          : undefined
        undecodable.push({
          seq: typeof seq === "number" ? seq : undefined,
          reason: decoded.failure.message
        })
      }
    }
    const finalized = !scan.truncatedTail && events.some((e) => e.type === "runFinished")
    return { events, truncatedTail: scan.truncatedTail, finalized, invalid: scan.invalid, undecodable }
  })
