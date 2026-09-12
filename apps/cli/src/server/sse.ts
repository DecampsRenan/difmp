import type { HarnessEvent } from "@difmp/core"
import { Sse } from "effect/unstable/encoding"
import type { UiMessage } from "./bus.js"

export const sseHeaders: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no"
}

export const renderMessage = (message: UiMessage): string =>
  Sse.encoder.write({
    _tag: "Event",
    event: message.type,
    id: String(message.seq),
    data: JSON.stringify(message)
  })

/** `apps/ui` names its listeners after the harness event type and reads `id:` as the event `seq`. */
export const renderHarnessEvent = (event: HarnessEvent): string =>
  Sse.encoder.write({
    _tag: "Event",
    event: event.type,
    id: String(event.seq),
    data: JSON.stringify(event)
  })

/**
 * Parse a resume cursor. `Last-Event-ID` is what the browser's `EventSource` replays automatically;
 * `?lastEventId=` is the explicit escape hatch `apps/ui` uses when it takes over the retrying.
 * `0`/absent means "from the beginning".
 */
export const parseCursor = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return 0
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * Render one value into SSE frames, closing any gap first.
 *
 * A client's queue is bounded and dropping, so a slow reader can lose live messages without ever
 * making the runner wait. The journal is the authority: before emitting sequence `n` we emit every
 * entry between the last one this connection actually received and `n`. Combined with the
 * `seq <= lastSent` guard — which absorbs the overlap between the replay snapshot and the live
 * queue — a reconnect neither loses nor duplicates an event.
 *
 * Both journals are contiguous from sequence 1, so a journal index is `seq - 1`.
 */
export const makeGapFillingEncoder = <A>(options: {
  readonly journal: () => ReadonlyArray<A>
  readonly seqOf: (value: A) => number
  readonly render: (value: A) => string
  readonly after: number
}): ((value: A) => string) => {
  let lastSent = options.after
  return (value) => {
    const seq = options.seqOf(value)
    if (seq <= lastSent) return ""
    const gap = options.journal().slice(lastSent, seq - 1)
    lastSent = seq
    return [...gap, value].map(options.render).join("")
  }
}

export const makeFrameEncoder = (
  journal: () => ReadonlyArray<UiMessage>,
  after: number
): ((message: UiMessage) => string) =>
  makeGapFillingEncoder({ journal, seqOf: (m) => m.seq, render: renderMessage, after })

export const makeHarnessFrameEncoder = (
  journal: () => ReadonlyArray<HarnessEvent>,
  after: number
): ((event: HarnessEvent) => string) =>
  makeGapFillingEncoder({ journal, seqOf: (e) => e.seq, render: renderHarnessEvent, after })
