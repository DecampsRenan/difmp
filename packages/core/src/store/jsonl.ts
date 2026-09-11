export interface JsonlScan {
  readonly records: ReadonlyArray<unknown>
  /**
   * True when the file's last line could not be parsed — the process was interrupted
   * mid-write. The run must then be reported as NOT finalised.
   */
  readonly truncatedTail: boolean
  readonly invalid: ReadonlyArray<{ readonly line: number; readonly reason: string }>
}

/**
 * Read append-only JSONL tolerantly: a truncated final line is dropped and flagged, while a
 * malformed line in the middle is reported without discarding the rest of the journal.
 */
export const scanJsonl = (content: string): JsonlScan => {
  if (content === "") return { records: [], truncatedTail: false, invalid: [] }
  const lines = content.split("\n")
  const lastIndex = lines.length - 1
  const records: Array<unknown> = []
  const invalid: Array<{ line: number; reason: string }> = []
  let truncatedTail = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "") continue
    try {
      records.push(JSON.parse(line))
    } catch (cause) {
      if (i === lastIndex) {
        // No trailing newline and unparseable: the writer was interrupted.
        truncatedTail = true
      } else {
        invalid.push({ line: i + 1, reason: cause instanceof Error ? cause.message : String(cause) })
      }
    }
  }
  return { records, truncatedTail, invalid }
}

export const toJsonlLine = (value: unknown): string => `${JSON.stringify(value)}\n`
