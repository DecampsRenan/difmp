import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CriterionVerdict, criterionVerdictParseOptions } from "../src/index.js";

const decode = Schema.decodeUnknownEffect(CriterionVerdict, criterionVerdictParseOptions);

describe("CriterionVerdict decode tolerance", () => {
  it.effect("fills omitted nullables and arrays so a sparse model reply still parses", () =>
    Effect.gen(function* () {
      const verdict = yield* decode({
        criterionId: "c1",
        status: "passed",
        observed: "The login form is visible.",
      });
      expect(verdict).toEqual({
        criterionId: "c1",
        status: "passed",
        expected: "",
        observed: "The login form is visible.",
        confidence: null,
        evidence: [],
        limitations: null,
        missingEvidence: [],
        evidenceHint: null,
        absence: null,
      });
    }),
  );

  it.effect("coerces evidence null and a lone string — the OpenCode Go / Qwen failure mode", () =>
    Effect.gen(function* () {
      const fromNull = yield* decode({
        criterionId: "c1",
        status: "passed",
        expected: null,
        observed: "Home rendered.",
        evidence: null,
        missingEvidence: null,
      });
      expect(fromNull.expected).toBe("");
      expect(fromNull.evidence).toEqual([]);
      expect(fromNull.missingEvidence).toEqual([]);

      const fromString = yield* decode({
        criterionId: "c1",
        status: "passed",
        observed: "Home rendered.",
        evidence: "art_1",
        missingEvidence: "need-screenshot",
      });
      expect(fromString.evidence).toEqual(["art_1"]);
      expect(fromString.missingEvidence).toEqual(["need-screenshot"]);
    }),
  );

  it.effect("ignores excess keys a model invents outside the verdict shape", () =>
    Effect.gen(function* () {
      const verdict = yield* decode({
        criterionId: "c1",
        status: "failed",
        expected: "No error banner.",
        observed: "An error banner is present.",
        evidence: ["art_1"],
        limitations: null,
        missingEvidence: [],
        evidenceHint: null,
        absence: null,
        confidence: 0.91,
        reasoning: "I looked at the screenshot carefully.",
      });
      expect(verdict.status).toBe("failed");
      expect(verdict.evidence).toEqual(["art_1"]);
      // Narration is still refused; `confidence` is a known field now, kept as an observation.
      expect(verdict).not.toHaveProperty("reasoning");
      expect(verdict.confidence).toBe(0.91);
    }),
  );

  it.effect("normalises a confidence reported as a percentage", () =>
    Effect.gen(function* () {
      const verdict = yield* decode({
        criterionId: "c1",
        status: "passed",
        observed: "Home rendered.",
        evidence: ["art_1"],
        confidence: 85,
      });
      expect(verdict.confidence).toBe(0.85);
    }),
  );

  it.effect("records an unusable confidence as absent rather than inventing a number", () =>
    Effect.gen(function* () {
      // A weak evaluator answering in words, or not answering at all. Mapping "high" onto 0.9 would
      // manufacture a self-assessment the model never made.
      for (const reported of ["high", "", null, -1, 250, "n/a"]) {
        const verdict = yield* decode({
          criterionId: "c1",
          status: "passed",
          observed: "Home rendered.",
          evidence: ["art_1"],
          confidence: reported,
        });
        expect(verdict.confidence).toBeNull();
      }

      const parsed = yield* decode({
        criterionId: "c1",
        status: "passed",
        observed: "Home rendered.",
        evidence: ["art_1"],
        confidence: "0.72",
      });
      expect(parsed.confidence).toBe(0.72);
    }),
  );

  it.effect("still rejects a reply that omits the required observation", () =>
    Effect.gen(function* () {
      const error = yield* decode({
        criterionId: "c1",
        status: "passed",
      }).pipe(Effect.flip);
      expect(error.message).toContain("observed");
    }),
  );
});
