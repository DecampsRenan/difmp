import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { readRunJournal, RunStore, scanJsonl } from "../src/index.js";
import { platform } from "./helpers.js";

const runId = "r_abcdefghijklm";

/** Build a RunStore rooted in a scoped temp directory. */
const withStore = <A, E, R>(
  use: (store: RunStore["Service"], fs: FileSystem.FileSystem) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "difmp-core-" });
    const store = yield* Effect.provide(RunStore, RunStore.layer({ runId, outputDir: dir }));
    return yield* use(store, fs);
  }).pipe(Effect.provide(platform));

describe("RunStore journal", () => {
  it.effect("assigns strictly increasing seq and preserves order under concurrent emits", () =>
    withStore((store, fs) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from({ length: 50 }, (_, i) => i),
          (i) =>
            store.emit({
              type: "observationTaken",
              attemptId: "a1",
              observationId: `obs_${i + 1}`,
              url: "http://127.0.0.1:3000/",
              title: `t${i}`,
              elementCount: i,
            }),
          { concurrency: "unbounded" },
        );
        const content = yield* fs.readFileString(store.layout.events);
        const scan = scanJsonl(content);
        expect(scan.truncatedTail).toBe(false);
        const seqs = scan.records.map((r) => (r as { seq: number }).seq);
        expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      }),
    ),
  );

  it.effect("writes the journal line before the event is handed to a subscriber", () =>
    withStore((store, fs) =>
      Effect.gen(function* () {
        const event = yield* store.emit({
          type: "runStarted",
          attemptId: "a1",
          specPath: "a.e2e.md",
          scenarioId: "a",
          harnessVersion: "0.1.0",
        });
        const content = yield* fs.readFileString(store.layout.events);
        expect(content).toContain(`"seq":${event.seq}`);
        expect(content.endsWith("\n")).toBe(true);
      }),
    ),
  );

  it.effect("reads back a finalised journal", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.emit({
          type: "runStarted",
          attemptId: "a1",
          specPath: "a.e2e.md",
          scenarioId: "a",
          harnessVersion: "0.1.0",
        });
        yield* store.emit({
          type: "runFinished",
          attemptId: "a1",
          status: "passed",
          criteriaCount: 1,
          failedCriteria: [],
        });
        const journal = yield* readRunJournal(store.layout.events);
        expect(journal.events.map((e) => e.type)).toEqual(["runStarted", "runFinished"]);
        expect(journal.truncatedTail).toBe(false);
        expect(journal.finalized).toBe(true);
      }),
    ),
  );

  it.effect("tolerates a truncated final line and reports the run as not finalised", () =>
    withStore((store, fs) =>
      Effect.gen(function* () {
        yield* store.emit({
          type: "runStarted",
          attemptId: "a1",
          specPath: "a.e2e.md",
          scenarioId: "a",
          harnessVersion: "0.1.0",
        });
        // Simulate a process killed mid-write.
        yield* fs.writeFileString(
          store.layout.events,
          `{"schemaVersion":1,"seq":2,"runId":"${runId}"`,
          {
            flag: "a",
          },
        );
        const journal = yield* readRunJournal(store.layout.events);
        expect(journal.events).toHaveLength(1);
        expect(journal.truncatedTail).toBe(true);
        expect(journal.finalized).toBe(false);
      }),
    ),
  );

  it.effect("reports a missing journal as not finalised instead of failing", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const journal = yield* readRunJournal(store.layout.events);
        expect(journal.events).toEqual([]);
        expect(journal.finalized).toBe(false);
      }),
    ),
  );
});

describe("RunStore artifacts", () => {
  it.effect("records a failed capture with its reason instead of hiding it", () =>
    withStore((store, fs) =>
      Effect.gen(function* () {
        const id = yield* store.mintArtifactId("a1");
        yield* store.recordArtifact({
          artifactId: id,
          attemptId: "a1",
          kind: "video",
          state: "failed",
          reason: "the video file was never produced",
          ts: "2026-09-11T00:00:00.000Z",
        });
        const inventory = JSON.parse(yield* fs.readFileString(store.layout.artifacts)) as {
          artifacts: ReadonlyArray<{ state: string; reason: string }>;
        };
        expect(inventory.artifacts).toHaveLength(1);
        expect(inventory.artifacts[0]!.state).toBe("failed");
        expect(inventory.artifacts[0]!.reason).toContain("never produced");
        // A failed artifact is not usable evidence.
        const usable = yield* store.attemptArtifacts("a1");
        expect(usable.has(id)).toBe(false);
      }),
    ),
  );

  it.effect("mints per-attempt ids in sequence", () =>
    withStore((store) =>
      Effect.gen(function* () {
        expect(yield* store.mintActionId("a1")).toBe("act_1");
        expect(yield* store.mintActionId("a1")).toBe("act_2");
        expect(yield* store.mintObservationId("a1")).toBe("obs_1");
        expect(yield* store.mintArtifactId("a1")).toBe("art_1");
        expect(yield* store.mintActionId("a2")).toBe("act_1");
      }),
    ),
  );

  it.effect("replaces result.json atomically and leaves no temp file behind", () =>
    withStore((store, fs) =>
      Effect.gen(function* () {
        const result = {
          schemaVersion: 1 as const,
          runId,
          specPath: "a.e2e.md",
          scenarioId: "a",
          contractHash: "h",
          startedAt: "2026-09-11T00:00:00.000Z",
          finishedAt: "2026-09-11T00:00:01.000Z",
          durationMs: 1000,
          attempts: [],
          finalized: true,
          status: "passed" as const,
        };
        yield* store.writeResult(result);
        yield* store.writeResult({ ...result, durationMs: 2000 });
        const written = JSON.parse(yield* fs.readFileString(store.layout.result)) as {
          durationMs: number;
        };
        expect(written.durationMs).toBe(2000);
        const entries = yield* fs.readDirectory(store.layout.root);
        expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
      }),
    ),
  );

  it.effect("keeps artifacts.json in step with memory under concurrent recordArtifact", () =>
    withStore((store, fs) =>
      Effect.gen(function* () {
        // The inventory write used to sit OUTSIDE the permit that appended to the in-memory list,
        // so two concurrent callers could serialise their snapshots in one order and land their
        // renames in the other: `artifacts.json` on disk silently lost entries the store still
        // reported (.recon/critic-jsonl-race.ts measured 64 on disk against 100 recorded).
        yield* Effect.forEach(
          Array.from({ length: 100 }, (_, i) => i),
          (i) =>
            store.recordArtifact({
              artifactId: `art_${i + 1}`,
              attemptId: "a1",
              kind: "screenshot",
              state: "present",
              ts: "2026-09-11T00:00:00.000Z",
            }),
          { concurrency: "unbounded", discard: true },
        );
        const onDisk = JSON.parse(yield* fs.readFileString(store.layout.artifacts)) as {
          artifacts: ReadonlyArray<{ artifactId: string }>;
        };
        const inMemory = yield* store.inventory;
        expect(onDisk.artifacts).toHaveLength(inMemory.artifacts.length);
        expect(onDisk.artifacts).toHaveLength(100);
        expect(new Set(onDisk.artifacts.map((a) => a.artifactId)).size).toBe(100);
      }),
    ),
  );
  it.effect("does not keep an artifact the inventory write could not persist", () =>
    withStore((store, fs) =>
      Effect.gen(function* () {
        // `artifacts.json` is the inventory of §9 and `attemptArtifacts` is what decides whether a
        // cited `art_*` is admissible; both used to be read from an in-memory list the store
        // appended to BEFORE the write, so a refused write left the store claiming an artifact the
        // file on disk had never received — and `result.json` could then cite it.
        yield* fs.makeDirectory(store.layout.artifacts, { recursive: true });
        const id = yield* store.mintArtifactId("a1");
        const written = yield* Effect.result(
          store.recordArtifact({
            artifactId: id,
            attemptId: "a1",
            kind: "screenshot",
            state: "present",
            path: `attempts/a1/screenshots/${id}.png`,
            ts: "2026-09-11T00:00:00.000Z",
          }),
        );
        expect(written._tag).toBe("Failure");
        const usable = yield* store.attemptArtifacts("a1");
        expect(usable.has(id)).toBe(false);
        const inventory = yield* store.inventory;
        expect(inventory.artifacts).toEqual([]);
      }),
    ),
  );

  it.effect("removes the temp file when an atomic write fails", () =>
    withStore((store, fs) =>
      Effect.gen(function* () {
        // The rename is the commit point; a write that never commits must not leave `.tmp-<n>`
        // behind, because nothing else ever sweeps the run directory.
        yield* fs.makeDirectory(store.layout.result, { recursive: true });
        const written = yield* Effect.result(
          store.writeResult({
            schemaVersion: 1 as const,
            runId,
            specPath: "a.e2e.md",
            scenarioId: "a",
            contractHash: "h",
            startedAt: "2026-09-11T00:00:00.000Z",
            finishedAt: "2026-09-11T00:00:01.000Z",
            durationMs: 1000,
            attempts: [],
            finalized: true,
            status: "passed" as const,
          }),
        );
        expect(written._tag).toBe("Failure");
        const entries = yield* fs.readDirectory(store.layout.root);
        expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
      }),
    ),
  );
});
