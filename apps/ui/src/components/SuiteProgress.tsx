import type { SuiteScenario } from "../state/useRunStream.js";
import { Badge, Panel } from "./ui.js";

const tone: Record<SuiteScenario["status"], string> = {
  pending: "neutral",
  running: "info",
  passed: "ok",
  failed: "bad",
  inconclusive: "warn",
  error: "bad",
  cancelled: "warn",
};

export const SuiteProgress = (props: {
  readonly scenarios: ReadonlyArray<SuiteScenario>;
  readonly selectedRunId?: string;
  readonly completed: number;
  readonly total: number;
  readonly onSelect: (runId: string) => void;
}) => {
  if (props.scenarios.length === 0) return null;
  return (
    <section className="suite" data-testid="suite-progress">
      <Panel
        title="Suite progress"
        testId="suite-panel"
        aside={
          <span className="count" data-testid="suite-counts">
            {props.completed}/{props.total} complete
          </span>
        }
      >
        <ol className="suite-list">
          {props.scenarios.map((scenario) => {
            const selected = scenario.runId !== undefined && scenario.runId === props.selectedRunId;
            return (
              <li key={`${scenario.specPath}:${scenario.runId ?? "pending"}`}>
                <button
                  type="button"
                  className={`suite-row${selected ? " suite-row-selected" : ""}`}
                  disabled={scenario.runId === undefined}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => {
                    if (scenario.runId !== undefined) props.onSelect(scenario.runId);
                  }}
                  data-testid={`suite-scenario-${scenario.specPath}`}
                >
                  <Badge tone={tone[scenario.status]}>{scenario.status}</Badge>
                  <span>{scenario.specPath}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </Panel>
    </section>
  );
};
