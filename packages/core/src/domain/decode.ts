import { Schema, SchemaIssue } from "effect"
import type { SchemaAST } from "effect"

/**
 * The one shared decode configuration. Unknown keys are an error everywhere the
 * spec asks for it (frontmatter, config, tool params, persisted documents), and
 * every issue is reported rather than just the first one.
 */
export const strictParseOptions: SchemaAST.ParseOptions = {
  errors: "all",
  onExcessProperty: "error",
  reportInput: true
}

/** Same, minus `reportInput` — for inputs that may carry user data we do not want echoed. */
export const strictQuietParseOptions: SchemaAST.ParseOptions = {
  errors: "all",
  onExcessProperty: "error"
}

export const decodeStrict = <S extends Schema.Constraint>(schema: S) =>
  Schema.decodeUnknownEffect(schema, strictParseOptions)

export const decodeStrictSync = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema, strictParseOptions)

export const decodeStrictResult = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownResult(schema, strictParseOptions)

export const encodeStrict = <S extends Schema.Constraint>(schema: S) => Schema.encodeUnknownEffect(schema)

export interface SchemaProblem {
  /** Dotted field path, e.g. `budgets.maxTokens` or `steps.0.url`. Empty for a root issue. */
  readonly path: string
  readonly message: string
}

const standardFormatter = SchemaIssue.makeFormatterStandardSchemaV1()

/** Flatten a `SchemaError` into one entry per offending field. */
export const schemaProblems = (error: Schema.SchemaError): ReadonlyArray<SchemaProblem> =>
  standardFormatter(error.issue).issues.map((issue) => {
    const path = (issue.path ?? [])
      .map((segment) => String(typeof segment === "object" && segment !== null ? segment.key : segment))
      .join(".")
    return { path, message: issue.message }
  })

/**
 * Human message naming the field and its path, e.g.
 * `difmp.config.ts: invalid value\n  - budgets.maxTokens: Expected a value greater than 0, got -1`
 */
export const formatSchemaError = (
  error: Schema.SchemaError,
  options?: { readonly source?: string; readonly summary?: string }
): string => {
  const problems = schemaProblems(error)
  const head = [options?.source, options?.summary ?? "invalid value"].filter((s) => s !== undefined).join(": ")
  const body = problems.map((p) => (p.path === "" ? `  - ${p.message}` : `  - ${p.path}: ${p.message}`)).join("\n")
  return problems.length === 0 ? `${head}\n  - ${error.message}` : `${head}\n${body}`
}
