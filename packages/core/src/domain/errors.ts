import { Schema } from "effect"

const at = (file: string, line?: number, column?: number): string =>
  line === undefined ? file : column === undefined ? `${file}:${line}` : `${file}:${line}:${column}`

/** A spec file could not be read, parsed or validated. Always names file, field and (when known) line. */
export class SpecError extends Schema.TaggedError<SpecError>()("SpecError", {
  specPath: Schema.String,
  reason: Schema.String,
  field: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Int),
  column: Schema.optionalKey(Schema.Int),
  details: Schema.optionalKey(Schema.Array(Schema.String))
}) {
  override get message(): string {
    const where = at(this.specPath, this.line, this.column)
    const field = this.field === undefined ? "" : ` (field \`${this.field}\`)`
    const details = this.details === undefined || this.details.length === 0
      ? ""
      : `\n${this.details.map((d) => `  - ${d}`).join("\n")}`
    return `${where}${field}: ${this.reason}${details}`
  }
}

/** A `{{ … }}` reference could not be resolved, or referenced something it is not allowed to. */
export class InterpolationError extends Schema.TaggedError<InterpolationError>()("InterpolationError", {
  source: Schema.String,
  field: Schema.String,
  variable: Schema.String,
  reason: Schema.String,
  line: Schema.Int,
  column: Schema.Int
}) {
  override get message(): string {
    return `${at(this.source, this.line, this.column)} (field \`${this.field}\`): {{ ${this.variable} }} — ${this.reason}`
  }
}

/** `harness.config.ts` (or a CLI override) is not a valid configuration. */
export class ConfigInvalidError extends Schema.TaggedError<ConfigInvalidError>()("ConfigInvalidError", {
  source: Schema.String,
  problems: Schema.Array(Schema.String)
}) {
  override get message(): string {
    return `${this.source}: invalid configuration\n${this.problems.map((p) => `  - ${p}`).join("\n")}`
  }
}

/** A fixture or check name does not resolve in the project registry, or is bound to the wrong criterion. */
export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  kind: Schema.Literals(["fixture", "check", "script"]),
  name: Schema.String,
  reason: Schema.String,
  registered: Schema.Array(Schema.String)
}) {
  override get message(): string {
    const known = this.registered.length === 0
      ? "no names are registered"
      : `registered names: ${this.registered.join(", ")}`
    return `${this.kind} "${this.name}": ${this.reason} (${known})`
  }
}

/** A tool call violated harness policy before execution (origin allow-list, stale reference). */
export class PolicyError extends Schema.TaggedError<PolicyError>()("PolicyError", {
  rule: Schema.Literals(["allowed-origins", "stale-observation", "unknown-reference", "run-finished"]),
  reason: Schema.String,
  detail: Schema.optionalKey(Schema.String)
}) {
  override get message(): string {
    return `policy/${this.rule}: ${this.reason}${this.detail === undefined ? "" : ` (${this.detail})`}`
  }
}

export const BudgetKind = Schema.Literals([
  "attemptTimeout",
  "operationTimeout",
  "fixtureSetupTimeout",
  "maxModelCalls",
  "maxTokens",
  "maxIdleTurns"
])
export type BudgetKind = typeof BudgetKind["Type"]

/**
 * A BLOCKING budget was exhausted. Never raised for `maxActions`, which is indicative only.
 * Maps to `inconclusive`, never to `failed`.
 */
export class BudgetExhaustedError extends Schema.TaggedError<BudgetExhaustedError>()("BudgetExhaustedError", {
  budget: BudgetKind,
  limit: Schema.Number,
  used: Schema.Number,
  detail: Schema.optionalKey(Schema.String)
}) {
  override get message(): string {
    return `blocking budget ${this.budget} exhausted (${this.used}/${this.limit})${
      this.detail === undefined ? "" : `: ${this.detail}`
    }`
  }
}

/** The run store could not read or write the run directory. */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  operation: Schema.String,
  path: Schema.String,
  reason: Schema.String
}) {
  override get message(): string {
    return `run store ${this.operation} failed for ${this.path}: ${this.reason}`
  }
}

/** A service the runner depends on failed. `stage` keeps the product/infrastructure distinction visible. */
export const RunStage = Schema.Literals([
  "validate",
  "manifest",
  "fixture-setup",
  "contract",
  "browser",
  "capture",
  "agent-loop",
  "verification",
  "evidence",
  "aggregate",
  "fixture-cleanup",
  "report"
])
export type RunStage = typeof RunStage["Type"]

export class RunFailure extends Schema.TaggedError<RunFailure>()("RunFailure", {
  stage: RunStage,
  reason: Schema.String,
  cause: Schema.optionalKey(Schema.String)
}) {
  override get message(): string {
    return `${this.stage}: ${this.reason}${this.cause === undefined ? "" : ` (${this.cause})`}`
  }
}

/** The run was explicitly cancelled. */
export class CancelledError extends Schema.TaggedError<CancelledError>()("CancelledError", {
  reason: Schema.String
}) {
  override get message(): string {
    return `run cancelled: ${this.reason}`
  }
}

export type HarnessError =
  | SpecError
  | InterpolationError
  | ConfigInvalidError
  | RegistryError
  | PolicyError
  | BudgetExhaustedError
  | StoreError
  | RunFailure
  | CancelledError
