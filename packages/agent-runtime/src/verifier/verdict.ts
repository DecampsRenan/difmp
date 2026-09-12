import { Schema } from "effect";

/**
 * The evaluator's structured answer. Optional information is modelled as explicitly nullable rather
 * than absent: the Anthropic structured-output rewriter turns optional properties into
 * required-nullable ones anyway, so being explicit keeps the JSON Schema and the decode symmetric.
 *
 * There is deliberately no `confidence` and no free-form reasoning field. The evaluator states what
 * it expected, what it observed, and which artifacts it read — nothing else is admissible.
 */
export const CriterionVerdict = Schema.Struct({
  /** Must equal the criterion under evaluation; a mismatch forces `inconclusive`. */
  criterionId: Schema.String,
  status: Schema.Literals(["passed", "failed", "inconclusive"]),
  /** Restatement of the frozen expectation. The evaluator may not rewrite it. */
  expected: Schema.String,
  observed: Schema.String,
  /** artifactIds actually read. Every one is checked against the attempt's evidence. */
  evidence: Schema.Array(Schema.String),
  limitations: Schema.NullOr(Schema.String),
  /** Non-empty when the evidence on hand cannot settle the criterion. */
  missingEvidence: Schema.Array(Schema.String),
  /** What the runner could capture next. It never changes the expectation. */
  evidenceHint: Schema.NullOr(Schema.String),
  /** Which branch of the absence rule was taken, when the criterion is about something missing. */
  absence: Schema.NullOr(Schema.Literals(["uncertain-navigation", "established-at-checkpoint"])),
}).annotate({ identifier: "CriterionVerdict" });

export type CriterionVerdictShape = {
  readonly criterionId: string;
  readonly status: "passed" | "failed" | "inconclusive";
  readonly expected: string;
  readonly observed: string;
  readonly evidence: ReadonlyArray<string>;
  readonly limitations: string | null;
  readonly missingEvidence: ReadonlyArray<string>;
  readonly evidenceHint: string | null;
  readonly absence: "uncertain-navigation" | "established-at-checkpoint" | null;
};

/**
 * A machine-readable marker placed in the verifier prompt. The scripted double reads it to pick its
 * canned answer; a real model simply echoes the id back in `criterionId`.
 */
export const criterionMarker = (criterionId: string): string => `criterion_id: ${criterionId}`;

export const readCriterionMarker = (text: string): string | undefined =>
  /criterion_id:\s*(c[1-9][0-9]*)/.exec(text)?.[1];
