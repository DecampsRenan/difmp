import type { ScriptFactory, ScriptFactoryContext } from "@difmp/core"
import type { ScriptedProviderScript } from "@difmp/agent-runtime"
import type { Variant } from "@difmp/fixture-app"
import { isVariant } from "@difmp/fixture-app"
import type { FixtureAppScriptOptions } from "./index.js"
import { fixtureAppScripts } from "./index.js"

/**
 * The `scripts` registry of `difmp.config.ts`, for the deterministic (scripted) adapter.
 *
 * A script is registered as a FACTORY rather than as a finished object because it has to name the
 * value the run will really type into the form — `Project {{ run.id }}` is only a concrete string
 * once the run id exists — and the criterion ids of the spec being run. The harness calls the
 * factory once the run id is minted and the inputs are resolved (`ScriptFactoryContext`).
 *
 * Selecting one stays configuration, never a module path: `providerOptions.script: "<name>"`.
 */

/** Project name used by the fixture-free scenario, which declares no `inputs` on purpose. */
const noFixtureProjectName = "Project without fixture"

const projectNameOf = (ctx: ScriptFactoryContext, fallback: string): string => {
  const value = ctx.inputs["projectName"]
  return typeof value === "string" && value.trim() !== "" ? value : fallback
}

/**
 * Which variant the fixture app in front of us is serving. The scripted adapter has to know,
 * because `alt-layout` renames every control — it is the same journey through a different UI.
 * `FIXTURE_APP_VARIANT` is the same variable the fixture app itself reads.
 */
export const configuredVariant = (env = process.env["FIXTURE_APP_VARIANT"]): Variant => {
  if (env === undefined || env.trim() === "") return "healthy"
  if (!isVariant(env)) throw new Error(`FIXTURE_APP_VARIANT: unknown variant ${JSON.stringify(env)}`)
  return env
}

const optionsFor = (ctx: ScriptFactoryContext, variant: Variant): FixtureAppScriptOptions => ({
  baseUrl: ctx.baseUrl,
  projectName: projectNameOf(
    ctx,
    ctx.scenarioId === "project-create-no-fixture" ? noFixtureProjectName : `Project ${ctx.runId}`
  ),
  variant,
  criterionIds: ctx.criterionIds
})

/**
 * Every scripted case the demo needs, as config-registrable factories.
 *
 * `auto` is the entry the demo config uses by default: it picks the journey from the scenario being
 * run and the variant the fixture app was started with, so the whole four-variant matrix is driven
 * by `FIXTURE_APP_VARIANT` without editing the config.
 */
export const fixtureAppScriptRegistry = (): Record<string, ScriptFactory<ScriptedProviderScript>> => {
  const named = (name: string): ScriptFactory<ScriptedProviderScript> => (ctx) => {
    const variant = isVariant(name) ? name : configuredVariant()
    const script = fixtureAppScripts(optionsFor(ctx, variant))[name]
    if (script === undefined) throw new Error(`no scripted case named ${JSON.stringify(name)}`)
    return script
  }

  const names = Object.keys(fixtureAppScripts({ baseUrl: "http://127.0.0.1", projectName: "x" }))
  const registry: Record<string, ScriptFactory<ScriptedProviderScript>> = {}
  for (const name of names) registry[name] = named(name)

  registry["auto"] = (ctx) =>
    named(ctx.scenarioId === "project-create-no-fixture" ? "no-fixture" : configuredVariant())(ctx)

  return registry
}
