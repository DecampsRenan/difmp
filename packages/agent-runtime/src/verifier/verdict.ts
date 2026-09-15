import { Effect, Schema } from "effect";

const emptyStrings = Effect.succeed<ReadonlyArray<string>>([]);
const nullString = Effect.succeed<string | null>(null);
const nullAbsence = Effect.succeed<"uncertain-navigation" | "established-at-checkpoint" | null>(
  null,
);

/**
 * The evaluator's structured answer. Optional information is modelled as explicitly nullable rather
 * than absent: the Anthropic structured-output rewriter turns optional properties into
 * required-nullable ones anyway, so being explicit keeps the JSON Schema and the decode symmetric.
 *
 * Decoding defaults fill keys a weaker model omits (`null` / `[]` / empty `expected`). That is a
 * transport tolerance only — harness authority rules (evidence citations, absence, …) still apply
 * after a successful decode. `observed`, `criterionId` and `status` stay required.
 *
 * There is deliberately no `confidence` and no free-form reasoning field. The evaluator states what
 * it expected, what it observed, and which artifacts it read — nothing else is admissible.
 */
export const CriterionVerdict = Schema.Struct({
  /** Must equal the criterion under evaluation; a mismatch forces `inconclusive`. */
  criterionId: Schema.String,
  status: Schema.Literals(["passed", "failed", "inconclusive"]),
  /**
   * Restatement of the frozen expectation. The evaluator may not rewrite it; the harness replaces
   * this with the contract text after decode. Defaulted so a sparse model reply still parses.
   */
  expected: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  observed: Schema.String,
  /** artifactIds actually read. Every one is checked against the attempt's evidence. */
  evidence: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(emptyStrings)),
  limitations: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(nullString)),
  /** Non-empty when the evidence on hand cannot settle the criterion. */
  missingEvidence: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(emptyStrings)),
  /** What the runner could capture next. It never changes the expectation. */
  evidenceHint: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(nullString)),
  /** Which branch of the absence rule was taken, when the criterion is about something missing. */
  absence: Schema.NullOr(
    Schema.Literals(["uncertain-navigation", "established-at-checkpoint"]),
  ).pipe(Schema.withDecodingDefaultKey(nullAbsence)),
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
 * Decode options for an evaluator reply: unknown keys are ignored (models often add narration
 * fields), but every issue on known fields is still reported.
 */
export const criterionVerdictParseOptions = {
  errors: "all" as const,
  onExcessProperty: "ignore" as const,
  reportInput: true as const,
};

/**
 * A machine-readable marker placed in the verifier prompt. The scripted double reads it to pick its
 * canned answer; a real model simply echoes the id back in `criterionId`.
 */
export const criterionMarker = (criterionId: string): string => `criterion_id: ${criterionId}`;

export const readCriterionMarker = (text: string): string | undefined =>
  /criterion_id:\s*(c[1-9][0-9]*)/.exec(text)?.[1];
