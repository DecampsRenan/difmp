import { Schema } from "effect"
import { Budgets } from "./budgets.js"
import { CriterionId } from "./ids.js"

/** MVP inputs are scalars only, serialised deterministically into the scenario text. */
export const InputValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]).annotate({
  identifier: "InputValue"
})
export type InputValue = typeof InputValue["Type"]

export const InputsRecord = Schema.Record(Schema.String, InputValue)
export type InputsRecord = typeof InputsRecord["Type"]

export const SupportedSpecVersion = 1

/** Frontmatter as written by the author. Unknown keys are rejected by the strict decode options. */
export const Frontmatter = Schema.Struct({
  version: Schema.Literal(SupportedSpecVersion),
  id: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
      message: "must start with a letter or digit and contain only letters, digits, '.', '_' or '-'"
    })
  ),
  tags: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  fixture: Schema.optionalKey(Schema.NonEmptyString),
  /** `90s`, `2m`, `90 seconds` or a positive number of milliseconds — normalised by spec/duration.ts. */
  timeout: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  maxActions: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0, { message: "must be a strictly positive integer" }))
  ),
  inputs: Schema.optionalKey(InputsRecord),
  verification: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(Schema.Record(CriterionId, Schema.NonEmptyString))
}).annotate({ identifier: "Frontmatter" })

export type Frontmatter = typeof Frontmatter["Type"]

export const CriterionMethod = Schema.Literals(["model", "code"])
export type CriterionMethod = typeof CriterionMethod["Type"]

export const Criterion = Schema.Struct({
  id: CriterionId,
  /** Interpolated, verbatim contract text. The browser agent can never change it. */
  text: Schema.String,
  /** Pre-interpolation source text, kept for the artifacts. */
  sourceText: Schema.String,
  line: Schema.Int,
  column: Schema.Int,
  method: CriterionMethod,
  checkName: Schema.optionalKey(Schema.NonEmptyString)
}).annotate({ identifier: "Criterion" })

export type Criterion = typeof Criterion["Type"]

export const ContractHashes = Schema.Struct({
  spec: Schema.String,
  contract: Schema.String,
  criteria: Schema.Record(Schema.String, Schema.String),
  prompts: Schema.Record(Schema.String, Schema.String)
})
export type ContractHashes = typeof ContractHashes["Type"]

/** The frozen scenario. Written to `contract.json` before any navigation happens. */
export const ScenarioContract = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  specPath: Schema.String,
  id: Schema.String,
  tags: Schema.Array(Schema.String),
  fixtureName: Schema.optionalKey(Schema.NonEmptyString),
  body: Schema.String,
  criteria: Schema.Array(Criterion).check(Schema.isMinLength(1, { expected: "at least one criterion" })),
  inputs: InputsRecord,
  maxActions: Schema.Int.check(Schema.isGreaterThan(0)),
  budgets: Budgets,
  hashes: ContractHashes
}).annotate({ identifier: "ScenarioContract" })

export type ScenarioContract = typeof ScenarioContract["Type"]

export const ExpectationSource = Schema.Literals(["verification", "section"])
export type ExpectationSource = typeof ExpectationSource["Type"]

/** What `SpecLoader` returns: everything parsed, nothing interpolated yet. */
export interface LoadedSpec {
  readonly specPath: string
  /** Verbatim file content, copied into the run directory as `spec.e2e.md`. */
  readonly source: string
  readonly frontmatter: Frontmatter
  /** Raw Markdown body, frontmatter removed, not yet interpolated. */
  readonly body: string
  readonly bodyLine: number
  readonly expectationSource: ExpectationSource
  readonly criteria: ReadonlyArray<ParsedCriterion>
  readonly timeoutMs?: number
  /** 1-based line of each frontmatter key, for error messages. */
  readonly fieldLines: Readonly<Record<string, { readonly line: number; readonly column: number }>>
}

/** A criterion before interpolation: `text` is still the source text. */
export interface ParsedCriterion {
  readonly id: string
  readonly sourceText: string
  readonly line: number
  readonly column: number
  readonly method: CriterionMethod
  readonly checkName?: string
}
