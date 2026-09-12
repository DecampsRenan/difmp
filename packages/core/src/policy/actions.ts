/**
 * `maxActions` is INDICATIVE. This module counts accepted browser tool calls and emits one
 * guidance notice on the first crossing. It never refuses an action, never degrades a status
 * and never derives a hidden blocking limit. Blocking budgets live in policy/budgets.ts.
 */

export interface ActionGuidanceState {
  readonly used: number
  readonly guidance: number
  /** True once the crossing notice has been emitted — it is emitted EXACTLY ONCE. */
  readonly notified: boolean
}

export interface ActionGuidanceNotice {
  readonly used: number
  readonly guidance: number
  /** e.g. `28 actions / 25 suggested` */
  readonly rendering: string
  /** One short nudge injected into the agent conversation. Not an instruction to stop. */
  readonly nudge: string
}

export interface ActionGuidanceStep {
  readonly state: ActionGuidanceState
  /** Present only on the first crossing. */
  readonly notice?: ActionGuidanceNotice
}

export const makeActionGuidance = (guidance: number): ActionGuidanceState => ({
  used: 0,
  guidance,
  notified: false
})

export const renderActionGuidance = (used: number, guidance: number): string =>
  `${used} actions / ${guidance} suggested`

const nudgeFor = (rendering: string): string =>
  `Indicative action threshold crossed (${rendering}). Briefly reassess your approach. ` +
  `No action is refused and the verdict is not affected.`

/**
 * Count one ACCEPTED browser tool call — observations, screenshots and failed attempts included.
 * Model calls and verification operations are counted separately and never here.
 */
export const recordAction = (state: ActionGuidanceState): ActionGuidanceStep => {
  const used = state.used + 1
  const crossing = !state.notified && used > state.guidance
  const next: ActionGuidanceState = { used, guidance: state.guidance, notified: state.notified || crossing }
  if (!crossing) return { state: next }
  const rendering = renderActionGuidance(used, state.guidance)
  return {
    state: next,
    notice: { used, guidance: state.guidance, rendering, nudge: nudgeFor(rendering) }
  }
}

export const guidanceExceeded = (state: ActionGuidanceState): boolean => state.used > state.guidance

/**
 * Exceeding the indicative threshold is NEVER a reason to end the loop. Kept as a named
 * constant so the runner reads as the contract does.
 */
export const actionGuidanceIsBlocking = false as const
