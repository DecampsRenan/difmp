import type { CriterionStatus, Evaluator } from "../types/events.js"
import type { CriterionView } from "../state/model.js"
import { Badge, Empty, Panel } from "./ui.js"

const statusTone: Record<CriterionStatus, string> = {
  pending: "neutral",
  passed: "ok",
  failed: "bad",
  inconclusive: "warn",
  error: "bad"
}

const statusLabel: Record<CriterionStatus, string> = {
  pending: "en attente",
  passed: "réussi",
  failed: "échoué",
  inconclusive: "non concluant",
  error: "erreur"
}

const evaluatorLabel = (evaluator: Evaluator): string => {
  switch (evaluator.kind) {
    case "model":
      return `modèle ${evaluator.provider}/${evaluator.model}`
    case "scripted-model":
      // Never present a deterministic double as a real model judgement (design-contracts §8).
      return "double scripté (pas un jugement de modèle)"
    case "code":
      return `check TS « ${evaluator.checkName} »`
  }
}

const absenceLabel: Record<string, string> = {
  "uncertain-navigation": "absence après navigation incertaine → non concluant",
  "established-at-checkpoint": "absence établie au point de contrôle → échec"
}

export const Criteria = (props: { readonly criteria: ReadonlyArray<CriterionView> }) => (
  <Panel
    title="Critères de réussite"
    testId="criteria-panel"
    aside={<span className="count">{props.criteria.length}</span>}
  >
    {props.criteria.length === 0
      ? <Empty>Le contrat n'est pas encore gelé.</Empty>
      : (
        <ul className="criteria" data-testid="criteria-list">
          {props.criteria.map((criterion) => {
            const result = criterion.result
            return (
              <li key={criterion.id} className="criterion" data-testid={`criterion-${criterion.id}`}>
                <div className="criterion-head">
                  <code className="criterion-id">{criterion.id}</code>
                  <Badge tone={statusTone[criterion.status]}>
                    <span data-testid={`criterion-status-${criterion.id}`}>{statusLabel[criterion.status]}</span>
                  </Badge>
                  <span
                    className={`method method-${criterion.method ?? "unknown"}`}
                    data-testid={`criterion-method-${criterion.id}`}
                    title={criterion.method === "code"
                      ? "Évalué par un check TypeScript déterministe"
                      : criterion.method === "model"
                      ? "Évalué par le modèle à partir des preuves"
                      : "Méthode encore inconnue (contrat non chargé)"}
                  >
                    {criterion.method === "code"
                      ? `code${criterion.checkName === undefined ? "" : ` · ${criterion.checkName}`}`
                      : criterion.method === "model"
                      ? "modèle"
                      : "méthode inconnue"}
                  </span>
                </div>

                <p className="criterion-text">{criterion.text ?? "(texte du critère indisponible)"}</p>

                {criterion.evidenceRequested && result === undefined
                  ? <p className="criterion-meta">Preuves demandées, évaluation en cours…</p>
                  : null}

                {result === undefined ? null : (
                  <dl className="criterion-result">
                    <div>
                      <dt>Attendu</dt>
                      <dd>{result.expected}</dd>
                    </div>
                    <div>
                      <dt>Observé</dt>
                      <dd>{result.observed}</dd>
                    </div>
                    <div>
                      <dt>Évaluateur</dt>
                      <dd>{evaluatorLabel(result.evaluator)}</dd>
                    </div>
                    {result.absence === undefined ? null : (
                      <div>
                        <dt>Règle d'absence</dt>
                        <dd>{absenceLabel[result.absence] ?? result.absence}</dd>
                      </div>
                    )}
                    {result.limitations === undefined ? null : (
                      <div>
                        <dt>Limites</dt>
                        <dd>{result.limitations}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Preuves</dt>
                      <dd>
                        {result.evidence.length === 0
                          ? "aucune"
                          : result.evidence.map((id) => <code key={id} className="chip">{id}</code>)}
                      </dd>
                    </div>
                  </dl>
                )}
              </li>
            )
          })}
        </ul>
      )}
  </Panel>
)
