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

/**
 * Parse a resume cursor. `Last-Event-ID` is what the browser's `EventSource` replays automatically;
 * `?lastEventId=` is the explicit escape hatch. `-1`/absent means "from the beginning".
 */
export const parseCursor = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return 0
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * Render one message into SSE frames, closing any gap first.
 *
 * A client's queue is bounded and dropping, so a slow reader can lose live messages without ever
 * making the runner wait. The journal is the authority: before emitting message `n` we emit every
 * message between the last one this connection actually received and `n`. Combined with the
 * `seq <= lastSent` guard — which absorbs the overlap between the replay snapshot and the live
 * queue — a reconnect neither loses nor duplicates an event.
 */
export const makeFrameEncoder = (
  journal: () => ReadonlyArray<UiMessage>,
  after: number
): ((message: UiMessage) => string) => {
  let lastSent = after
  return (message) => {
    if (message.seq <= lastSent) return ""
    // The journal is contiguous from seq 1, so index === seq - 1.
    const gap = journal().slice(lastSent, message.seq - 1)
    lastSent = message.seq
    return [...gap, message].map(renderMessage).join("")
  }
}
