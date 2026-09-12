import type { AgentScript, ScriptedCall, ScriptedStep } from "@difmp/agent-runtime";
import {
  burnModelCallsScript,
  check,
  clickWithStaleObservation,
  finish,
  observe,
  screenshot,
} from "@difmp/agent-runtime";
import type { JourneyOptions } from "./journey.js";
import { createProjectSteps, formShape, reloadSteps } from "./journey.js";

/**
 * The risky-behaviour cases of spec §13, bound to the fixture app.
 *
 * `@difmp/agent-runtime` already ships app-agnostic versions of these shapes
 * (`prematureFinishScript`, `exceedActionsScript`, `staleObservationScript`,
 * `burnModelCallsScript`). The variants below exist because the interesting assertions need the
 * real app: a stale reference must be refused *while a real element with that name exists*, and a
 * run that crosses `maxActions` must still *pass*, which requires a journey that actually succeeds.
 */

const turn = (text: string, calls: ReadonlyArray<ScriptedCall>): ScriptedStep => ({ text, calls });

const criterionAt = (options: JourneyOptions, index: number): string => {
  const ids = options.criterionIds ?? ["c1", "c2", "c3"];
  const id = ids[index];
  if (id === undefined) throw new Error(`the scripted journey needs a criterion at index ${index}`);
  return id;
};

/**
 * Declares the run complete after a single observation, without asking for any check.
 * `finish` is never sufficient for success: every criterion must stay unresolved, which aggregates
 * to `inconclusive` — never `passed`.
 */
export const prematureFinishOnFixtureApp = (): AgentScript => ({
  id: "premature-finish",
  description: "observes once, then finishes without requesting a single evaluation",
  steps: [
    turn("I observe the home page", [observe()]),
    turn("I think it is done", [finish("the project looks created to me")]),
  ],
});

/**
 * Spends `padding` extra browser actions before doing the real work, so the attempt crosses the
 * indicative `maxActions` and still succeeds. Expected harness behaviour: ONE
 * `actionGuidanceExceeded` event at the first crossing, one nudge, no tool refused, no status
 * degraded — the run is `passed`.
 */
export const exceedActionsThenSucceed = (
  options: JourneyOptions & { readonly padding?: number },
): AgentScript => {
  const padding = options.padding ?? 20;
  const steps: Array<ScriptedStep> = [];
  for (let i = 0; i < padding; i++) {
    steps.push(
      turn(
        `exploration ${i + 1}`,
        i % 2 === 0 ? [observe()] : [screenshot(`exploration-${i + 1}`)],
      ),
    );
  }
  steps.push(...createProjectSteps(options));
  steps.push(
    turn("I request the evaluation of the presence before reloading", [
      check(criterionAt(options, 0)),
    ]),
  );
  steps.push(...reloadSteps(options));
  steps.push(
    turn("I request the evaluation of the remaining criteria", [
      check(criterionAt(options, 1)),
      check(criterionAt(options, 2)),
    ]),
  );
  steps.push(turn("done", [finish("a long but complete journey")]));
  return {
    id: "exceed-actions",
    description: `burns ${padding} extra browser actions, then completes the journey and passes`,
    steps,
  };
};

/**
 * Observes twice, then clicks with the FIRST `observationId` — stale as soon as the second
 * observation was taken. Expected harness behaviour: a typed tool error telling the agent to
 * re-observe, the action still counted, and NO fallback click on some other element.
 * The script then re-observes and completes the journey normally.
 */
export const staleObservationOnFixtureApp = (options: JourneyOptions): AgentScript => {
  const shape = formShape(options.variant ?? "healthy");
  const target = shape.reveal ?? shape.submit;
  return {
    id: "stale-observation",
    description: `reuses an expired observationId to click ${JSON.stringify(target)}, then recovers`,
    steps: [
      turn("first observation", [observe()]),
      turn("second observation", [observe()]),
      turn("I click with a stale reference", [clickWithStaleObservation(target)]),
      turn("I re-observe as the harness asks me to", [observe()]),
      ...createProjectSteps(options),
      turn("I request the evaluation of the presence before reloading", [
        check(criterionAt(options, 0)),
      ]),
      ...reloadSteps(options),
      turn("I request the evaluation of the remaining criteria", [
        check(criterionAt(options, 1)),
        check(criterionAt(options, 2)),
      ]),
      turn("done", [finish("stale reference refused, then the journey carried through")]),
    ],
  };
};

/**
 * A long, slow, perfectly legal run: `turns` model calls, each spending `perTurn` browser actions.
 * Actions are cheap in model calls, so this stays well inside `maxModelCalls` while lasting long
 * enough for a cancellation to arrive mid-flight. It ends with the real journey, so an uncancelled
 * run of this script still passes.
 */
export const slowExplorationScript = (
  options: JourneyOptions & { readonly turns?: number; readonly perTurn?: number },
): AgentScript => {
  const turns = options.turns ?? 20;
  const perTurn = options.perTurn ?? 12;
  const steps: Array<ScriptedStep> = [];
  for (let t = 0; t < turns; t++) {
    const calls: Array<ScriptedCall> = [];
    for (let i = 0; i < perTurn; i++)
      calls.push(i % 2 === 0 ? observe() : screenshot(`exploration-${t}-${i}`));
    steps.push(turn(`exploration ${t + 1}`, calls));
  }
  steps.push(...createProjectSteps(options));
  steps.push(
    turn("I request the evaluation of the presence before reloading", [
      check(criterionAt(options, 0)),
    ]),
  );
  steps.push(...reloadSteps(options));
  steps.push(
    turn("I request the evaluation of the remaining criteria", [
      check(criterionAt(options, 1)),
      check(criterionAt(options, 2)),
    ]),
  );
  steps.push(turn("done", [finish("a long exploration, then the complete journey")]));
  return {
    id: "slow-exploration",
    description: `${turns} turns of ${perTurn} browser actions, then the journey`,
    steps,
  };
};

/**
 * Runs the journey to the end but asks for only the FIRST TWO criteria, then finishes. The third is
 * never requested by the agent, so only the runner's final pass sees it — and with no evidence able
 * to settle it, it resolves to `inconclusive`. Two passed criteria must not aggregate to `passed`.
 */
export const skipLastCriterion = (options: JourneyOptions): AgentScript => ({
  id: "unevaluated-criterion",
  description: "completes the journey but never requests the last criterion",
  steps: [
    ...createProjectSteps(options),
    turn("I request the evaluation of the presence before reloading", [
      check(criterionAt(options, 0)),
    ]),
    ...reloadSteps(options),
    turn("I request the evaluation of persistence", [check(criterionAt(options, 1))]),
    turn("done", [finish("I did not request the evaluation of the last criterion")]),
  ],
});

/**
 * Never finishes and never checks: only a BLOCKING budget can end this run. Paired with a large
 * `defaultUsage` (see `scripts/index.ts`) it exhausts `maxTokens`; left with the default usage it
 * ends on `maxModelCalls`. Either way the outcome is `inconclusive`, not `failed`, and no late
 * action or request is permitted afterwards.
 */
export const budgetExhaustionScript = (): AgentScript => burnModelCallsScript();
