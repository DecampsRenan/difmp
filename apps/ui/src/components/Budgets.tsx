import type { UiRuntimeConfig } from "../runtime/config.js";
import type { RunModel } from "../state/model.js";
import { Empty, Gauge, Panel, durationOf } from "./ui.js";

const budgetLabel: Record<string, string> = {
  attemptTimeout: "attempt timeout",
  operationTimeout: "operation timeout",
  maxModelCalls: "model calls",
  maxTokens: "tokens",
};

/**
 * Cost is shown ONLY when it can actually be computed from declared prices. With no price table the
 * spec requires the literal string "unavailable" — never an estimate, never a zero.
 */
const renderCost = (model: RunModel, pricing: UiRuntimeConfig["pricing"]): string => {
  if (pricing === undefined) return "unavailable";
  const total =
    (model.model.inputTokens / 1_000_000) * pricing.inputPerMillionTokens +
    (model.model.outputTokens / 1_000_000) * pricing.outputPerMillionTokens;
  if (!Number.isFinite(total)) return "unavailable";
  return `${total.toFixed(4)} ${pricing.currency}`;
};

export const BlockingBudgets = (props: {
  readonly model: RunModel;
  readonly pricing: UiRuntimeConfig["pricing"];
  readonly elapsedMs: number;
}) => {
  const budgets = props.model.config?.budgets;
  const breaches = props.model.budgetBreaches;
  const exhausted = (kind: string) => breaches.some((b) => b.budget === kind);
  const tokensUsed = props.model.model.inputTokens + props.model.model.outputTokens;

  return (
    <Panel
      title="Blocking budgets"
      testId="blocking-budgets-panel"
      note={
        'Exhausting any one of these budgets stops the loop and makes the run "inconclusive". ' +
        "These are the only limits that block."
      }
    >
      {budgets === undefined ? (
        <Empty>Budgets unknown until the configuration is resolved.</Empty>
      ) : (
        <div className="gauges">
          <Gauge
            kind="blocking"
            label="Model calls"
            used={props.model.model.started}
            limit={budgets.maxModelCalls}
            exhausted={exhausted("maxModelCalls")}
            testId="budget-maxModelCalls"
          />
          <Gauge
            kind="blocking"
            label="Tokens"
            used={tokensUsed}
            limit={budgets.maxTokens}
            exhausted={exhausted("maxTokens")}
            testId="budget-maxTokens"
            footnote={`of which ${props.model.model.verifierTokens.toLocaleString("en-US")} verifier · reserve ${budgets.verifierReserveTokens.toLocaleString(
              "en-US",
            )}`}
          />
          <Gauge
            kind="blocking"
            label="Attempt timeout"
            used={Math.min(props.elapsedMs, budgets.attemptTimeoutMs)}
            limit={budgets.attemptTimeoutMs}
            format={durationOf}
            exhausted={exhausted("attemptTimeout")}
            testId="budget-attemptTimeout"
          />
          <dl className="budget-scalars">
            <div>
              <dt>Per-operation timeout</dt>
              <dd>{durationOf(budgets.operationTimeoutMs)}</dd>
            </div>
            <div>
              <dt>Fixture cleanup timeout</dt>
              <dd>{durationOf(budgets.fixtureCleanupTimeoutMs)}</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd data-testid="cost-value">{renderCost(props.model, props.pricing)}</dd>
            </div>
          </dl>
        </div>
      )}

      {breaches.length === 0 ? null : (
        <ul className="breaches" data-testid="budget-breaches">
          {breaches.map((breach) => (
            <li key={`${breach.budget}-${breach.used}`}>
              <strong>{budgetLabel[breach.budget] ?? breach.budget}</strong> exhausted —{" "}
              {breach.used} / {breach.limit}
              {breach.detail === undefined ? null : ` — ${breach.detail}`}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
};

/**
 * Deliberately a SEPARATE panel from the blocking budgets. `maxActions` never refuses an action and
 * never degrades a status (design-contracts §7); merging it into the budget gauges would read as a
 * limit, which it is not.
 */
export const ActionGuidance = (props: { readonly model: RunModel }) => {
  const guidance =
    props.model.contractMaxActions ??
    props.model.guidance?.guidance ??
    props.model.config?.maxActions;
  const used = props.model.actionCount;
  const exceededEvent = props.model.guidance;

  return (
    <Panel
      title="Actions — indicative threshold"
      testId="action-guidance-panel"
      note={
        "A trajectory hint, not a limit. Crossing this threshold refuses nothing and degrades no status: " +
        'a run that succeeds in 40 actions is still "passed".'
      }
      aside={<span className="tag tag-indicative">indicative</span>}
    >
      {guidance === undefined ? (
        <p className="big-number" data-testid="action-count">
          {used} <small>accepted action(s) — indicative threshold unknown</small>
        </p>
      ) : (
        <>
          <p className="big-number" data-testid="action-count">
            {used} <small>/ {guidance} suggested</small>
          </p>
          <Gauge
            kind="indicative"
            label="Accepted actions"
            used={used}
            limit={guidance}
            testId="guidance-gauge"
          />
        </>
      )}

      {exceededEvent === undefined ? null : (
        <p className="guidance-note" data-testid="guidance-exceeded">
          <strong>{exceededEvent.rendering}</strong> — indicative threshold crossed. No action
          refused, no status degraded; a short refocusing nudge was sent to the agent.
        </p>
      )}

      <p className="panel-foot">
        Model calls and verification operations are counted separately and never charged to this
        threshold.
      </p>
    </Panel>
  );
};
