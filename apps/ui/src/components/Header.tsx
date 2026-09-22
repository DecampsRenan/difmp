import type { ConnectionState, CancelState } from "../state/useRunStream.js";
import type { RunModel } from "../state/model.js";
import { liveStatusFromRun, liveStatusTone } from "../state/liveStatus.js";
import { Badge } from "./ui.js";

const connectionLabel: Record<ConnectionState, string> = {
  connecting: "connecting…",
  live: "live",
  reconnecting: "reconnecting…",
  closed: "finished",
  unavailable: "unreachable",
};

const connectionTone: Record<ConnectionState, string> = {
  connecting: "info",
  live: "ok",
  reconnecting: "warn",
  closed: "neutral",
  unavailable: "bad",
};

/**
 * Minimal chrome for the simplified live view: brand, connection, cancel / close.
 * Run metadata and stream counters were removed — they can return later without cluttering
 * the first paint.
 */
export const Header = (props: {
  readonly model: RunModel;
  readonly connection: ConnectionState;
  readonly attempts: number;
  readonly cancel: CancelState;
  readonly onCancel: () => void;
  readonly onReconnect: () => void;
  readonly elapsedMs: number;
  readonly suiteRunning?: boolean;
  readonly suiteFinished?: boolean;
  readonly onCloseDashboard?: () => void;
}) => {
  const { model } = props;
  const finished = model.status !== "running";
  const cancelDisabled =
    (finished && props.suiteRunning !== true) || props.cancel.pending || props.cancel.requested;
  const live = liveStatusFromRun(model.status);

  return (
    <header className="app-head app-head-simple" data-testid="app-head">
      <div className="head-main">
        <div className="head-title">
          <h1>difmp</h1>
          <Badge tone={liveStatusTone(live)}>
            <span data-testid="run-status">{live}</span>
          </Badge>
          {/* Keep the domain scenario id for tests / grepping without crowding the title. */}
          <span className="head-scenario" data-testid="scenario-id">
            {model.scenarioId ?? "—"}
          </span>
        </div>
        <p className="head-path" data-testid="spec-path">
          {model.specPath ?? "Waiting for a run…"}
        </p>
      </div>

      {/* Hidden stream stats for existing tests / debugging without visual chrome. */}
      <span
        className="stream-stats stream-stats-hidden"
        data-testid="stream-stats"
        data-events-applied={model.applied}
        data-duplicates-dropped={model.duplicates}
        data-malformed-dropped={model.malformed}
        data-last-seq={model.lastSeq}
        data-connect-attempts={props.attempts}
        hidden
      />
      <span data-testid="run-id" hidden>
        {model.runId ?? "—"}
      </span>
      <span data-testid="attempt-id" hidden>
        {model.attemptId ?? "—"}
      </span>
      <span data-testid="elapsed" hidden>
        {props.elapsedMs}
      </span>

      <div className="head-actions">
        <span
          className={`conn conn-${connectionTone[props.connection]}`}
          data-testid="connection-state"
        >
          <i className="dot" aria-hidden="true" />
          {connectionLabel[props.connection]}
        </span>
        {props.connection === "unavailable" ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={props.onReconnect}
            data-testid="reconnect-button"
          >
            Resume
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
              : finished && props.suiteRunning !== true
                ? "Run finished"
                : props.suiteRunning === true
                  ? "Cancel suite"
                  : "Cancel"}
        </button>
        {props.suiteFinished === true && props.onCloseDashboard !== undefined ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={props.onCloseDashboard}
            data-testid="close-dashboard-button"
          >
            Close
          </button>
        ) : null}
      </div>

      {props.cancel.error === undefined ? null : (
        <p className="head-error" data-testid="cancel-error">
          Cancellation failed: {props.cancel.error}
        </p>
      )}
    </header>
  );
};
