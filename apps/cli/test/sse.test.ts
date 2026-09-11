import { Deferred, Effect, Fiber } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeFrameEncoder, makeRunBus, openUiServer, parseCursor } from "../src/index.js"
import type { RunBus, UiMessage } from "../src/index.js"

interface Frame {
  readonly id: number
  readonly event: string
  readonly data: UiMessage
}

/**
 * Read `count` SSE frames, then hang up. Hanging up mid-stream is the disconnect half of the
 * resume test: the server's per-request scope closes and the subscriber queue is unregistered.
 */
const readFrames = async (
  url: string,
  options: { readonly lastEventId?: number; readonly count: number; readonly timeoutMs?: number }
): Promise<ReadonlyArray<Frame>> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000)
  const frames: Array<Frame> = []
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: options.lastEventId === undefined ? {} : { "last-event-id": String(options.lastEventId) }
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (frames.length < options.count) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const lines = raw.split("\n")
        const id = Number(lines.find((l) => l.startsWith("id: "))!.slice(4))
        const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message"
        const data = JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)) as UiMessage
        frames.push({ id, event, data })
        // Stop at exactly `count`: bytes already in flight are dropped, which is precisely what a
        // client that disappears mid-stream does.
        if (frames.length >= options.count) break
        boundary = buffer.indexOf("\n\n")
      }
    }
    await reader.cancel().catch(() => {})
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return frames
}

const withServer = <A>(
  use: (context: { readonly bus: RunBus; readonly url: string }) => Effect.Effect<A>,
  options: { readonly clientCapacity?: number } = {}
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const bus = yield* makeRunBus(
          options.clientCapacity === undefined ? {} : { clientCapacity: options.clientCapacity }
        )
        const server = yield* openUiServer({ bus, state: () => ({ ok: true }), port: 0 })
        return yield* use({ bus, url: server.url })
      })
    ).pipe(Effect.orDie)
  )

describe("SSE resume from Last-Event-ID", () => {
  it("replays from the journal, then streams live, with no gap and no duplicate", async () => {
    const frames = await withServer(({ bus, url }) =>
      Effect.gen(function*() {
        for (let n = 1; n <= 6; n++) yield* bus.publish("tick", { n })

        // First connection: read part of the backlog, then disconnect.
        const first = yield* Effect.promise(() => readFrames(`${url}api/events`, { count: 4 }))
        expect(first.map((f) => f.id)).toEqual([1, 2, 3, 4])

        // Events published while nobody is listening are still journalled.
        for (let n = 7; n <= 9; n++) yield* bus.publish("tick", { n })

        // Reconnect exactly where the client stopped.
        const resumeFrom = first[first.length - 1]!.id
        const second = yield* Effect.promise(() =>
          readFrames(`${url}api/events`, { lastEventId: resumeFrom, count: 5 })
        )
        return { first, second }
      })
    )

    expect(frames.second.map((f) => f.id)).toEqual([5, 6, 7, 8, 9])

    const all = [...frames.first, ...frames.second].map((f) => f.id)
    // Ordered, contiguous, and each seq delivered exactly once across the two connections.
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(new Set(all).size).toBe(all.length)
    expect(frames.second.map((f) => (f.data.data as { n: number }).n)).toEqual([5, 6, 7, 8, 9])
  })

  it("delivers events published after the connection opened", async () => {
    const delivered = await withServer(({ bus, url }) =>
      Effect.gen(function*() {
        yield* bus.publish("before", {})
        const reading = yield* Effect.forkChild(
          Effect.promise(() => readFrames(`${url}api/events`, { count: 3 }))
        )
        yield* Effect.sleep("150 millis")
        yield* bus.publish("during", { k: 1 })
        yield* bus.publish("during", { k: 2 })
        return yield* Fiber.join(reading)
      })
    )
    expect(delivered.map((f) => f.event)).toEqual(["before", "during", "during"])
    expect(delivered.map((f) => f.id)).toEqual([1, 2, 3])
  })

  it("a reconnect past the end of the journal simply waits for the next event", async () => {
    const delivered = await withServer(({ bus, url }) =>
      Effect.gen(function*() {
        yield* bus.publish("tick", { n: 1 })
        const reading = yield* Effect.forkChild(
          Effect.promise(() => readFrames(`${url}api/events`, { lastEventId: 1, count: 1 }))
        )
        yield* Effect.sleep("150 millis")
        yield* bus.publish("tick", { n: 2 })
        return yield* Fiber.join(reading)
      })
    )
    expect(delivered.map((f) => f.id)).toEqual([2])
  })

  it("a client that never drains is bounded and never makes the publisher wait", async () => {
    const measured = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const bus = yield* makeRunBus({ clientCapacity: 2 })
          // Registered, never read: the queue fills after two messages and drops the rest.
          const subscriber = yield* bus.subscribe
          const started = Date.now()
          for (let n = 1; n <= 500; n++) yield* bus.publish("flood", { n })
          return {
            elapsed: Date.now() - started,
            journal: bus.journal().length,
            // The journal is complete even though this client's queue is not.
            replayable: subscriber.snapshotAfter(0).length
          }
        })
      )
    )
    expect(measured.journal).toBe(500)
    expect(measured.replayable).toBe(500)
    expect(measured.elapsed).toBeLessThan(2000)
  })

  it("a client that fell behind catches up completely by reconnecting from its cursor", async () => {
    const ids = await withServer(
      ({ bus, url }) =>
        Effect.gen(function*() {
          for (let n = 1; n <= 300; n++) yield* bus.publish("flood", { n })
          const caught = yield* Effect.promise(() =>
            readFrames(`${url}api/events`, { lastEventId: 0, count: 300, timeoutMs: 10_000 })
          )
          return caught.map((f) => f.id)
        }),
      { clientCapacity: 2 }
    )
    expect(ids).toEqual(Array.from({ length: 300 }, (_, i) => i + 1))
  })

  it("POST /api/cancel completes the cancellation deferred and answers 202", async () => {
    const body = await withServer(({ bus, url }) =>
      Effect.gen(function*() {
        const response = yield* Effect.promise(() =>
          fetch(`${url}api/cancel`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "from a test" })
          })
        )
        expect(response.status).toBe(202)
        const json = yield* Effect.promise(() => response.json() as Promise<{ accepted: boolean; reason: string }>)
        const reason = yield* Deferred.await(bus.cancellation)
        return { json, reason }
      })
    )
    expect(body.json).toEqual({ accepted: true, reason: "from a test" })
    expect(body.reason).toBe("from a test")
  })

  it("serves the dashboard and a state snapshot with no client attached", async () => {
    const result = await withServer(({ url }) =>
      Effect.promise(async () => {
        const index = await fetch(url)
        const state = await fetch(`${url}api/state`)
        const health = await fetch(`${url}api/health`)
        return {
          indexType: index.headers.get("content-type"),
          indexBody: await index.text(),
          state: (await state.json()) as { state: unknown; lastEventId: number; subscribers: number },
          health: health.status
        }
      })
    )
    expect(result.indexType).toContain("text/html")
    expect(result.indexBody).toContain("<!doctype html>")
    expect(result.state).toMatchObject({ state: { ok: true }, lastEventId: 0, subscribers: 0 })
    expect(result.health).toBe(204)
  })
})

describe("frame encoding", () => {
  const journal: ReadonlyArray<UiMessage> = Array.from({ length: 6 }, (_, i) => ({
    seq: i + 1,
    ts: "2026-01-01T00:00:00.000Z",
    type: "tick",
    data: { n: i + 1 }
  }))

  const seqsIn = (frames: string): ReadonlyArray<number> =>
    [...frames.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))

  it("fills a gap from the journal when a slow client missed live messages", () => {
    const encode = makeFrameEncoder(() => journal, 0)
    expect(seqsIn(encode(journal[0]!))).toEqual([1])
    // Messages 2 and 3 were dropped for this client; delivering 4 must not skip them.
    expect(seqsIn(encode(journal[3]!))).toEqual([2, 3, 4])
    expect(seqsIn(encode(journal[4]!))).toEqual([5])
  })

  it("never re-emits a message the connection already received", () => {
    const encode = makeFrameEncoder(() => journal, 3)
    // The replay snapshot and the live queue overlap; the overlap is dropped, not duplicated.
    expect(encode(journal[0]!)).toBe("")
    expect(encode(journal[2]!)).toBe("")
    expect(seqsIn(encode(journal[3]!))).toEqual([4])
  })

  it("parses a Last-Event-ID cursor defensively", () => {
    expect(parseCursor(undefined)).toBe(0)
    expect(parseCursor("")).toBe(0)
    expect(parseCursor("12")).toBe(12)
    expect(parseCursor("-4")).toBe(0)
    expect(parseCursor("nonsense")).toBe(0)
    expect(parseCursor("7.9")).toBe(7)
  })
})

describe("endpoints the live UI consumes", () => {
  it("streams RAW HarnessEvents on /api/ui/events, named by type, id = the run's own seq", async () => {
    const frames = await withServer(({ bus, url }) =>
      Effect.gen(function*() {
        yield* bus.publishEvent("r_aaaaaaaaaaaaa", {
          schemaVersion: 1,
          seq: 1,
          runId: "r_aaaaaaaaaaaaa",
          ts: "2026-01-01T00:00:00.000Z",
          type: "runStarted",
          attemptId: "a1",
          specPath: "tests/a.e2e.md",
          scenarioId: "a",
          harnessVersion: "0.1.0"
        })
        yield* bus.publishEvent("r_aaaaaaaaaaaaa", {
          schemaVersion: 1,
          seq: 2,
          runId: "r_aaaaaaaaaaaaa",
          ts: "2026-01-01T00:00:01.000Z",
          type: "runFinished",
          status: "passed",
          durationMs: 10
        })
        return yield* Effect.promise(() => readFrames(`${url}api/ui/events`, { count: 2 }))
      })
    )
    expect(frames.map((f) => f.event)).toEqual(["runStarted", "runFinished"])
    expect(frames.map((f) => f.id)).toEqual([1, 2])
    // The payload is the event itself, not an envelope: that is what the UI's guard accepts.
    expect((frames[0]!.data as unknown as { type: string }).type).toBe("runStarted")
  })

  it("serves the frozen contract of the run being followed, and 404s before there is one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-contract-"))
    try {
      const result = await withServer(({ bus, url }) =>
        Effect.gen(function*() {
          const before = yield* Effect.promise(() => fetch(`${url}api/contract`))
          yield* bus.startRun({ runId: "r_aaaaaaaaaaaaa", directory: dir, specPath: "tests/a.e2e.md" })
          const notFrozen = yield* Effect.promise(() => fetch(`${url}api/contract`))
          writeFileSync(join(dir, "contract.json"), JSON.stringify({ id: "a", criteria: [] }), "utf8")
          const frozen = yield* Effect.promise(() => fetch(`${url}api/contract`))
          return {
            before: before.status,
            notFrozen: notFrozen.status,
            frozen: frozen.status,
            body: yield* Effect.promise(() => frozen.json() as Promise<{ id: string }>)
          }
        })
      )
      expect(result.before).toBe(404)
      expect(result.notFrozen).toBe(404)
      expect(result.frozen).toBe(200)
      expect(result.body.id).toBe("a")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("serves artifacts by their run-relative path and refuses to escape the run directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-artifacts-"))
    try {
      mkdirSync(join(dir, "attempts", "a1", "screenshots"), { recursive: true })
      writeFileSync(join(dir, "attempts", "a1", "screenshots", "final.txt"), "evidence", "utf8")
      const result = await withServer(({ bus, url }) =>
        Effect.gen(function*() {
          yield* bus.startRun({ runId: "r_aaaaaaaaaaaaa", directory: dir, specPath: "tests/a.e2e.md" })
          const ok = yield* Effect.promise(() =>
            fetch(`${url}api/artifacts/attempts/a1/screenshots/final.txt`)
          )
          const escape = yield* Effect.promise(() => fetch(`${url}api/artifacts/..%2f..%2fetc%2fpasswd`))
          return { ok: ok.status, body: yield* Effect.promise(() => ok.text()), escape: escape.status }
        })
      )
      expect(result.ok).toBe(200)
      expect(result.body).toBe("evidence")
      expect(result.escape).toBe(404)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resets the UI cursor for each scenario, because the UI follows exactly one run", async () => {
    const journals = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const bus = yield* makeRunBus()
          yield* bus.startRun({ runId: "r_aaaaaaaaaaaaa", directory: "/tmp/a", specPath: "a" })
          yield* bus.publishEvent("r_aaaaaaaaaaaaa", {
            schemaVersion: 1,
            seq: 1,
            runId: "r_aaaaaaaaaaaaa",
            ts: "2026-01-01T00:00:00.000Z",
            type: "runFinished",
            status: "passed",
            durationMs: 1
          })
          const first = bus.harnessJournal().length
          yield* bus.startRun({ runId: "r_bbbbbbbbbbbbb", directory: "/tmp/b", specPath: "b" })
          return { first, afterSecondStart: bus.harnessJournal().length, ui: bus.journal().length }
        })
      )
    )
    expect(journals.first).toBe(1)
    expect(journals.afterSecondStart).toBe(0)
    // The CLI's own stream keeps counting across scenarios, so its Last-Event-ID stays meaningful.
    expect(journals.ui).toBe(3)
  })
})
