import { Effect } from "effect"
import { InterpolationError } from "../domain/errors.js"
import type { InputsRecord, InputValue } from "../domain/spec.js"
import type { Position } from "../spec/frontmatter.js"

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/

export interface TemplateRef {
  readonly raw: string
  readonly expression: string
  readonly offset: number
  readonly relLine: number
  readonly relColumn: number
}

/** Find every `{{ … }}` with its 1-based position relative to the start of `text`. */
export const scanTemplate = (text: string): ReadonlyArray<TemplateRef> => {
  const refs: Array<TemplateRef> = []
  PLACEHOLDER.lastIndex = 0
  let match = PLACEHOLDER.exec(text)
  while (match !== null) {
    const offset = match.index
    const before = text.slice(0, offset)
    const relLine = before.split("\n").length
    const lastNewline = before.lastIndexOf("\n")
    refs.push({
      raw: match[0],
      expression: match[1]!.trim(),
      offset,
      relLine,
      relColumn: offset - lastNewline
    })
    match = PLACEHOLDER.exec(text)
  }
  return refs
}

/** Deterministic scalar serialisation — the same input always renders the same text. */
export const serializeScalar = (value: InputValue): string => {
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "true" : "false"
  return Object.is(value, -0) ? "0" : String(value)
}

export interface InterpolationScope {
  readonly run: { readonly id: string }
  readonly attempt: { readonly id: string }
  readonly inputs: InputsRecord
  /** Public fixture values. Absent when no fixture ran. */
  readonly fixture?: InputsRecord
}

/** `strict` is what `run` uses; `validate` tolerates unresolved `fixture.*` (no setup yet). */
export type ReferenceMode = "strict" | "validate"

export interface InterpolateOptions {
  readonly text: string
  readonly source: string
  readonly field: string
  /** Position, in the source file, of the first character of `text`. */
  readonly anchor: Position
  readonly scope: InterpolationScope
  readonly mode?: ReferenceMode
}

const absolute = (anchor: Position, ref: TemplateRef): Position =>
  ref.relLine === 1
    ? { line: anchor.line, column: anchor.column + ref.relColumn - 1 }
    : { line: anchor.line + ref.relLine - 1, column: ref.relColumn }

const known = (scope: InterpolationScope): string => {
  const inputKeys = Object.keys(scope.inputs).sort()
  const declared = inputKeys.length === 0 ? "none declared" : inputKeys.join(", ")
  return `available: run.id, attempt.id, fixture.<key>; declared inputs: ${declared}`
}

/**
 * Data substitution only — `{{ run.id }}`, `{{ attempt.id }}`, declared input keys and
 * `{{ fixture.<key> }}`. There is no expression engine and values are never re-interpolated.
 */
export const interpolate = (options: InterpolateOptions): Effect.Effect<string, InterpolationError> =>
  Effect.suspend(() => {
    const mode = options.mode ?? "strict"
    const refs = scanTemplate(options.text)
    if (refs.length === 0) return Effect.succeed(options.text)

    let out = ""
    let cursor = 0
    for (const ref of refs) {
      const pos = absolute(options.anchor, ref)
      const raise = (reason: string) =>
        Effect.fail(
          new InterpolationError({
            source: options.source,
            field: options.field,
            variable: ref.expression,
            reason,
            line: pos.line,
            column: pos.column
          })
        )

      if (!IDENTIFIER.test(ref.expression)) {
        return raise(
          "expressions are not supported — only {{ run.id }}, {{ attempt.id }}, declared input keys and {{ fixture.<key> }} are allowed"
        )
      }

      let replacement: string | undefined
      if (ref.expression === "run.id") {
        replacement = options.scope.run.id
      } else if (ref.expression === "attempt.id") {
        replacement = options.scope.attempt.id
      } else if (ref.expression.startsWith("fixture.")) {
        const key = ref.expression.slice("fixture.".length)
        const value = options.scope.fixture?.[key]
        if (value === undefined) {
          if (mode === "validate") {
            // `difmp validate` runs before any fixture setup: keep the placeholder as written.
            replacement = ref.raw
          } else if (options.scope.fixture === undefined) {
            return raise("no fixture ran for this scenario, so fixture values cannot be resolved")
          } else {
            return raise(
              `the fixture does not expose a public value named "${key}" (exposed: ${
                Object.keys(options.scope.fixture).sort().join(", ") || "none"
              })`
            )
          }
        } else {
          replacement = serializeScalar(value)
        }
      } else if (ref.expression.includes(".")) {
        return raise(`unknown variable — ${known(options.scope)}`)
      } else {
        const value = options.scope.inputs[ref.expression]
        if (value === undefined) return raise(`unknown variable — ${known(options.scope)}`)
        replacement = serializeScalar(value)
      }

      out += options.text.slice(cursor, ref.offset) + replacement
      cursor = ref.offset + ref.raw.length
    }
    return Effect.succeed(out + options.text.slice(cursor))
  })

export interface ResolveInputsOptions {
  /** Merged declaration: config < spec (see config/inputs.ts for the full precedence). */
  readonly declared: InputsRecord
  readonly source: string
  readonly run: { readonly id: string }
  readonly attempt: { readonly id: string }
  /** Positions of the declaring frontmatter keys, when known. */
  readonly anchors?: Readonly<Record<string, Position>>
}

/**
 * Phase 1: resolve input values using RESERVED variables only. Inputs may not reference fixture
 * values (they do not exist yet) nor each other (no dependency graph, no cycles).
 */
export const resolveInputs = (
  options: ResolveInputsOptions
): Effect.Effect<InputsRecord, InterpolationError> =>
  Effect.gen(function*() {
    const declaredKeys = new Set(Object.keys(options.declared))
    const resolved: Record<string, InputValue> = {}
    for (const [key, value] of Object.entries(options.declared)) {
      if (typeof value !== "string") {
        resolved[key] = value
        continue
      }
      const anchor = options.anchors?.[key] ?? { line: 1, column: 1 }
      const refs = scanTemplate(value)
      for (const ref of refs) {
        const pos = absolute(anchor, ref)
        const raise = (reason: string) =>
          Effect.fail(
            new InterpolationError({
              source: options.source,
              field: `inputs.${key}`,
              variable: ref.expression,
              reason,
              line: pos.line,
              column: pos.column
            })
          )
        if (ref.expression.startsWith("fixture.")) {
          return yield* raise("inputs are resolved before the fixture runs and may not reference fixture values")
        }
        if (declaredKeys.has(ref.expression)) {
          return yield* raise("inputs may not reference other inputs")
        }
      }
      resolved[key] = yield* interpolate({
        text: value,
        source: options.source,
        field: `inputs.${key}`,
        anchor,
        scope: { run: options.run, attempt: options.attempt, inputs: {} }
      })
    }
    return resolved
  })

/** Convenience for `difmp validate`: check every reference without requiring fixture values. */
export const validateReferences = (options: Omit<InterpolateOptions, "mode">) =>
  interpolate({ ...options, mode: "validate" }).pipe(Effect.asVoid)
