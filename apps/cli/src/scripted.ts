/**
 * Public authoring surface for deterministic scripted walkthroughs.
 *
 * The implementation lives in a private workspace package, but this entry point is bundled into
 * the distributed `@decampsrenan/difmp` package. Consumers must import from
 * `@decampsrenan/difmp/scripted`, never from an
 * unpublished `@difmp/*` package.
 */
export type { ScriptFactory, ScriptFactoryContext } from "@difmp/core";

export {
  burnModelCallsScript,
  check,
  clickByName,
  clickWithStaleObservation,
  exceedActionsScript,
  fillByName,
  finish,
  findElement,
  happyPathScript,
  navigate,
  observe,
  prematureFinishScript,
  renderVerdict,
  resolveParams,
  resolveStep,
  screenshot,
  staleObservationScript,
} from "@difmp/agent-runtime";

export type {
  AgentScript,
  HappyPathOptions,
  ScriptContext,
  ScriptedCall,
  ScriptedParams,
  ScriptedProviderScript,
  ScriptedStep,
  ScriptedToolOutcome,
  ScriptedTurn,
  VerdictScript,
  VerdictSpec,
} from "@difmp/agent-runtime";
