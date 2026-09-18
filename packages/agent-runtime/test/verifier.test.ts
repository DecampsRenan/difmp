import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import type { GenerateRequest, VerificationRequest } from "@difmp/core";
import { ModelProvider } from "@difmp/core";
import { Effect, Layer } from "effect";
import { makeVerifier } from "../src/index.js";

const request = (evidence: VerificationRequest["evidence"]): VerificationRequest => ({
  attemptId: "a1",
  criterion: {
    id: "c1",
    text: "The heading does not overlap the button.",
    sourceText: "The heading does not overlap the button.",
    line: 1,
    column: 1,
    method: "model",
  },
  criterionHash: "a".repeat(64),
  evidence,
  scenario: { id: "visual", body: "Inspect the page", inputs: {}, fixturePublic: {} },
  baseUrl: "http://127.0.0.1:3000",
  seq: 7,
});

describe("multimodal verifier", () => {
  it.effect(
    "attaches screenshot pixels and excludes screenshots whose pixels are unavailable",
    () => {
      const seen: Array<GenerateRequest> = [];
      const pixels = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
      const provider = Layer.succeed(
        ModelProvider,
        ModelProvider.of({
          id: "vision-provider",
          modelId: "vision-v1",
          generate: (input) =>
            Effect.sync(() => {
              seen.push(input);
              return {
                toolCalls: [],
                object: {
                  criterionId: "c1",
                  status: "passed",
                  expected: "The heading does not overlap the button.",
                  observed: "The attached screenshot shows separate bounds.",
                  // Deliberately cite both: art_2 has a label but no pixels and must be rejected.
                  evidence: ["art_1", "art_2"],
                  limitations: null,
                  missingEvidence: [],
                  evidenceHint: null,
                  absence: null,
                },
              };
            }),
        }),
      );
      return Effect.gen(function* () {
        const verifier = yield* makeVerifier();
        const response = yield* verifier.verify(
          request([
            {
              artifactId: "art_1",
              kind: "screenshot",
              capturedAt: "2026-09-12T12:00:00.000Z",
              summary: 'screenshot "checkpoint-c1"',
              image: { mediaType: "image/png", data: pixels },
            },
            {
              artifactId: "art_2",
              kind: "screenshot",
              capturedAt: "2026-09-12T12:00:01.000Z",
              summary: 'screenshot "missing-pixels"',
            },
          ]),
        );

        expect(response.outcome._tag).toBe("verdict");
        if (response.outcome._tag === "verdict") {
          expect(response.outcome.result.status).toBe("inconclusive");
          expect(response.outcome.result.evidence).toEqual(["art_1"]);
          expect(response.outcome.result.limitations).toContain("art_2");
        }
        expect(seen).toHaveLength(1);
        const input = seen[0]!;
        expect(input.role).toBe("verifier");
        const user = input.prompt.messages.find((message) => message.role === "user")!;
        const text = user.parts
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        expect(text).toContain("art_1");
        expect(text).not.toContain("art_2");
        expect(user.parts).toContainEqual({
          type: "image",
          mediaType: "image/png",
          data: pixels,
          fileName: "art_1.png",
        });
      }).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, provider)));
    },
  );
});

describe("declared confidence", () => {
  it.effect("is recorded but buys the verdict nothing", () => {
    const seen: Array<GenerateRequest> = [];
    const provider = Layer.succeed(
      ModelProvider,
      ModelProvider.of({
        id: "confident-provider",
        modelId: "confident-v1",
        generate: (input) =>
          Effect.sync(() => {
            seen.push(input);
            return {
              toolCalls: [],
              object: {
                criterionId: "c1",
                status: "passed",
                expected: "The heading does not overlap the button.",
                observed: "They are clearly apart.",
                // Maximal self-assessment, citing an artifact that does not exist in the attempt.
                confidence: 0.99,
                evidence: ["art_invented"],
                limitations: null,
                missingEvidence: [],
                evidenceHint: null,
                absence: null,
              },
            };
          }),
      }),
    );
    return Effect.gen(function* () {
      const verifier = yield* makeVerifier();
      const response = yield* verifier.verify(
        request([
          {
            artifactId: "art_1",
            kind: "observation",
            capturedAt: "2026-09-12T12:00:00.000Z",
            summary: "accessibility tree",
          },
        ]),
      );

      expect(response.outcome._tag).toBe("verdict");
      if (response.outcome._tag === "verdict") {
        const result = response.outcome.result;
        // The evidence rule decides; 0.99 does not soften it by a single step.
        expect(result.status).toBe("inconclusive");
        expect(result.downgrades?.[0]?.reason).toBe("rejected-evidence");
        // ... and the number survives next to the downgrade, which is the whole point of recording
        // it: a confident verdict the harness refused is exactly the sample worth measuring.
        expect(result.confidence).toBe(0.99);
      }

      const system = seen[0]!.prompt.messages.find((message) => message.role === "system")!;
      const text = system.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      expect(text).toContain("`confidence`");
      expect(text).toContain("changes NOTHING");
    }).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, provider)));
  });
});
