import type { UiRuntimeConfig } from "../runtime/config.js"
import type { ArtifactView } from "../state/model.js"
import { artifactHref } from "../runtime/urls.js"
import { Empty, Panel, timeOf } from "./ui.js"

export const LatestScreenshot = (props: {
  readonly artifacts: ReadonlyArray<ArtifactView>
  readonly config: UiRuntimeConfig
}) => {
  let latest: ArtifactView | undefined
  for (const artifact of props.artifacts) {
    if (artifact.kind === "screenshot" && artifact.state === "present") latest = artifact
  }
  const href = latest?.path === undefined ? undefined : artifactHref(props.config.artifactBaseUrl, latest.path)

  return (
    <Panel title="Dernière capture" testId="screenshot-panel">
      {latest === undefined
        ? <Empty>Aucune capture disponible pour l'instant.</Empty>
        : (
          <figure className="shot">
            {href === undefined
              ? (
                <p className="empty" data-testid="screenshot-unavailable">
                  Capture {latest.artifactId} enregistrée mais son chemin n'est pas servable.
                </p>
              )
              : (
                // `src` comes from the run journal: artifactHref() rejects anything that is not a
                // relative path resolving to http(s) under the artifact base.
                <img src={href} alt={`Capture ${latest.artifactId}`} data-testid="screenshot-image" />
              )}
            <figcaption>
              <span data-testid="screenshot-ts">{timeOf(latest.ts)}</span>
              <span className="sep">·</span>
              <span data-testid="screenshot-action">
                {latest.actionLabel ?? "action inconnue"}
              </span>
              <span className="sep">·</span>
              <code>{latest.artifactId}</code>
            </figcaption>
          </figure>
        )}
    </Panel>
  )
}
