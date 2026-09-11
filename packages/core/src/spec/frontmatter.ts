import { LineCounter, isMap, isScalar, parseDocument } from "yaml"
import type { DocumentOptions, ParseOptions, SchemaOptions, ToJSOptions } from "yaml"

/** Strict data mode: no executable tags, no merges, unique keys, bounded aliases. */
export const safeYamlOptions: ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions = {
  schema: "core",
  version: "1.2",
  customTags: [],
  // Without this, `!!binary` / `!!timestamp` silently become Buffers and Dates.
  resolveKnownTags: false,
  maxAliasCount: 20,
  strict: true,
  uniqueKeys: true,
  merge: false,
  prettyErrors: true
}

/** Neither the YAML library nor Effect caps input size — we do it ourselves. */
export const maxSpecBytes = 512 * 1024
export const maxFrontmatterBytes = 64 * 1024

export interface Position {
  readonly line: number
  readonly column: number
}

export interface SplitSpec {
  readonly frontmatterText: string
  /** 1-based line, in the whole file, of the first frontmatter line. */
  readonly frontmatterLine: number
  readonly body: string
  /** 1-based line, in the whole file, of the first body line. */
  readonly bodyLine: number
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export const splitFrontmatter = (content: string): SplitSpec | undefined => {
  const match = FRONTMATTER.exec(content)
  if (match === null) return undefined
  const frontmatterText = match[1]!
  const consumed = match[0].length
  const body = content.slice(consumed)
  const bodyLine = content.slice(0, consumed).split("\n").length
  return { frontmatterText, frontmatterLine: 2, body, bodyLine }
}

export interface YamlParsed {
  readonly data: unknown
  /** 1-based file position of each top-level key. */
  readonly keyPositions: ReadonlyMap<string, Position>
  /** 1-based file position of each top-level value node. */
  readonly valuePositions: ReadonlyMap<string, Position>
  /** Raw source slice of each top-level value, used to detect literal block scalars. */
  readonly valueSources: ReadonlyMap<string, string>
}

export class YamlRejected extends Error {}

/**
 * Parse frontmatter in strict data mode and record where every top-level key and value lives
 * in the ORIGINAL file (the offsets are re-based past the opening `---`).
 */
export const parseFrontmatterYaml = (frontmatterText: string, frontmatterLine: number): YamlParsed => {
  if (frontmatterText.length > maxFrontmatterBytes) {
    throw new YamlRejected(`frontmatter is larger than ${maxFrontmatterBytes} bytes`)
  }
  const lineCounter = new LineCounter()
  const doc = parseDocument(frontmatterText, { lineCounter, ...safeYamlOptions })
  if (doc.errors.length > 0) throw new YamlRejected(doc.errors[0]!.message)
  // Unresolved / disallowed tags land in `warnings`, not `errors`.
  if (doc.warnings.length > 0) throw new YamlRejected(doc.warnings[0]!.message)

  const keyPositions = new Map<string, Position>()
  const valuePositions = new Map<string, Position>()
  const valueSources = new Map<string, string>()
  const contents = doc.contents
  if (isMap(contents)) {
    for (const pair of contents.items) {
      const key = pair.key
      if (!isScalar(key) || typeof key.value !== "string") continue
      const name = key.value
      if (key.range !== undefined && key.range !== null) {
        const pos = lineCounter.linePos(key.range[0])
        keyPositions.set(name, { line: pos.line + frontmatterLine - 1, column: pos.col })
      }
      const value = pair.value as { range?: [number, number, number] | null } | null
      const range = value?.range
      if (range !== undefined && range !== null) {
        const pos = lineCounter.linePos(range[0])
        valuePositions.set(name, { line: pos.line + frontmatterLine - 1, column: pos.col })
        valueSources.set(name, frontmatterText.slice(range[0], range[1]))
      }
    }
  }
  return { data: doc.toJS({ maxAliasCount: 20 }), keyPositions, valuePositions, valueSources }
}
