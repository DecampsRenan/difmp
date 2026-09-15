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
        reasoning: "I looked at the screenshot carefully.",
        confidence: 0.91,
      });
      expect(verdict.status).toBe("failed");
      expect(verdict.evidence).toEqual(["art_1"]);
      expect(verdict).not.toHaveProperty("reasoning");
      expect(verdict).not.toHaveProperty("confidence");
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
