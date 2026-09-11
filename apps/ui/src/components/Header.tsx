import type { ConnectionState } from "../state/useRunStream.js"
import type { CancelState } from "../state/useRunStream.js"
import type { RunModel } from "../state/model.js"
import { Badge, durationOf, timeOf } from "./ui.js"

const statusTone: Record<string, string> = {
  running: "info",
  passed: "ok",
  failed: "bad",
  inconclusive: "warn",
  error: "bad",
  cancelled: "warn"
}

const connectionLabel: Record<ConnectionState, string> = {
  connecting: "connexion…",
  live: "flux en direct",
  reconnecting: "reconnexion…",
  closed: "flux clos (run terminé)",
  unavailable: "serveur injoignable"
}

const connectionTone: Record<ConnectionState, string> = {
  connecting: "info",
  live: "ok",
  reconnecting: "warn",
  closed: "neutral",
  unavailable: "bad"
}

export const Header = (props: {
  readonly model: RunModel
  readonly connection: ConnectionState
  readonly attempts: number
  readonly cancel: CancelState
  readonly onCancel: () => void
  readonly onReconnect: () => void
  readonly elapsedMs: number
}) => {
  const { model } = props
  const finished = model.status !== "running"
  const cancelDisabled = finished || props.cancel.pending || props.cancel.requested

  return (
    <header className="app-head">
      <div className="head-main">
        <div className="head-title">
          <h1 data-testid="scenario-id">{model.scenarioId ?? "scénario inconnu"}</h1>
          <Badge tone={statusTone[model.status] ?? "neutral"}>
            <span data-testid="run-status">{model.status}</span>
          </Badge>
        </div>
        <p className="head-path" data-testid="spec-path">{model.specPath ?? "—"}</p>
      </div>

      <dl className="head-meta">
        <div>
          <dt>Run</dt>
          <dd data-testid="run-id">{model.runId ?? "—"}</dd>
        </div>
        <div>
          <dt>Tentative</dt>
          <dd data-testid="attempt-id">{model.attemptId ?? "—"}</dd>
        </div>
        <div>
          <dt>Démarré</dt>
          <dd>{model.startedAt === undefined ? "—" : timeOf(model.startedAt)}</dd>
        </div>
        <div>
          <dt>Durée</dt>
          <dd data-testid="elapsed">{durationOf(props.elapsedMs)}</dd>
        </div>
      </dl>

      <div className="head-actions">
        <span className={`conn conn-${connectionTone[props.connection]}`} data-testid="connection-state">
          <i className="dot" aria-hidden="true" />
          {connectionLabel[props.connection]}
        </span>
        <span
          className="stream-stats"
          data-testid="stream-stats"
          data-events-applied={model.applied}
          data-duplicates-dropped={model.duplicates}
          data-malformed-dropped={model.malformed}
          data-last-seq={model.lastSeq}
          data-connect-attempts={props.attempts}
          title="Événements appliqués / doublons ignorés à la reprise / dernier seq"
        >
          {model.applied} évén. · {model.duplicates} doublon(s) ignoré(s) · seq {model.lastSeq}
        </span>
        {props.connection === "unavailable"
          ? (
            <button type="button" className="btn btn-ghost" onClick={props.onReconnect} data-testid="reconnect-button">
              Reprendre le flux
            </button>
          )
          : null}
        <button
          type="button"
          className="btn btn-danger"
          onClick={props.onCancel}
          disabled={cancelDisabled}
          data-testid="cancel-button"
        >
          {props.cancel.pending
            ? "Annulation…"
            : props.cancel.requested
            ? "Annulation demandée"
            : finished
            ? "Run terminé"
            : "Annuler le run"}
        </button>
      </div>

      {props.cancel.error === undefined
        ? null
        : <p className="head-error" data-testid="cancel-error">Annulation impossible : {props.cancel.error}</p>}
    </header>
  )
}
