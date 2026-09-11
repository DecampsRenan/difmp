import type { RunModel } from "../state/model.js"
import { Empty, Panel } from "./ui.js"

export const RunContext = (props: { readonly model: RunModel }) => {
  const { model } = props
  const config = model.config
  return (
    <Panel title="Contexte du run" testId="context-panel">
      <dl className="kv">
        <div>
          <dt>Cible</dt>
          <dd>{model.baseUrl ?? "—"}</dd>
        </div>
        <div>
          <dt>Fournisseur</dt>
          <dd>{config === undefined ? "—" : `${config.provider}${config.model === undefined ? "" : ` / ${config.model}`}`}</dd>
        </div>
        <div>
          <dt>Captures</dt>
          <dd>
            {model.capture === undefined
              ? "—"
              : `trace ${model.capture.trace} · vidéo ${model.capture.video} · captures ${model.capture.screenshots}`}
          </dd>
        </div>
        <div>
          <dt>Observations</dt>
          <dd>{model.observationCount}</dd>
        </div>
        <div>
          <dt>Empreinte contrat</dt>
          <dd className="mono">{model.contractHash === undefined ? "—" : model.contractHash.slice(0, 16)}</dd>
        </div>
        <div>
          <dt>Version harness</dt>
          <dd>{model.harnessVersion ?? "—"}</dd>
        </div>
      </dl>

      {model.fixture === undefined
        ? <Empty>Aucune fixture — contexte propre ouvert sur la baseUrl.</Empty>
        : (
          <div className="fixture" data-testid="fixture-block">
            <h3>Fixture « {model.fixture.name} »</h3>
            <dl className="kv">
              {Object.entries(model.fixture.publicValues).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
            {model.fixture.cleaned === undefined
              ? null
              : (
                <p className="panel-foot">
                  Nettoyage : {model.fixture.cleaned.cleanupsRun} finaliseur(s)
                  {model.fixture.cleaned.timedOut ? " — délai dépassé" : ""}
                </p>
              )}
          </div>
        )}

      {model.errors.length === 0 ? null : (
        <ul className="errors" data-testid="errors-list">
          {model.errors.map((error) => (
            <li key={error.seq} className={error.fatal ? "fatal" : ""}>
              <strong>{error.stage}</strong> — {error.reason}
              {error.cause === undefined ? null : <span className="cause">{error.cause}</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
