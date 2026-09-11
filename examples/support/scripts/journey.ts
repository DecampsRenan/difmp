import type { AgentScript, ScriptedCall, ScriptedStep } from "@harness/agent-runtime"
import { check, clickByName, fillByName, finish, navigate, observe, screenshot } from "@harness/agent-runtime"
import type { Variant } from "@harness/fixture-app"

/**
 * Fixture-app-specific browsing scripts for the deterministic (scripted) adapter.
 *
 * The script FORMAT and the reusable, app-agnostic patterns live in `@harness/agent-runtime`
 * (`src/scripted/script.ts` and `src/scripted/scenarios.ts`) — that package already ships that
 * location, so nothing is duplicated here. What lives in this file is the part that can only be
 * written against a concrete application: the real accessible names of the fixture app, per
 * variant, and the order of the "create then reload" journey.
 *
 * A scripted run exercises the real prompt construction, the real tool dispatch and real Playwright
 * calls against the demo app. It tests the HARNESS's decisions, never a model's ability to navigate.
 */

const turn = (text: string, calls: ReadonlyArray<ScriptedCall>): ScriptedStep => ({ text, calls })

export interface FormShape {
  /** Control that has to be activated before the form exists in the accessibility tree. */
  readonly reveal?: string
  readonly nameField: string
  readonly submit: string
}

/**
 * Accessible names as rendered by `examples/fixture-app/src/html.ts`. `alt-layout` is functionally
 * identical but differently shaped: the form hides behind a toggle and the wording changes.
 */
export const formShape = (variant: Variant): FormShape =>
  variant === "alt-layout"
    ? { reveal: "New project", nameField: "Name of the project", submit: "Add project" }
    : { nameField: "Project name", submit: "Create project" }

export interface JourneyOptions {
  /** Reload is expressed as a `navigate` back to this URL — there is no `reload` tool. */
  readonly baseUrl: string
  readonly projectName: string
  readonly variant?: Variant
  /** Defaults to the three criteria of `project-create`. */
  readonly criterionIds?: ReadonlyArray<string>
}

const criterionAt = (options: JourneyOptions, index: number): string => {
  const ids = options.criterionIds ?? ["c1", "c2", "c3"]
  const id = ids[index]
  if (id === undefined) throw new Error(`the scripted journey needs a criterion at index ${index}`)
  return id
}

/** Observe, (reveal,) fill, submit, re-observe, capture. Stops before any `check`. */
export const createProjectSteps = (options: JourneyOptions): Array<ScriptedStep> => {
  const shape = formShape(options.variant ?? "healthy")
  const steps: Array<ScriptedStep> = [turn("j'observe la page d'accueil", [observe()])]
  if (shape.reveal !== undefined) {
    steps.push(turn("j'ouvre le formulaire de création", [
      clickByName(shape.reveal, { intent: "révéler le formulaire de création" })
    ]))
    // The dialog is `hidden` until the toggle fires, so its fields are not in the previous snapshot.
    steps.push(turn("j'observe le formulaire révélé", [observe()]))
  }
  steps.push(turn("je saisis le nom du projet", [fillByName(shape.nameField, options.projectName)]))
  steps.push(turn("je valide la création", [clickByName(shape.submit, { intent: "créer le projet" })]))
  steps.push(turn("j'observe la liste après création", [observe()]))
  steps.push(turn("je capture l'état après création", [screenshot("apres-creation")]))
  return steps
}

/** The reload half: navigate back to the base URL, observe, capture. */
export const reloadSteps = (options: JourneyOptions): Array<ScriptedStep> => [
  turn("je recharge la page", [navigate(options.baseUrl, "recharger pour observer l'état persisté")]),
  turn("j'observe la liste après rechargement", [observe()]),
  turn("je capture l'état après rechargement", [screenshot("apres-rechargement")])
]

/**
 * The nominal journey of `project-create` / `project-create-checked`.
 * `c1` is asked BEFORE the reload, so the evidence for "appears after creation" is captured while
 * that state is still on screen; `c2` and `c3` are asked after.
 */
export const projectCreateScript = (options: JourneyOptions): AgentScript => {
  const variant = options.variant ?? "healthy"
  const steps: Array<ScriptedStep> = [
    ...createProjectSteps(options),
    turn("je demande l'évaluation de la présence avant rechargement", [check(criterionAt(options, 0))]),
    ...reloadSteps(options),
    turn("je demande l'évaluation des critères restants", [
      check(criterionAt(options, 1)),
      check(criterionAt(options, 2))
    ]),
    turn("terminé", [finish("projet créé, puis liste réobservée après rechargement")])
  ]
  return {
    id: `project-create/${variant}`,
    description: `creates ${options.projectName} on the ${variant} variant, then reloads and asks for every criterion`,
    steps
  }
}

/**
 * The fixture-free scenario: the agent signs in through the UI before creating anything.
 * Credentials are synthetic demo data written in the spec body, never secrets.
 */
export const loginThenCreateScript = (options: JourneyOptions & {
  readonly email: string
  readonly password: string
}): AgentScript => ({
  id: "project-create-no-fixture",
  description: "signs in through the login form, then runs the create-and-reload journey",
  steps: [
    turn("j'observe la page de connexion", [observe()]),
    turn("je saisis mes identifiants", [
      fillByName("Email", options.email),
      fillByName("Password", options.password)
    ]),
    turn("je me connecte", [clickByName("Sign in", { intent: "ouvrir la session" })]),
    turn("j'observe l'accueil de l'espace de travail", [observe()]),
    turn("je capture l'état connecté", [screenshot("apres-connexion")]),
    turn("je demande l'évaluation de la connexion", [check(criterionAt(options, 0))]),
    ...createProjectSteps(options),
    turn("je demande l'évaluation de la présence avant rechargement", [check(criterionAt(options, 1))]),
    ...reloadSteps(options),
    turn("je demande l'évaluation de la persistance", [check(criterionAt(options, 2))]),
    turn("terminé", [finish("connexion puis création vérifiées")])
  ]
})
