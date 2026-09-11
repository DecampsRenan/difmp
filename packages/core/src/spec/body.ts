import type { Position } from "./frontmatter.js"

/** Maps a 1-based position inside an extracted text block back to the original file. */
export type SourceLocator = (relLine: number, relColumn: number) => Position

export interface RawCriterion {
  readonly sourceText: string
  readonly line: number
  readonly column: number
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/
const LIST_ITEM = /^([ \t]{0,3})([-*+]|\d{1,9}[.)])[ \t]+(\S.*)$/

const normalizeHeading = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[:.\s]+$/u, "")
    .trim()
    .toLowerCase()

const expectationHeadings = new Set(["resultats attendus", "expected results"])

export interface BodySection {
  readonly text: string
  /** 1-based line, within the body, of the first line of `text`. */
  readonly relLine: number
  /** 1-based line, within the body, of the heading itself. */
  readonly headingRelLine: number
}

/** Locate a `## Résultats attendus` / `## Expected results` section, accent- and case-insensitively. */
export const findExpectationSection = (body: string): BodySection | undefined => {
  const lines = body.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING.exec(lines[i]!)
    if (heading === null) continue
    if (!expectationHeadings.has(normalizeHeading(heading[2]!))) continue
    const level = heading[1]!.length
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const next = HEADING.exec(lines[j]!)
      if (next !== null && next[1]!.length <= level) {
        end = j
        break
      }
    }
    return {
      text: lines.slice(i + 1, end).join("\n"),
      relLine: i + 2,
      headingRelLine: i + 1
    }
  }
  return undefined
}

const isBlank = (line: string): boolean => line.trim() === ""

/**
 * Splitting rule: a top-level Markdown list yields one criterion per item; no list yields one
 * global criterion for the whole block. Positions are preserved through `locate`.
 */
export const splitCriteria = (text: string, locate: SourceLocator): ReadonlyArray<RawCriterion> => {
  const lines = text.split("\n")
  let first = 0
  while (first < lines.length && isBlank(lines[first]!)) first++
  let last = lines.length - 1
  while (last >= first && isBlank(lines[last]!)) last--
  if (first > last) return []

  const firstItem = LIST_ITEM.exec(lines[first]!)
  if (firstItem === null) {
    const content = lines.slice(first, last + 1).join("\n").trim()
    const column = lines[first]!.length - lines[first]!.trimStart().length + 1
    const at = locate(first + 1, column)
    return content === "" ? [] : [{ sourceText: content, line: at.line, column: at.column }]
  }

  const items: Array<RawCriterion> = []
  let current: { lines: Array<string>; line: number; column: number; contentIndent: number } | undefined
  const flush = () => {
    if (current === undefined) return
    const text = current.lines.join("\n").trimEnd()
    if (text !== "") items.push({ sourceText: text, line: current.line, column: current.column })
    current = undefined
  }

  for (let i = first; i <= last; i++) {
    const line = lines[i]!
    const item = LIST_ITEM.exec(line)
    if (item !== null) {
      flush()
      const column = line.indexOf(item[3]!, item[1]!.length + item[2]!.length) + 1
      const at = locate(i + 1, column)
      current = { lines: [item[3]!], line: at.line, column: at.column, contentIndent: column - 1 }
      continue
    }
    if (current === undefined) continue
    // Continuation of the current item: dedent by the item's content indent when possible.
    const dedented = line.startsWith(" ".repeat(current.contentIndent))
      ? line.slice(current.contentIndent)
      : line.trimStart()
    current.lines.push(dedented)
  }
  flush()
  return items
}
