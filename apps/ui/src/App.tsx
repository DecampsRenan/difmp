import { useMemo } from "react";
import { Artifacts } from "./components/Artifacts.js";
import { ActionGuidance, BlockingBudgets } from "./components/Budgets.js";
import { Criteria } from "./components/Criteria.js";
import { Header } from "./components/Header.js";
import { RunContext } from "./components/RunContext.js";
import { LatestScreenshot } from "./components/Screenshot.js";
import { Timeline } from "./components/Timeline.js";
import { readRuntimeConfig } from "./runtime/config.js";
import { useNow, useRunStream } from "./state/useRunStream.js";

export const App = () => {
  const config = useMemo(() => readRuntimeConfig(), []);
  const stream = useRunStream(config);
  const model = stream.model;
  const running = model.status === "running";
  const now = useNow(running);

  const elapsedMs = useMemo(() => {
    if (model.startedAt === undefined) return 0;
    const start = new Date(model.startedAt).getTime();
    if (Number.isNaN(start)) return 0;
    const end =
      model.finishedAt === undefined
        ? now
        : (() => {
            const parsed = new Date(model.finishedAt).getTime();
            return Number.isNaN(parsed) ? now : parsed;
          })();
    return Math.max(end - start, 0);
  }, [model.startedAt, model.finishedAt, now]);

  return (
    <div className="app" data-testid="app" data-run-status={model.status}>
      <Header
        model={model}
        connection={stream.connection}
        attempts={stream.attempts}
        cancel={stream.cancel}
        onCancel={stream.requestCancel}
        onReconnect={stream.reconnectNow}
        elapsedMs={elapsedMs}
      />

      <main className="grid">
        <div className="col col-left">
          <Criteria criteria={model.criteria} />
          <BlockingBudgets model={model} pricing={config.pricing} elapsedMs={elapsedMs} />
          <ActionGuidance model={model} />
          <RunContext model={model} />
        </div>
        <div className="col col-right">
          <LatestScreenshot artifacts={model.artifacts} config={config} />
          <Timeline entries={model.timeline} />
          <Artifacts artifacts={model.artifacts} criteria={model.criteria} config={config} />
        </div>
      </main>

      <footer className="app-foot">
        Everything coming from the scenario, the model, the pages and the journals is rendered as
        text. The MVP offers no manual takeover of the browser.
      </footer>
    </div>
  );
};
