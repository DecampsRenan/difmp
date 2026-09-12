import type { UiRuntimeConfig } from "../runtime/config.js";
import type { ArtifactView, CriterionView } from "../state/model.js";
import { artifactHref } from "../runtime/urls.js";
import { Badge, Empty, Panel, timeOf } from "./ui.js";

const stateTone: Record<string, string> = { present: "ok", missing: "warn", failed: "bad" };

export const Artifacts = (props: {
  readonly artifacts: ReadonlyArray<ArtifactView>;
  readonly criteria: ReadonlyArray<CriterionView>;
  readonly config: UiRuntimeConfig;
}) => {
  const citedBy = new Map<string, Array<string>>();
  for (const criterion of props.criteria) {
    for (const id of criterion.result?.evidence ?? []) {
      const list = citedBy.get(id);
      if (list === undefined) citedBy.set(id, [criterion.id]);
      else list.push(criterion.id);
    }
  }

  return (
    <Panel
      title="Evidence and artifacts"
      testId="artifacts-panel"
      note="An expected artifact that is missing stays listed with its reason: a capture failure is never hidden."
      aside={<span className="count">{props.artifacts.length}</span>}
    >
      {props.artifacts.length === 0 ? (
        <Empty>No artifact recorded.</Empty>
      ) : (
        <table className="artifacts" data-testid="artifacts-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Type</th>
              <th>State</th>
              <th>Time</th>
              <th>Cited by</th>
              <th>Link</th>
            </tr>
          </thead>
          <tbody>
            {props.artifacts.map((artifact) => {
              const href =
                artifact.path === undefined || artifact.state !== "present"
                  ? undefined
                  : artifactHref(props.config.artifactBaseUrl, artifact.path);
              const cited = citedBy.get(artifact.artifactId) ?? [];
              return (
                <tr key={artifact.artifactId} data-testid={`artifact-${artifact.artifactId}`}>
                  <td>
                    <code>{artifact.artifactId}</code>
                  </td>
                  <td>{artifact.kind}</td>
                  <td>
                    <Badge tone={stateTone[artifact.state] ?? "neutral"}>{artifact.state}</Badge>
                    {artifact.reason === undefined ? null : (
                      <span className="reason">{artifact.reason}</span>
                    )}
                  </td>
                  <td className="mono">{timeOf(artifact.ts)}</td>
                  <td>
                    {cited.length === 0
                      ? "—"
                      : cited.map((id) => (
                          <code key={id} className="chip">
                            {id}
                          </code>
                        ))}
                  </td>
                  <td>
                    {href === undefined ? (
                      <span className="muted">
                        {artifact.path === undefined ? "—" : "not servable"}
                      </span>
                    ) : (
                      <a href={href} target="_blank" rel="noreferrer noopener">
                        {artifact.path}
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
};
