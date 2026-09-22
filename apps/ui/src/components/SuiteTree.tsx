import { useState } from "react";
import type { LiveStatus } from "../state/liveStatus.js";
import { liveStatusFromCriterion, liveStatusFromRun, liveStatusTone } from "../state/liveStatus.js";
import type { CriterionView } from "../state/model.js";
import type { SuiteScenario } from "../state/useRunStream.js";
import { Badge } from "./ui.js";

export interface SuiteTreeFile {
  readonly specPath: string;
  readonly runId?: string;
  readonly status: SuiteScenario["status"];
  readonly assertions: ReadonlyArray<CriterionView>;
}

const fileLabel = (specPath: string): string => {
  const slash = Math.max(specPath.lastIndexOf("/"), specPath.lastIndexOf("\\"));
  return slash === -1 ? specPath : specPath.slice(slash + 1);
};

const StatusBadge = (props: { readonly status: LiveStatus; readonly testId?: string }) => (
  <Badge tone={liveStatusTone(props.status)} title={props.status}>
    <span {...(props.testId === undefined ? {} : { "data-testid": props.testId })}>
      {props.status}
    </span>
  </Badge>
);

export const SuiteTree = (props: {
  readonly files: ReadonlyArray<SuiteTreeFile>;
  readonly selectedRunId?: string;
  readonly onSelect: (runId: string) => void;
}) => {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  if (props.files.length === 0) {
    return (
      <aside className="suite-tree" data-testid="suite-tree">
        <p className="empty" data-testid="suite-tree-empty">
          Waiting for scenarios…
        </p>
      </aside>
    );
  }

  return (
    <aside className="suite-tree" data-testid="suite-tree">
      <ul className="suite-tree-files">
        {props.files.map((file) => {
          const open = !collapsed.has(file.specPath);
          const fileStatus = liveStatusFromRun(file.status);
          const selected = file.runId !== undefined && file.runId === props.selectedRunId;
          return (
            <li
              key={file.specPath}
              className={`suite-tree-file${selected ? " suite-tree-file-selected" : ""}`}
              data-testid={`suite-file-${file.specPath}`}
            >
              <div className="suite-tree-file-row">
                <button
                  type="button"
                  className="suite-tree-toggle"
                  aria-expanded={open}
                  aria-label={open ? `Collapse ${file.specPath}` : `Expand ${file.specPath}`}
                  data-testid={`suite-file-toggle-${file.specPath}`}
                  onClick={() => {
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(file.specPath)) next.delete(file.specPath);
                      else next.add(file.specPath);
                      return next;
                    });
                  }}
                >
                  {open ? "▾" : "▸"}
                </button>
                <button
                  type="button"
                  className="suite-tree-file-btn"
                  disabled={file.runId === undefined}
                  aria-current={selected ? "true" : undefined}
                  title={file.specPath}
                  data-testid={`suite-scenario-${file.specPath}`}
                  onClick={() => {
                    if (file.runId !== undefined) props.onSelect(file.runId);
                  }}
                >
                  <span className="suite-tree-file-name">{fileLabel(file.specPath)}</span>
                  <StatusBadge status={fileStatus} testId={`suite-file-status-${file.specPath}`} />
                </button>
              </div>
              {open ? (
                <ul className="suite-tree-assertions">
                  {file.assertions.length === 0 ? (
                    <li className="suite-tree-assertion suite-tree-assertion-empty">
                      <span className="empty">No assertions yet</span>
                    </li>
                  ) : (
                    file.assertions.map((assertion) => {
                      const status = liveStatusFromCriterion(assertion);
                      return (
                        <li
                          key={assertion.id}
                          className="suite-tree-assertion"
                          data-testid={`suite-assertion-${file.specPath}-${assertion.id}`}
                        >
                          <code className="suite-tree-assertion-id">{assertion.id}</code>
                          <span className="suite-tree-assertion-text" title={assertion.text}>
                            {assertion.text ?? assertion.id}
                          </span>
                          <StatusBadge
                            status={status}
                            testId={`criterion-status-${assertion.id}`}
                          />
                        </li>
                      );
                    })
                  )}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </aside>
  );
};
