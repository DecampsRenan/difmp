import type { ScriptFactory, ScriptFactoryContext } from "@difmp/core";
import type { ScriptedProviderScript } from "@difmp/agent-runtime";
import {
  buildDemoStartUiScript,
  demoStartUiScriptNames,
  type DemoStartUiScriptName,
} from "./index.js";

const named =
  (name: DemoStartUiScriptName): ScriptFactory<ScriptedProviderScript> =>
  (ctx: ScriptFactoryContext) =>
    buildDemoStartUiScript(name, {
      criterionIds: ctx.criterionIds,
      searchTerm: "Dracula",
    });

/**
 * `scripts` registry for `difmp.config.ts`. Factories receive resolved criterion ids after the
 * run id is minted — same pattern as `examples/support/scripts/registry.ts`.
 *
 * `auto` picks the walkthrough from the scenario id so `difmp run` can execute the whole battery
 * without setting DIFMP_SCRIPT per file.
 */
export const demoStartUiScriptRegistry = (): Record<
  string,
  ScriptFactory<ScriptedProviderScript>
> => {
  const registry: Record<string, ScriptFactory<ScriptedProviderScript>> = {};
  for (const name of demoStartUiScriptNames) registry[name] = named(name);

  registry["auto"] = (ctx) => {
    const scenarioId = ctx.scenarioId;
    if (!(demoStartUiScriptNames as ReadonlyArray<string>).includes(scenarioId)) {
      throw new Error(
        `auto script: no walkthrough for scenario ${JSON.stringify(scenarioId)}; ` +
          `known: ${demoStartUiScriptNames.join(", ")}`,
      );
    }
    return named(scenarioId as DemoStartUiScriptName)(ctx);
  };

  return registry;
};
