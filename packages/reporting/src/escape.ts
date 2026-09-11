/**
 * Every string that reaches a report comes from the scenario, the model, the page or the logs.
 * None of it is trusted, so this module is the ONLY place a reporter turns text into markup.
 */

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
}

/** Safe in both text and attribute position — quotes are escaped too. */
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]!)

export const escapeHtmlUnknown = (value: unknown): string => escapeHtml(stringify(value))

/**
 * XML 1.0 forbids most control characters outright: no entity can smuggle them back in, so an
 * offending code point is replaced rather than encoded. Lone surrogates are replaced too.
 */
const isValidXmlCodePoint = (cp: number): boolean =>
  cp === 0x9 || cp === 0xa || cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff)

export const stripInvalidXmlChars = (value: string): string => {
  let out = ""
  for (const ch of value) {
    const cp = ch.codePointAt(0)!
    out += isValidXmlCodePoint(cp) ? ch : "\uFFFD"
  }
  return out
}

/** Text or attribute content for XML. `'` and `"` are escaped so one helper covers both. */
export const escapeXml = (value: string): string =>
  stripInvalidXmlChars(value).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]!)

export const escapeXmlUnknown = (value: unknown): string => escapeXml(stringify(value))

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  if (value === null) return "null"
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return "[unserialisable]"
  }
}

/**
 * JSON embedded in a `<script>` block. `<` and friends are turned into `\uXXXX` escapes, which
 * JSON.parse restores verbatim, so no payload can close the element or open a comment.
 */
export const embedJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")

const ABSOLUTE_OR_SCHEME = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|\/)/

/**
 * Artifact paths are ours, but they are still data. Only a relative path that stays inside the
 * run directory becomes a link; anything else is rendered as inert text by the caller.
 */
export const artifactHref = (relativePath: string): string | undefined => {
  const trimmed = relativePath.trim()
  if (trimmed === "" || ABSOLUTE_OR_SCHEME.test(trimmed)) return undefined
  const segments = trimmed.split(/[\\/]+/)
  if (segments.some((s) => s === ".." || s === "")) return undefined
  return segments.map((s) => encodeURIComponent(s)).join("/")
}
