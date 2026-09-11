import type { ObservedElement } from "@harness/core"

/**
 * Refs carry a frame-instance prefix (`e1` on the first document, `f1e1` afterwards), so the
 * character class must be `[a-z0-9]+`. `/\[ref=(e\d+)\]/` matches nothing after one navigation.
 */
export const REF_RE = /\[ref=([a-z0-9]+)\]/g

interface RawNode {
  readonly indent: number
  ref?: string
  role: string
  name?: string
  text?: string
  placeholder?: string
  url?: string
  level?: number
  checked?: boolean
  selected?: boolean
  disabled?: boolean
}

const ROLE_RE = /^([A-Za-z][\w-]*)/
const QUOTED_NAME_RE = /^\s+"((?:[^"\\]|\\.)*)"/
const ATTR_RE = /^\s*\[([^\]]*)\]/

const unescape = (value: string): string => value.replace(/\\(.)/g, "$1")

const applyAttribute = (node: RawNode, raw: string): void => {
  const eq = raw.indexOf("=")
  const key = eq === -1 ? raw : raw.slice(0, eq)
  const value = eq === -1 ? undefined : raw.slice(eq + 1)
  switch (key) {
    case "ref":
      if (value !== undefined) node.ref = value
      return
    case "level": {
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10)
      if (Number.isInteger(parsed)) node.level = parsed
      return
    }
    // `[checked]` is a bare flag; `[checked=mixed]` is a tri-state we surface as checked.
    case "checked":
      node.checked = value !== "false"
      return
    case "selected":
      node.selected = value !== "false"
      return
    case "disabled":
      node.disabled = value !== "false"
      return
    default:
      return
  }
}

const parseLine = (line: string): RawNode | { readonly property: string; readonly value: string } | undefined => {
  const trimmedStart = line.replace(/^\s*/, "")
  if (!trimmedStart.startsWith("- ")) return undefined
  const indent = line.length - trimmedStart.length
  let rest = trimmedStart.slice(2)

  if (rest.startsWith("/")) {
    const colon = rest.indexOf(":")
    if (colon === -1) return undefined
    return { property: rest.slice(1, colon), value: rest.slice(colon + 1).trim() }
  }

  const roleMatch = ROLE_RE.exec(rest)
  if (roleMatch === null || roleMatch[1] === undefined) return undefined
  const node: RawNode = { indent, role: roleMatch[1] }
  rest = rest.slice(roleMatch[1].length)

  const nameMatch = QUOTED_NAME_RE.exec(rest)
  if (nameMatch !== null && nameMatch[1] !== undefined) {
    node.name = unescape(nameMatch[1])
    rest = rest.slice(nameMatch[0].length)
  }

  for (;;) {
    const attrMatch = ATTR_RE.exec(rest)
    if (attrMatch === null || attrMatch[1] === undefined) break
    applyAttribute(node, attrMatch[1])
    rest = rest.slice(attrMatch[0].length)
  }

  const tail = rest.trimStart()
  if (tail.startsWith(":")) {
    const inline = tail.slice(1).trim()
    if (inline.length > 0) node.text = inline
  }
  return node
}

const toObserved = (node: RawNode): ObservedElement | undefined => {
  if (node.ref === undefined) return undefined
  return {
    ref: node.ref,
    role: node.role,
    ...(node.name === undefined ? {} : { name: node.name }),
    ...(node.text === undefined ? {} : { text: node.text }),
    ...(node.placeholder === undefined ? {} : { placeholder: node.placeholder }),
    ...(node.url === undefined ? {} : { url: node.url }),
    ...(node.level === undefined ? {} : { level: node.level }),
    ...(node.checked === undefined ? {} : { checked: node.checked }),
    ...(node.selected === undefined ? {} : { selected: node.selected }),
    ...(node.disabled === undefined ? {} : { disabled: node.disabled })
  }
}

/**
 * Parses an `ariaSnapshot({ mode: "ai" })` tree into the flat element list the model sees. Parsing
 * the very snapshot string we hand the model guarantees the refs it can quote are exactly the refs
 * we accept — a second snapshot call could disagree after a mutation.
 */
export const parseAiSnapshot = (yaml: string): ReadonlyArray<ObservedElement> => {
  const stack: Array<RawNode> = []
  const nodes: Array<RawNode> = []
  for (const line of yaml.split("\n")) {
    if (line.trim().length === 0) continue
    const parsed = parseLine(line)
    if (parsed === undefined) continue
    if ("property" in parsed) {
      const parent = stack[stack.length - 1]
      if (parent === undefined) continue
      if (parsed.property === "url") parent.url = parsed.value
      else if (parsed.property === "placeholder") parent.placeholder = parsed.value
      continue
    }
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? -1) >= parsed.indent) stack.pop()
    stack.push(parsed)
    nodes.push(parsed)
  }
  const elements: Array<ObservedElement> = []
  for (const node of nodes) {
    const observed = toObserved(node)
    if (observed !== undefined) elements.push(observed)
  }
  return elements
}

export const refsOf = (yaml: string): ReadonlyArray<string> => {
  REF_RE.lastIndex = 0
  return [...yaml.matchAll(REF_RE)].map((match) => match[1] as string)
}
