import type { ConnectionState } from "../state/useRunStream.js";
import type { CancelState } from "../state/useRunStream.js";
import type { RunModel } from "../state/model.js";
import { Badge, durationOf, timeOf } from "./ui.js";

const statusTone: Record<string, string> = {
  running: "info",
  passed: "ok",
  failed: "bad",
  inconclusive: "warn",
  error: "bad",
  cancelled: "warn",
};

const connectionLabel: Record<ConnectionState, string> = {
  connecting: "connecting…",
  live: "live stream",
  reconnecting: "reconnecting…",
  closed: "stream closed (run finished)",
  unavailable: "server unreachable",
};

const connectionTone: Record<ConnectionState, string> = {
  connecting: "info",
  live: "ok",
  reconnecting: "warn",
  closed: "neutral",
  unavailable: "bad",
};

export const Header = (props: {
  readonly model: RunModel;
  readonly connection: ConnectionState;
  readonly attempts: number;
  readonly cancel: CancelState;
  readonly onCancel: () => void;
  readonly onReconnect: () => void;
  readonly elapsedMs: number;
}) => {
  const { model } = props;
  const finished = model.status !== "running";
  const cancelDisabled = finished || props.cancel.pending || props.cancel.requested;

  return (
    <header className="app-head">
      <div className="head-main">
        <div className="head-title">
          <h1 data-testid="scenario-id">{model.scenarioId ?? "unknown scenario"}</h1>
          <Badge tone={statusTone[model.status] ?? "neutral"}>
            <span data-testid="run-status">{model.status}</span>
          </Badge>
        </div>
        <p className="head-path" data-testid="spec-path">
          {model.specPath ?? "—"}
        </p>
      </div>

      <dl className="head-meta">
        <div>
          <dt>Run</dt>
          <dd data-testid="run-id">{model.runId ?? "—"}</dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd data-testid="attempt-id">{model.attemptId ?? "—"}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{model.startedAt === undefined ? "—" : timeOf(model.startedAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd data-testid="elapsed">{durationOf(props.elapsedMs)}</dd>
        </div>
      </dl>

      <div className="head-actions">
        <span
          className={`conn conn-${connectionTone[props.connection]}`}
          data-testid="connection-state"
        >
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
          title="Events applied / duplicates dropped on resume / last seq"
        >
          {model.applied} event(s) · {model.duplicates} duplicate(s) dropped · seq {model.lastSeq}
        </span>
        {props.connection === "unavailable" ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={props.onReconnect}
            data-testid="reconnect-button"
          >
            Resume the stream
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-danger"
          onClick={props.onCancel}
          disabled={cancelDisabled}
          data-testid="cancel-button"
        >
          {props.cancel.pending
            ? "Cancelling…"
            : props.cancel.requested
              ? "Cancellation requested"
              : finished
                ? "Run finished"
                : "Cancel the run"}
        </button>
      </div>

      {props.cancel.error === undefined ? null : (
        <p className="head-error" data-testid="cancel-error">
          Cancellation failed: {props.cancel.error}
        </p>
      )}
    </header>
  );
};
