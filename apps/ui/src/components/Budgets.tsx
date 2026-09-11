import type { UiRuntimeConfig } from "../runtime/config.js"
import type { RunModel } from "../state/model.js"
import { Empty, Gauge, Panel, durationOf } from "./ui.js"

const budgetLabel: Record<string, string> = {
  attemptTimeout: "délai de tentative",
  operationTimeout: "délai d'opération",
  maxModelCalls: "appels modèle",
  maxTokens: "jetons"
}

/**
 * Cost is shown ONLY when it can actually be computed from declared prices. With no price table the
 * spec requires the literal string "indisponible" — never an estimate, never a zero.
 */
const renderCost = (model: RunModel, pricing: UiRuntimeConfig["pricing"]): string => {
  if (pricing === undefined) return "indisponible"
  const total = (model.model.inputTokens / 1_000_000) * pricing.inputPerMillionTokens +
    (model.model.outputTokens / 1_000_000) * pricing.outputPerMillionTokens
  if (!Number.isFinite(total)) return "indisponible"
  return `${total.toFixed(4)} ${pricing.currency}`
}

export const BlockingBudgets = (props: {
  readonly model: RunModel
  readonly pricing: UiRuntimeConfig["pricing"]
  readonly elapsedMs: number
}) => {
  const budgets = props.model.config?.budgets
  const breaches = props.model.budgetBreaches
  const exhausted = (kind: string) => breaches.some((b) => b.budget === kind)
  const tokensUsed = props.model.model.inputTokens + props.model.model.outputTokens

  return (
    <Panel
      title="Budgets bloquants"
      testId="blocking-budgets-panel"
      note="Épuiser l'un de ces budgets arrête la boucle et rend le run « non concluant ». Ce sont les seules limites qui bloquent."
    >
      {budgets === undefined
        ? <Empty>Budgets inconnus tant que la configuration n'est pas résolue.</Empty>
        : (
          <div className="gauges">
            <Gauge
              kind="blocking"
              label="Appels modèle"
              used={props.model.model.started}
              limit={budgets.maxModelCalls}
              exhausted={exhausted("maxModelCalls")}
              testId="budget-maxModelCalls"
            />
            <Gauge
              kind="blocking"
              label="Jetons"
              used={tokensUsed}
              limit={budgets.maxTokens}
              exhausted={exhausted("maxTokens")}
              testId="budget-maxTokens"
              footnote={`dont ${props.model.model.verifierTokens.toLocaleString("fr-FR")} vérificateur · réserve ${
                budgets.verifierReserveTokens.toLocaleString("fr-FR")
              }`}
            />
            <Gauge
              kind="blocking"
              label="Délai de tentative"
              used={Math.min(props.elapsedMs, budgets.attemptTimeoutMs)}
              limit={budgets.attemptTimeoutMs}
              unit="ms"
              exhausted={exhausted("attemptTimeout")}
              testId="budget-attemptTimeout"
            />
            <dl className="budget-scalars">
              <div>
                <dt>Délai par opération</dt>
                <dd>{durationOf(budgets.operationTimeoutMs)}</dd>
              </div>
              <div>
                <dt>Délai de nettoyage fixture</dt>
                <dd>{durationOf(budgets.fixtureCleanupTimeoutMs)}</dd>
              </div>
              <div>
                <dt>Coût</dt>
                <dd data-testid="cost-value">{renderCost(props.model, props.pricing)}</dd>
              </div>
            </dl>
          </div>
        )}

      {breaches.length === 0 ? null : (
        <ul className="breaches" data-testid="budget-breaches">
          {breaches.map((breach) => (
            <li key={`${breach.budget}-${breach.used}`}>
              <strong>{budgetLabel[breach.budget] ?? breach.budget}</strong> épuisé — {breach.used} / {breach.limit}
              {breach.detail === undefined ? null : ` — ${breach.detail}`}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/**
 * Deliberately a SEPARATE panel from the blocking budgets. `maxActions` never refuses an action and
 * never degrades a status (design-contracts §7); merging it into the budget gauges would read as a
 * limit, which it is not.
 */
export const ActionGuidance = (props: { readonly model: RunModel }) => {
  const guidance = props.model.contractMaxActions ?? props.model.guidance?.guidance ?? props.model.config?.maxActions
  const used = props.model.actionCount
  const exceededEvent = props.model.guidance

  return (
    <Panel
      title="Actions — seuil indicatif"
      testId="action-guidance-panel"
      note="Indication de trajectoire, pas une limite. Dépasser ce seuil ne refuse rien et ne dégrade aucun statut : un run qui réussit en 40 actions reste « réussi »."
      aside={<span className="tag tag-indicative">indicatif</span>}
    >
      {guidance === undefined
        ? (
          <p className="big-number" data-testid="action-count">
            {used} <small>action(s) acceptée(s) — seuil indicatif inconnu</small>
          </p>
        )
        : (
          <>
            <p className="big-number" data-testid="action-count">
              {used} <small>/ {guidance} indicatives</small>
            </p>
            <Gauge
              kind="indicative"
              label="Actions acceptées"
              used={used}
              limit={guidance}
              testId="guidance-gauge"
            />
          </>
        )}

      {exceededEvent === undefined
        ? null
        : (
          <p className="guidance-note" data-testid="guidance-exceeded">
            <strong>{exceededEvent.rendering}</strong> — seuil indicatif dépassé. Aucune action refusée, aucun
            statut dégradé ; une relance de cadrage a été envoyée à l'agent.
          </p>
        )}

      <p className="panel-foot">
        Les appels modèle et les opérations de vérification sont comptés à part et jamais imputés à ce seuil.
      </p>
    </Panel>
  )
}
