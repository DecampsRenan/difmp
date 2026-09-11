import type { ReportInput, RunResult } from "@harness/core"

/** Recursively sort object keys so two identical results always serialise byte-for-byte alike. */
const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value === null || typeof value !== "object") return value
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const out: Record<string, unknown> = {}
  for (const [key, nested] of entries) out[key] = sortKeysDeep(nested)
  return out
}

/**
 * `result.json` exactly as core's `RunResult` schema defines it, with stable key order.
 * Nothing is derived or summarised here: the file must decode straight back into `RunResult`.
 */
export const renderJsonReport = (input: ReportInput): string => renderRunResultJson(input.result)

export const renderRunResultJson = (result: RunResult): string => `${JSON.stringify(sortKeysDeep(result), null, 2)}\n`
