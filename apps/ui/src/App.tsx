import { useMemo } from "react";
import { Header } from "./components/Header.js";
import { LivePreview } from "./components/LivePreview.js";
import { SuiteTree } from "./components/SuiteTree.js";
import type { SuiteTreeFile } from "./components/SuiteTree.js";
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

  const files = useMemo((): ReadonlyArray<SuiteTreeFile> => {
    if (stream.scenarios.length > 0) {
      return stream.scenarios.map((scenario) => ({
        specPath: scenario.specPath,
        ...(scenario.runId === undefined ? {} : { runId: scenario.runId }),
        status: scenario.status,
        assertions: scenario.assertions,
      }));
    }
    if (model.specPath === undefined && model.runId === undefined) return [];
    return [
      {
        specPath: model.specPath ?? model.runId ?? "run",
        ...(model.runId === undefined ? {} : { runId: model.runId }),
        status: model.status,
        assertions: model.criteria,
      },
    ];
  }, [stream.scenarios, model.specPath, model.runId, model.status, model.criteria]);

  return (
    <div className="app app-simple" data-testid="app" data-run-status={model.status}>
      <Header
        model={model}
        connection={stream.connection}
        attempts={stream.attempts}
        cancel={stream.cancel}
        onCancel={stream.requestCancel}
        onReconnect={stream.reconnectNow}
        elapsedMs={elapsedMs}
        suiteRunning={stream.scenarios.length > 0 && !stream.suiteFinished}
        {...(config.closeUrl === undefined ? {} : { onCloseDashboard: stream.closeDashboard })}
        suiteFinished={stream.suiteFinished}
      />

      <div className="live-layout">
        <SuiteTree
          files={files}
          {...(model.runId === undefined ? {} : { selectedRunId: model.runId })}
          onSelect={stream.selectScenario}
        />
        <LivePreview
          artifacts={model.artifacts}
          config={config}
          {...(model.runId === undefined ? {} : { runId: model.runId })}
          {...(model.specPath === undefined ? {} : { specPath: model.specPath })}
        />
      </div>
    </div>
  );
};
