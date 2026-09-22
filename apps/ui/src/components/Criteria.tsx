import type { CriterionStatus, Evaluator } from "../types/events.js";
import type { CriterionView } from "../state/model.js";
import { Badge, Empty, Panel } from "./ui.js";

const statusTone: Record<CriterionStatus, string> = {
  pending: "neutral",
  passed: "ok",
  failed: "bad",
  inconclusive: "warn",
  error: "bad",
};

const statusLabel: Record<CriterionStatus, string> = {
  pending: "pending",
  passed: "passed",
  failed: "failed",
  inconclusive: "inconclusive",
  error: "error",
};

/**
 * A criterion's status is copied verbatim from the `verificationFinished` payload, and
 * `isHarnessEvent` gates the ENVELOPE only — it never decodes the result. So a status outside the
 * union does reach this component, and indexing the maps above with it yields `undefined`: the
 * badge would render `badge-undefined`, i.e. no tone at all, on the one element the whole panel
 * relies on to say pass from fail. The `Record<CriterionStatus, …>` keeps the compiler honest when
 * a status is ADDED to the domain; these lookups stay defensive because the wire is not the domain.
 * Same shape as `Header.tsx` and `Artifacts.tsx`.
 */
const toneOf = (status: string): string => statusTone[status as CriterionStatus] ?? "neutral";
const labelOf = (status: string): string => statusLabel[status as CriterionStatus] ?? status;

const evaluatorLabel = (evaluator: Evaluator): string => {
  switch (evaluator.kind) {
    case "model": {
      const confidence =
        evaluator.confidence === undefined
          ? ""
          : ` · confidence ${evaluator.confidence.toFixed(2)}${
              evaluator.confidenceFrom === undefined ? "" : ` (${evaluator.confidenceFrom})`
            }`;
      return `model ${evaluator.provider}/${evaluator.model}${confidence}`;
    }
    case "scripted-model":
      // Never present a deterministic double as a real model judgement (design-contracts §8).
      return "scripted double (not a model judgement)";
    case "code":
      return `TS check "${evaluator.checkName}"`;
  }
};

const absenceLabel: Record<string, string> = {
  "uncertain-navigation": "absence after uncertain navigation → inconclusive",
  "established-at-checkpoint": "absence established at the checkpoint → failed",
};

export const Criteria = (props: { readonly criteria: ReadonlyArray<CriterionView> }) => (
  <Panel
    title="Success criteria"
    testId="criteria-panel"
    aside={<span className="count">{props.criteria.length}</span>}
  >
    {props.criteria.length === 0 ? (
      <Empty>The contract is not frozen yet.</Empty>
    ) : (
      <ul className="criteria" data-testid="criteria-list">
        {props.criteria.map((criterion) => {
          const result = criterion.result;
          return (
            <li key={criterion.id} className="criterion" data-testid={`criterion-${criterion.id}`}>
              <div className="criterion-head">
                <code className="criterion-id">{criterion.id}</code>
                <Badge tone={toneOf(criterion.status)} title={labelOf(criterion.status)}>
                  {/* The domain literal, not a translation: it is what `result.json`, `junit.xml`
                        and the console reporter print, so it stays greppable across artifacts. */}
                  <span data-testid={`criterion-status-${criterion.id}`}>{criterion.status}</span>
                </Badge>
                <span
                  className={`method method-${criterion.method ?? "unknown"}`}
                  data-testid={`criterion-method-${criterion.id}`}
                  title={
                    criterion.method === "code"
                      ? "Evaluated by a deterministic TypeScript check"
                      : criterion.method === "model"
                        ? "Evaluated by the model from the evidence"
                        : "Method still unknown (contract not loaded)"
                  }
                >
                  {criterion.method === "code"
                    ? `code${criterion.checkName === undefined ? "" : ` · ${criterion.checkName}`}`
                    : criterion.method === "model"
                      ? "model"
                      : "unknown method"}
                </span>
              </div>

              <p className="criterion-text">{criterion.text ?? "(criterion text unavailable)"}</p>

              {/* Gated on `pending`, not on the absence of a result alone: `runFinished` turns a
                  still-pending criterion into `inconclusive` while leaving `result` undefined and
                  `evidenceRequested` true (reducer.ts, `runFinished`). Without the status check the
                  panel contradicts itself on every unfinished run — the badge says "inconclusive"
                  and the line under it says the evaluation is still running. */}
              {criterion.evidenceRequested && result === undefined ? (
                criterion.status === "pending" ? (
                  <p className="criterion-meta">Evidence requested, evaluation in progress…</p>
                ) : (
                  <p
                    className="criterion-meta"
                    data-testid={`criterion-unresolved-${criterion.id}`}
                  >
                    Evidence was requested, but the run ended before any verdict was recorded.
                  </p>
                )
              ) : null}

              {result === undefined ? null : (
                <dl className="criterion-result">
                  <div>
                    <dt>Expected</dt>
                    <dd>{result.expected}</dd>
                  </div>
                  <div>
                    <dt>Observed</dt>
                    <dd>{result.observed}</dd>
                  </div>
                  <div>
                    <dt>Evaluator</dt>
                    <dd>{evaluatorLabel(result.evaluator)}</dd>
                  </div>
                  {result.absence === undefined ? null : (
                    <div>
                      <dt>Absence rule</dt>
                      <dd>{absenceLabel[result.absence] ?? result.absence}</dd>
                    </div>
                  )}
                  {result.limitations === undefined ? null : (
                    <div>
                      <dt>Limitations</dt>
                      <dd>{result.limitations}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Evidence</dt>
                    <dd>
                      {result.evidence.length === 0
                        ? "none"
                        : result.evidence.map((id) => (
                            <code key={id} className="chip">
                              {id}
                            </code>
                          ))}
                    </dd>
                  </div>
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    )}
  </Panel>
);
