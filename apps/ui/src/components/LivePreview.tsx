import type { UiRuntimeConfig } from "../runtime/config.js";
import type { ArtifactView } from "../state/model.js";
import { artifactHref } from "../runtime/urls.js";

/**
 * Real-time preview of the browser under test. The MVP serves the latest present screenshot
 * (design-contracts / spec: continuous screencast is not required); the frame is an iframe so the
 * pane reads as a live viewport rather than a gallery thumbnail.
 */
export const LivePreview = (props: {
  readonly artifacts: ReadonlyArray<ArtifactView>;
  readonly config: UiRuntimeConfig;
  readonly runId?: string;
  readonly specPath?: string;
}) => {
  let latest: ArtifactView | undefined;
  for (const artifact of props.artifacts) {
    if (artifact.kind === "screenshot" && artifact.state === "present") latest = artifact;
  }
  const href =
    latest?.path === undefined
      ? undefined
      : artifactHref(props.config.artifactBaseUrl, latest.path, props.runId);

  return (
    <section className="live-preview" data-testid="live-preview">
      <header className="live-preview-head">
        <h2>Browser</h2>
        <span className="live-preview-meta" data-testid="live-preview-meta">
          {props.specPath ?? "—"}
          {latest === undefined ? "" : ` · ${latest.actionLabel ?? latest.artifactId}`}
        </span>
      </header>
      <div className="live-preview-frame">
        {href === undefined ? (
          <p className="empty" data-testid="live-preview-empty">
            {latest === undefined
              ? "Waiting for the first screenshot…"
              : `Screenshot ${latest.artifactId} recorded, but its path is not servable.`}
          </p>
        ) : (
          <iframe
            className="live-preview-iframe"
            title="Live browser preview"
            src={href}
            sandbox="allow-same-origin"
            data-testid="screenshot-image"
          />
        )}
      </div>
    </section>
  );
};
