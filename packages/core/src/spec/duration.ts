const ABBREVIATED = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i
const SPELLED = /^(\d+(?:\.\d+)?)\s*(millis?|milliseconds?|secs?|seconds?|mins?|minutes?|hours?|days?)$/i
const BARE_NUMBER = /^\d+(?:\.\d+)?$/

const MS_PER: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
}

const spelledUnit = (word: string): string => {
  const w = word.toLowerCase()
  if (w.startsWith("milli")) return "ms"
  if (w.startsWith("sec")) return "s"
  if (w.startsWith("min")) return "m"
  if (w.startsWith("hour")) return "h"
  return "d"
}

/**
 * `"90s"`, `"2m"`, `"1500ms"`, `"90 seconds"`, `"90000"` or `90000` -> milliseconds.
 * Returns `undefined` for anything unparseable or non-positive. Effect's own `Duration`
 * parser rejects the abbreviated form the spec uses, so this normalises first.
 */
export const parseDurationMs = (raw: string | number): number | undefined => {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : undefined
  }
  const text = raw.trim()
  if (text === "") return undefined
  if (BARE_NUMBER.test(text)) {
    const ms = Number(text)
    return ms > 0 ? ms : undefined
  }
  const abbreviated = ABBREVIATED.exec(text)
  if (abbreviated !== null) {
    const ms = Number(abbreviated[1]) * MS_PER[abbreviated[2]!.toLowerCase()]!
    return ms > 0 ? ms : undefined
  }
  const spelled = SPELLED.exec(text)
  if (spelled !== null) {
    const ms = Number(spelled[1]) * MS_PER[spelledUnit(spelled[2]!)]!
    return ms > 0 ? ms : undefined
  }
  return undefined
}
