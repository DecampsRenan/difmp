import { Schema } from "effect"
import { ArtifactId, CriterionId, ObservationId } from "./ids.js"

/** Short free-text intent. Logged verbatim; never a request for chain-of-thought. */
const Intent = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(280)))

export const ToolName = Schema.Literals([
  "observe",
  "navigate",
  "click",
  "fill",
  "press",
  "scroll",
  "screenshot",
  "check",
  "finish"
])
export type ToolName = typeof ToolName["Type"]

export const ObserveParams = Schema.Struct({}).annotate({ identifier: "ObserveParams" })
export const NavigateParams = Schema.Struct({ url: Schema.NonEmptyString, intent: Intent }).annotate({
  identifier: "NavigateParams"
})
export const ClickParams = Schema.Struct({
  observationId: ObservationId,
  ref: Schema.NonEmptyString,
  intent: Intent
}).annotate({ identifier: "ClickParams" })
export const FillParams = Schema.Struct({
  observationId: ObservationId,
  ref: Schema.NonEmptyString,
  value: Schema.String,
  intent: Intent
}).annotate({ identifier: "FillParams" })
export const PressParams = Schema.Struct({
  observationId: Schema.optionalKey(ObservationId),
  ref: Schema.optionalKey(Schema.NonEmptyString),
  key: Schema.NonEmptyString,
  intent: Intent
}).annotate({ identifier: "PressParams" })
export const ScrollParams = Schema.Struct({
  direction: Schema.Literals(["up", "down"]),
  amount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  intent: Intent
}).annotate({ identifier: "ScrollParams" })
export const ScreenshotParams = Schema.Struct({
  label: Schema.optionalKey(Schema.NonEmptyString),
  fullPage: Schema.optionalKey(Schema.Boolean)
}).annotate({ identifier: "ScreenshotParams" })
/** The agent asks for evidence collection + evaluation. It supplies NO verdict. */
export const CheckParams = Schema.Struct({
  criterionId: CriterionId,
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500)))
}).annotate({ identifier: "CheckParams" })
export const FinishParams = Schema.Struct({
  summary: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000)))
}).annotate({ identifier: "FinishParams" })

/** Schema-per-tool, keyed by name — what the tool dispatcher validates against. */
export const toolParamSchemas = {
  observe: ObserveParams,
  navigate: NavigateParams,
  click: ClickParams,
  fill: FillParams,
  press: PressParams,
  scroll: ScrollParams,
  screenshot: ScreenshotParams,
  check: CheckParams,
  finish: FinishParams
} as const

export type ToolParamsFor<N extends ToolName> = typeof toolParamSchemas[N]["Type"]

/** One element of a page observation. Driver-minted `ref`, valid only with its `observationId`. */
export const ObservedElement = Schema.Struct({
  ref: Schema.NonEmptyString,
  role: Schema.String,
  name: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.Int),
  checked: Schema.optionalKey(Schema.Boolean),
  selected: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean)
}).annotate({ identifier: "ObservedElement" })
export type ObservedElement = typeof ObservedElement["Type"]

export const ObserveResult = Schema.Struct({
  observationId: ObservationId,
  url: Schema.String,
  title: Schema.String,
  /** Compact accessibility representation handed to the model. Never a Playwright object. */
  snapshot: Schema.String,
  elements: Schema.Array(ObservedElement)
}).annotate({ identifier: "ObserveResult" })
export type ObserveResult = typeof ObserveResult["Type"]

export const NavigateResult = Schema.Struct({
  url: Schema.String,
  /** False when the navigation did not settle — feeds the absence rule (policy/absence.ts). */
  settled: Schema.Boolean
}).annotate({ identifier: "NavigateResult" })
export type NavigateResult = typeof NavigateResult["Type"]

export const InteractionResult = Schema.Struct({
  performed: Schema.Literal(true),
  /** True when the page started a navigation as a result of the interaction. */
  navigated: Schema.Boolean
}).annotate({ identifier: "InteractionResult" })
export type InteractionResult = typeof InteractionResult["Type"]

export const ScreenshotResult = Schema.Struct({
  artifactId: ArtifactId,
  label: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "ScreenshotResult" })
export type ScreenshotResult = typeof ScreenshotResult["Type"]

export const CheckAccepted = Schema.Struct({
  criterionId: CriterionId,
  accepted: Schema.Literal(true)
}).annotate({ identifier: "CheckAccepted" })
export type CheckAccepted = typeof CheckAccepted["Type"]

export const FinishAccepted = Schema.Struct({
  accepted: Schema.Literal(true),
  /** `finish` triggers final verification; it is never sufficient for success. */
  note: Schema.String
}).annotate({ identifier: "FinishAccepted" })
export type FinishAccepted = typeof FinishAccepted["Type"]

export const ToolErrorCode = Schema.Literals([
  "invalid-params",
  "stale-observation",
  "unknown-reference",
  "ambiguous-reference",
  "origin-not-allowed",
  "unknown-criterion",
  "operation-failed",
  "run-finished"
])
export type ToolErrorCode = typeof ToolErrorCode["Type"]

/**
 * A typed tool ERROR result handed back to the agent. The action still counts against the
 * indicative `maxActions` budget, and the harness NEVER falls back to a different element.
 */
export const ToolErrorResult = Schema.Struct({
  error: Schema.Literal(true),
  code: ToolErrorCode,
  message: Schema.String,
  /** What the agent should do next. `re-observe` for stale/unknown refs. */
  remedy: Schema.Literals(["re-observe", "choose-another-action", "none"])
}).annotate({ identifier: "ToolErrorResult" })
export type ToolErrorResult = typeof ToolErrorResult["Type"]

/**
 * Schema-per-tool for what the harness hands BACK to the model. spec §7 requires arguments *and*
 * results to be Schema-validated: the driver lives in another package, so its return value is an
 * unchecked trust boundary until it is decoded here. A result that does not match is never
 * forwarded to the model — it comes back as a typed tool error instead.
 */
export const toolResultSchemas = {
  observe: ObserveResult,
  navigate: NavigateResult,
  click: InteractionResult,
  fill: InteractionResult,
  press: InteractionResult,
  scroll: InteractionResult,
  screenshot: ScreenshotResult,
  check: CheckAccepted,
  finish: FinishAccepted
} as const

export type ToolResultFor<N extends ToolName> = typeof toolResultSchemas[N]["Type"]

export type ToolOkResult =
  | ObserveResult
  | NavigateResult
  | InteractionResult
  | ScreenshotResult
  | CheckAccepted
  | FinishAccepted

export type ToolResult = ToolOkResult | ToolErrorResult

export const isToolError = (result: ToolResult): result is ToolErrorResult =>
  "error" in result && result.error === true
