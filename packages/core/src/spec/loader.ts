import { Context, Effect, FileSystem, Layer } from "effect"
import { decodeStrict, schemaProblems } from "../domain/decode.js"
import { SpecError } from "../domain/errors.js"
import { criterionId } from "../domain/ids.js"
import type { CriterionMethod, LoadedSpec, ParsedCriterion } from "../domain/spec.js"
import { Frontmatter, SupportedSpecVersion } from "../domain/spec.js"
import type { SourceLocator } from "./body.js"
import { findExpectationSection, splitCriteria } from "./body.js"
import type { Position } from "./frontmatter.js"
import { maxSpecBytes, parseFrontmatterYaml, splitFrontmatter, YamlRejected } from "./frontmatter.js"
import { parseDurationMs } from "./duration.js"

const decodeFrontmatter = decodeStrict(Frontmatter)

const fail = (specPath: string, reason: string, extra?: Partial<SpecError>) =>
  Effect.fail(
    new SpecError({
      specPath,
      reason,
      ...(extra?.field === undefined ? {} : { field: extra.field }),
      ...(extra?.line === undefined ? {} : { line: extra.line }),
      ...(extra?.column === undefined ? {} : { column: extra.column }),
      ...(extra?.details === undefined ? {} : { details: extra.details })
    })
  )

/** Locator for a literal (`|`) block scalar: content starts on the line after the indicator. */
const blockScalarLocator = (valuePos: Position, rawValue: string): SourceLocator => {
  const rawLines = rawValue.split("\n")
  const firstContent = rawLines.find((line, index) => index > 0 && line.trim() !== "")
  const indent = firstContent === undefined ? 0 : firstContent.length - firstContent.trimStart().length
  return (relLine, relColumn) => ({ line: valuePos.line + relLine, column: indent + relColumn })
}

const inlineScalarLocator = (valuePos: Position): SourceLocator => (relLine, relColumn) =>
  relLine === 1
    ? { line: valuePos.line, column: valuePos.column + relColumn - 1 }
    : { line: valuePos.line + relLine - 1, column: relColumn }

export const parseSpec = (input: {
  readonly specPath: string
  readonly content: string
}): Effect.Effect<LoadedSpec, SpecError> =>
  Effect.gen(function*() {
    const { content, specPath } = input
    if (content.length > maxSpecBytes) {
      return yield* fail(specPath, `spec file is larger than ${maxSpecBytes} bytes`)
    }
    const split = splitFrontmatter(content)
    if (split === undefined) {
      return yield* fail(specPath, "missing YAML frontmatter — the file must start with a `---` line", {
        line: 1,
        column: 1
      })
    }

    const parsed = yield* Effect.try({
      try: () => parseFrontmatterYaml(split.frontmatterText, split.frontmatterLine),
      catch: (cause) =>
        new SpecError({
          specPath,
          field: "frontmatter",
          reason: cause instanceof YamlRejected ? cause.message : `invalid YAML: ${String(cause)}`,
          line: split.frontmatterLine
        })
    })

    const positionOf = (field: string): Position | undefined =>
      parsed.keyPositions.get(field) ?? { line: split.frontmatterLine, column: 1 }

    // Report an unsupported version before the schema does, so the message names the value.
    const raw = parsed.data
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return yield* fail(specPath, "frontmatter must be a YAML mapping", {
        field: "frontmatter",
        line: split.frontmatterLine
      })
    }
    const rawVersion = (raw as Record<string, unknown>)["version"]
    if (rawVersion !== undefined && rawVersion !== SupportedSpecVersion) {
      const pos = positionOf("version")
      return yield* fail(specPath, `unsupported spec version ${JSON.stringify(rawVersion)} (supported: ${SupportedSpecVersion})`, {
        field: "version",
        ...(pos === undefined ? {} : { line: pos.line, column: pos.column })
      })
    }

    const frontmatter = yield* decodeFrontmatter(raw).pipe(
      Effect.catchTag("SchemaError", (error) => {
        const problems = schemaProblems(error)
        const firstField = problems[0]?.path.split(".")[0]
        const pos = firstField === undefined || firstField === "" ? undefined : positionOf(firstField)
        return fail(specPath, "invalid frontmatter", {
          ...(firstField === undefined || firstField === "" ? {} : { field: firstField }),
          ...(pos === undefined ? {} : { line: pos.line, column: pos.column }),
          details: problems.map((p) => (p.path === "" ? p.message : `${p.path}: ${p.message}`))
        })
      })
    )

    if (split.body.trim() === "") {
      return yield* fail(specPath, "the Markdown body must not be empty", { line: split.bodyLine })
    }

    let timeoutMs: number | undefined
    if (frontmatter.timeout !== undefined) {
      const ms = parseDurationMs(frontmatter.timeout)
      if (ms === undefined) {
        const pos = parsed.valuePositions.get("timeout") ?? positionOf("timeout")
        return yield* fail(
          specPath,
          `unparseable timeout ${JSON.stringify(frontmatter.timeout)} — use "90s", "2m", "90 seconds" or a positive number of milliseconds`,
          { field: "timeout", ...(pos === undefined ? {} : { line: pos.line, column: pos.column }) }
        )
      }
      timeoutMs = ms
    }

    const section = findExpectationSection(split.body)
    const hasVerification = frontmatter.verification !== undefined && frontmatter.verification.trim() !== ""
    if (hasVerification && section !== undefined) {
      const pos = positionOf("verification")
      return yield* fail(
        specPath,
        "expectations are declared twice: in the `verification` field AND in a Markdown results section — keep exactly one",
        {
          field: "verification",
          ...(pos === undefined ? {} : { line: pos.line, column: pos.column }),
          details: [`Markdown section at line ${split.bodyLine + section.headingRelLine - 1}`]
        }
      )
    }
    if (!hasVerification && section === undefined) {
      return yield* fail(
        specPath,
        "no expectations found — provide a `verification` string or an `## Expected results` section",
        { field: "verification", line: split.frontmatterLine }
      )
    }

    const expectationSource = hasVerification ? "verification" : "section"
    let text: string
    let locate: SourceLocator
    if (hasVerification) {
      text = frontmatter.verification!
      const valuePos = parsed.valuePositions.get("verification")
      const rawValue = parsed.valueSources.get("verification") ?? ""
      const anchor = valuePos ?? { line: split.frontmatterLine, column: 1 }
      locate = rawValue.startsWith("|") ? blockScalarLocator(anchor, rawValue) : inlineScalarLocator(anchor)
    } else {
      text = section!.text
      const base = split.bodyLine + section!.relLine - 1
      locate = (relLine, relColumn) => ({ line: base + relLine - 1, column: relColumn })
    }

    const rawCriteria = splitCriteria(text, locate)
    if (rawCriteria.length === 0) {
      return yield* fail(specPath, "the expectations block is empty", { field: expectationSource })
    }

    const checks = frontmatter.checks ?? {}
    const criteria: Array<ParsedCriterion> = rawCriteria.map((criterion, index) => {
      const id = criterionId(index + 1)
      const checkName = checks[id]
      const method: CriterionMethod = checkName === undefined ? "model" : "code"
      return {
        id,
        sourceText: criterion.sourceText,
        line: criterion.line,
        column: criterion.column,
        method,
        ...(checkName === undefined ? {} : { checkName })
      }
    })

    const knownIds = new Set(criteria.map((c) => c.id))
    for (const boundId of Object.keys(checks)) {
      if (!knownIds.has(boundId)) {
        const pos = positionOf("checks")
        return yield* fail(
          specPath,
          `checks references criterion ${boundId}, but this spec only has ${criteria.length} criteria (${
            criteria.map((c) => c.id).join(", ")
          })`,
          { field: "checks", ...(pos === undefined ? {} : { line: pos.line, column: pos.column }) }
        )
      }
    }

    const fieldLines: Record<string, Position> = {}
    for (const [key, value] of parsed.keyPositions) fieldLines[key] = value

    return {
      specPath,
      source: content,
      frontmatter,
      body: split.body,
      bodyLine: split.bodyLine,
      expectationSource,
      criteria,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      fieldLines
    } satisfies LoadedSpec
  })

/** Reject the same scenario id appearing in more than one spec of a selected set. */
export const assertUniqueScenarioIds = (
  specs: ReadonlyArray<LoadedSpec>
): Effect.Effect<ReadonlyArray<LoadedSpec>, SpecError> => {
  const seen = new Map<string, string>()
  for (const spec of specs) {
    const id = spec.frontmatter.id
    const previous = seen.get(id)
    if (previous !== undefined) {
      const pos = spec.fieldLines["id"]
      return Effect.fail(
        new SpecError({
          specPath: spec.specPath,
          field: "id",
          reason: `duplicate scenario id "${id}" — already declared in ${previous}`,
          ...(pos === undefined ? {} : { line: pos.line, column: pos.column })
        })
      )
    }
    seen.set(id, spec.specPath)
  }
  return Effect.succeed(specs)
}

export class SpecLoader extends Context.Service<SpecLoader, {
  /** Parse an in-memory spec. No file access — used by `validate` and by tests. */
  readonly parse: (input: {
    readonly specPath: string
    readonly content: string
  }) => Effect.Effect<LoadedSpec, SpecError>
  readonly load: (specPath: string) => Effect.Effect<LoadedSpec, SpecError>
  /** Loads a whole selection and rejects duplicate scenario ids across it. */
  readonly loadAll: (specPaths: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<LoadedSpec>, SpecError>
}>()("@difmp/core/spec/SpecLoader") {
  static readonly layer: Layer.Layer<SpecLoader, never, FileSystem.FileSystem> = Layer.effect(
    SpecLoader,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem

      const load = Effect.fn("SpecLoader.load")(function*(specPath: string) {
        const content = yield* fs.readFileString(specPath).pipe(
          Effect.mapError((cause) => new SpecError({ specPath, reason: `cannot read spec file: ${cause.message}` }))
        )
        return yield* parseSpec({ specPath, content })
      })

      const loadAll = Effect.fn("SpecLoader.loadAll")(function*(specPaths: ReadonlyArray<string>) {
        const specs = yield* Effect.forEach(specPaths, load, { concurrency: 8 })
        return yield* assertUniqueScenarioIds(specs)
      })

      return SpecLoader.of({ parse: parseSpec, load, loadAll })
    })
  )
}

