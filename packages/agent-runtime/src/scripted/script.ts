import type { ObservedElement, ObserveResult, Prompt as HarnessPrompt, ToolName } from "@harness/core"

/**
 * A scripted run is a TEST DOUBLE. The format is deliberately small: a list of turns, each turn a
 * short text plus the tool calls to emit. A turn may be a function of the conversation so far, which
 * is what lets a script pick a real element ref, or deliberately reuse a stale `observationId`.
 */
export interface ScriptedToolOutcome {
  readonly id: string
  readonly name: string
  readonly result: unknown
  readonly isError: boolean
}

export interface ScriptContext {
  /** 0-based index of this model call inside the browsing conversation. */
  readonly turn: number
  readonly prompt: HarnessPrompt
  /** Every tool result the harness has returned so far, oldest first. */
  readonly results: ReadonlyArray<ScriptedToolOutcome>
  /** The most recent successful `observe`. Only refs from this one are live. */
  readonly observation?: ObserveResult
  /** Every observationId ever returned, oldest first — a script can pick an expired one on purpose. */
  readonly observationIds: ReadonlyArray<string>
}

export type ScriptedParams = Record<string, unknown> | ((ctx: ScriptContext) => Record<string, unknown>)

export interface ScriptedCall {
  readonly tool: ToolName
  readonly params: ScriptedParams
}

export interface ScriptedTurn {
  /** Short assistant text. Never a request for hidden reasoning; it is logged verbatim. */
  readonly text?: string
  readonly calls?: ReadonlyArray<ScriptedCall>
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
}

export type ScriptedStep = ScriptedTurn | ((ctx: ScriptContext) => ScriptedTurn)

export interface AgentScript {
  readonly id: string
  readonly description: string
  readonly steps: ReadonlyArray<ScriptedStep>
  /**
   * What happens once the declared steps run out.
   * `stop` — emit a text-only turn, which the runner treats as no progress.
   * `repeat` — replay the last step forever, so a blocking budget is what ends the run.
   */
  readonly onExhausted?: "stop" | "repeat"
}

export const resolveStep = (script: AgentScript, ctx: ScriptContext): ScriptedTurn | undefined => {
  const index = ctx.turn
  const step = index < script.steps.length
    ? script.steps[index]
    : script.onExhausted === "repeat"
    ? script.steps[script.steps.length - 1]
    : undefined
  if (step === undefined) return undefined
  return typeof step === "function" ? step(ctx) : step
}

export const resolveParams = (params: ScriptedParams, ctx: ScriptContext): Record<string, unknown> =>
  typeof params === "function" ? params(ctx) : params

// --- element helpers ---------------------------------------------------------------------------

export const findElement = (
  observation: ObserveResult | undefined,
  match: { readonly name?: string; readonly role?: string }
): ObservedElement | undefined =>
  observation?.elements.find((element) =>
    (match.role === undefined || element.role === match.role) &&
    (match.name === undefined || element.name === match.name || element.placeholder === match.name)
  )

/** Throwing here is right: a script that cannot find its element is a broken fixture, not a run failure. */
const requireLive = (ctx: ScriptContext, what: string): ObserveResult => {
  if (ctx.observation === undefined) throw new Error(`scripted step needs a live observation to ${what}`)
  return ctx.observation
}

const requireRef = (ctx: ScriptContext, match: { name?: string; role?: string }, what: string): string => {
  const observation = requireLive(ctx, what)
  const element = findElement(observation, match)
  if (element === undefined) {
    throw new Error(
      `scripted step could not find ${JSON.stringify(match)} in ${observation.observationId}; ` +
        `available: ${observation.elements.map((e) => `${e.role}:${e.name ?? ""}`).join(", ")}`
    )
  }
  return element.ref
}

// --- step builders -----------------------------------------------------------------------------

export const observe = (): ScriptedCall => ({ tool: "observe", params: {} })

export const navigate = (url: string, intent?: string): ScriptedCall => ({
  tool: "navigate",
  params: { url, ...(intent === undefined ? {} : { intent }) }
})

export const screenshot = (label?: string): ScriptedCall => ({
  tool: "screenshot",
  params: label === undefined ? {} : { label }
})

export const clickByName = (name: string, options?: { readonly role?: string; readonly intent?: string }) => ({
  tool: "click" as const,
  params: (ctx: ScriptContext) => ({
    observationId: requireLive(ctx, "click").observationId,
    ref: requireRef(ctx, { name, ...(options?.role === undefined ? {} : { role: options.role }) }, "click"),
    ...(options?.intent === undefined ? {} : { intent: options.intent })
  })
})

export const fillByName = (name: string, value: string, options?: { readonly role?: string }) => ({
  tool: "fill" as const,
  params: (ctx: ScriptContext) => ({
    observationId: requireLive(ctx, "fill").observationId,
    ref: requireRef(ctx, { name, ...(options?.role === undefined ? {} : { role: options.role }) }, "fill"),
    value
  })
})

/** Deliberately reuses the FIRST observationId ever minted — stale as soon as a second observe ran. */
export const clickWithStaleObservation = (name: string): ScriptedCall => ({
  tool: "click",
  params: (ctx: ScriptContext) => ({
    observationId: ctx.observationIds[0] ?? "obs_1",
    ref: requireRef(ctx, { name }, "click")
  })
})

export const check = (criterionId: string, note?: string): ScriptedCall => ({
  tool: "check",
  params: { criterionId, ...(note === undefined ? {} : { note }) }
})

export const finish = (summary?: string): ScriptedCall => ({
  tool: "finish",
  params: summary === undefined ? {} : { summary }
})
