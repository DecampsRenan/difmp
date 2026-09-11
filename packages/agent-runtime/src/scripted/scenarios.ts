import type { AgentScript, ScriptedCall, ScriptedStep } from "./script.js"
import { check, clickByName, clickWithStaleObservation, fillByName, finish, observe, screenshot } from "./script.js"

export interface HappyPathOptions {
  readonly criterionIds: ReadonlyArray<string>
  readonly fills?: ReadonlyArray<{ readonly name: string; readonly value: string }>
  /** Accessible name of the control that submits the form. */
  readonly submit?: string
}

const turn = (text: string, calls: ReadonlyArray<ScriptedCall>): ScriptedStep => ({ text, calls })

/** Observe, fill, submit, re-observe, screenshot, ask for every criterion, finish. */
export const happyPathScript = (options: HappyPathOptions): AgentScript => {
  const steps: Array<ScriptedStep> = [turn("je regarde la page", [observe()])]
  if (options.fills !== undefined && options.fills.length > 0) {
    steps.push(turn(
      "je remplis le formulaire",
      options.fills.map((entry) => fillByName(entry.name, entry.value))
    ))
  }
  if (options.submit !== undefined) {
    steps.push(turn("je valide", [clickByName(options.submit, { intent: "soumettre le formulaire" })]))
    steps.push(turn("je ré-observe après navigation", [observe()]))
  }
  steps.push(turn("je capture l'état atteint", [screenshot("etat-final")]))
  steps.push(turn(
    "je demande l'évaluation des critères",
    options.criterionIds.map((id) => check(id))
  ))
  steps.push(turn("terminé", [finish("parcours nominal exécuté")]))
  return {
    id: "happy-path",
    description: "nominal walkthrough: observe, fill, submit, capture, check every criterion, finish",
    steps
  }
}

/** Calls `finish` immediately. `finish` must never be enough to declare success. */
export const prematureFinishScript = (): AgentScript => ({
  id: "premature-finish",
  description: "declares the run complete after a single observation, without asking for any check",
  steps: [
    turn("je regarde la page", [observe()]),
    turn("c'est bon", [finish("je pense que c'est fait")])
  ]
})

/** Burns `count` browser actions before finishing, to cross the indicative threshold. */
export const exceedActionsScript = (options: {
  readonly count: number
  readonly criterionIds: ReadonlyArray<string>
}): AgentScript => {
  const steps: Array<ScriptedStep> = []
  for (let i = 0; i < options.count; i++) {
    steps.push(turn(`exploration ${i + 1}`, i % 2 === 0 ? [observe()] : [screenshot(`exploration-${i + 1}`)]))
  }
  steps.push(turn("évaluation", options.criterionIds.map((id) => check(id))))
  steps.push(turn("terminé", [finish("parcours long")]))
  return {
    id: "exceed-actions",
    description: `spends ${options.count} browser actions before checking, crossing the indicative threshold`,
    steps
  }
}

/** Uses an expired `observationId`; the harness must answer with a typed error, not a fallback click. */
export const staleObservationScript = (options: {
  readonly target: string
  readonly criterionIds: ReadonlyArray<string>
}): AgentScript => ({
  id: "stale-observation",
  description: "re-observes, then reuses the first observationId — the reference must be refused",
  steps: [
    turn("première observation", [observe()]),
    turn("seconde observation", [observe()]),
    turn("je clique avec une référence périmée", [clickWithStaleObservation(options.target)]),
    turn("je ré-observe comme demandé", [observe()]),
    turn("je clique correctement", [clickByName(options.target)]),
    turn("évaluation", options.criterionIds.map((id) => check(id))),
    turn("terminé", [finish("référence périmée corrigée")])
  ]
})

/** Never finishes: only a blocking budget (maxModelCalls / maxTokens) ends this run. */
export const burnModelCallsScript = (): AgentScript => ({
  id: "burn-model-calls",
  description: "observes forever; the run can only end on a blocking budget, never on maxActions",
  steps: [turn("j'observe encore", [observe()])],
  onExhausted: "repeat"
})
