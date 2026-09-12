import type { ReactNode } from "react"

export const Panel = (props: {
  readonly title: string
  readonly testId: string
  readonly note?: string
  readonly aside?: ReactNode
  readonly children: ReactNode
}) => (
  <section className="panel" data-testid={props.testId}>
    <header className="panel-head">
      <h2>{props.title}</h2>
      {props.aside}
    </header>
    {props.note === undefined ? null : <p className="panel-note">{props.note}</p>}
    <div className="panel-body">{props.children}</div>
  </section>
)

export const Badge = (props: { readonly tone: string; readonly children: ReactNode; readonly title?: string }) => (
  <span className={`badge badge-${props.tone}`} title={props.title}>{props.children}</span>
)

/**
 * A consumed/limit gauge. `kind` drives the visual language and is NOT cosmetic: `blocking` bars are
 * the ones that can end a run, `indicative` bars never are (design-contracts §7).
 */
export const Gauge = (props: {
  readonly label: string
  readonly used: number
  readonly limit: number
  readonly kind: "blocking" | "indicative"
  readonly exhausted?: boolean
  readonly testId?: string
  readonly footnote?: string
  /** How a raw number is rendered. Defaults to a grouped integer. */
  readonly format?: (n: number) => string
}) => {
  const ratio = props.limit > 0 ? Math.min(props.used / props.limit, 1) : 0
  const remaining = Math.max(props.limit - props.used, 0)
  const over = props.used > props.limit
  const fmt = props.format ?? ((n: number) => n.toLocaleString("en-US"))
  return (
    <div className={`gauge gauge-${props.kind}`} data-testid={props.testId}>
      <div className="gauge-line">
        <span className="gauge-label">{props.label}</span>
        <span className="gauge-value">{fmt(props.used)} / {fmt(props.limit)}</span>
      </div>
      <div className={`gauge-track${props.exhausted === true ? " is-exhausted" : ""}${over ? " is-over" : ""}`}>
        <div className="gauge-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <div className="gauge-line gauge-sub">
        <span>
          {props.kind === "blocking"
            ? `${fmt(remaining)} left`
            : over
            ? `${fmt(props.used - props.limit)} past the threshold`
            : `${fmt(remaining)} before the threshold`}
        </span>
        {props.footnote === undefined ? null : <span className="gauge-foot">{props.footnote}</span>}
      </div>
    </div>
  )
}

export const Empty = (props: { readonly children: ReactNode }) => <p className="empty">{props.children}</p>

export const timeOf = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleTimeString("en-GB", { hour12: false }) +
    `.${String(date.getMilliseconds()).padStart(3, "0")}`
}

export const durationOf = (ms: number): string =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
