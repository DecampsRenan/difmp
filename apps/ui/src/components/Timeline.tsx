import { useMemo, useState } from "react"
import type { TimelineEntry, TimelineKind } from "../state/model.js"
import { Empty, Panel, durationOf, timeOf } from "./ui.js"

const kindLabel: Record<TimelineKind, string> = {
  lifecycle: "cycle de vie",
  action: "action",
  observation: "observation",
  model: "modèle",
  verification: "vérification",
  evidence: "preuve",
  artifact: "artefact",
  guidance: "indication",
  budget: "budget",
  error: "erreur"
}

const FILTERS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly kinds: ReadonlyArray<TimelineKind> }> = [
  { id: "all", label: "tout", kinds: [] },
  { id: "actions", label: "actions", kinds: ["action"] },
  { id: "observations", label: "observations", kinds: ["observation"] },
  { id: "verifications", label: "vérifications", kinds: ["verification", "evidence"] },
  { id: "problems", label: "erreurs & budgets", kinds: ["error", "budget", "guidance"] }
]

export const Timeline = (props: { readonly entries: ReadonlyArray<TimelineEntry> }) => {
  const [filter, setFilter] = useState("all")
  const [newestFirst, setNewestFirst] = useState(true)

  const visible = useMemo(() => {
    const selected = FILTERS.find((f) => f.id === filter)
    const filtered = selected === undefined || selected.kinds.length === 0
      ? props.entries
      : props.entries.filter((entry) => selected.kinds.includes(entry.kind))
    return newestFirst ? [...filtered].reverse() : filtered
  }, [props.entries, filter, newestFirst])

  return (
    <Panel
      title="Timeline"
      testId="timeline-panel"
      aside={
        <div className="timeline-controls">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`chip-btn${filter === f.id ? " is-active" : ""}`}
              onClick={() => setFilter(f.id)}
              data-testid={`timeline-filter-${f.id}`}
            >
              {f.label}
            </button>
          ))}
          <button
            type="button"
            className="chip-btn"
            onClick={() => setNewestFirst((v) => !v)}
            data-testid="timeline-order"
          >
            {newestFirst ? "récent → ancien" : "ancien → récent"}
          </button>
        </div>
      }
    >
      {visible.length === 0
        ? <Empty>Rien à afficher pour ce filtre.</Empty>
        : (
          <ol className="timeline" data-testid="timeline-list">
            {visible.map((entry) => (
              <li
                key={entry.seq}
                className={`tl tl-${entry.kind} tone-${entry.tone}`}
                data-testid="timeline-entry"
                data-seq={entry.seq}
                data-kind={entry.kind}
              >
                <span className="tl-seq">#{entry.seq}</span>
                <span className="tl-time mono">{timeOf(entry.ts)}</span>
                <span className="tl-kind">{kindLabel[entry.kind]}</span>
                <span className="tl-body">
                  <span className="tl-label">{entry.label}</span>
                  {entry.detail === undefined ? null : <span className="tl-detail">{entry.detail}</span>}
                  {entry.outcome === undefined
                    ? entry.kind === "action" ? <span className="tl-outcome pending">en cours…</span> : null
                    : <span className="tl-outcome">{entry.outcome}</span>}
                </span>
                <span className="tl-dur mono">
                  {entry.durationMs === undefined ? "" : durationOf(entry.durationMs)}
                </span>
              </li>
            ))}
          </ol>
        )}
    </Panel>
  )
}
