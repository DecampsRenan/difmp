import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import type { VerificationRequest } from "@difmp/core";
import { ModelProvider, resolveConfig } from "@difmp/core";
import { Effect, Layer } from "effect";
import { BackendError } from "jev-use";
import type { JevBackend, Question, RawAnswer } from "jev-use";
import { jevJudgeFrom, makeVerifier, openJevEvaluator } from "../src/index.js";
import { interpretJevJudgment } from "../src/jev/judge.js";

const request = (
  evidence: VerificationRequest["evidence"],
  signal?: AbortSignal,
): VerificationRequest => ({
  attemptId: "a1",
  criterion: {
    id: "c1",
    text: "The project appears in the list.",
    sourceText: "The project appears in the list.",
    line: 1,
    column: 1,
    method: "model",
  },
  criterionHash: "a".repeat(64),
  evidence,
  scenario: { id: "project-create", body: "Create a project", inputs: {}, fixturePublic: {} },
  baseUrl: "http://127.0.0.1:3000",
  seq: 4,
  ...(signal === undefined ? {} : { signal }),
});

const observation = (
  artifactId: string,
  summary: string,
): VerificationRequest["evidence"][number] => ({
  artifactId,
  kind: "aria-snapshot",
  capturedAt: "2026-09-22T08:00:00.000Z",
  summary,
});

/** Confident "no" for an unscripted noul, or the first choice label. */
const fallback = (question: Question): RawAnswer => {
  if (question.type === "choice") {
    const options = question.options;
    const label = Array.isArray(options) ? options[0] : Object.keys(options ?? {})[0];
    return { answer: label ?? "none", confidence: 0.95 };
  }
  return { answer: 0.05, confidence: 0.95 };
};

const scriptedBackend = (
  script: Readonly<Record<string, RawAnswer>>,
  hooks: {
    readonly fail?: BackendError;
    readonly onState?: (state: string) => void;
    readonly calls?: { count: number };
    readonly hold?: { release: () => void };
  } = {},
): JevBackend => ({
  name: "fake",
  judge: (backendRequest) => {
    if (hooks.calls !== undefined) hooks.calls.count += 1;
    const state =
      typeof backendRequest.state === "string"
        ? backendRequest.state
        : JSON.stringify(backendRequest.state);
    hooks.onState?.(state);
    const answer = {
      model: "jev-1.13.0",
      usage: { inputTokens: 11, outputTokens: 4 },
      answers: backendRequest.questions.map(
        (question) => script[question.id] ?? fallback(question),
      ),
    };
    if (hooks.fail !== undefined) return Promise.reject(hooks.fail);
    if (hooks.hold !== undefined) {
      return new Promise((resolve) => {
        hooks.hold!.release = () => resolve(answer);
      });
    }
    return Promise.resolve(answer);
  },
});

const provider = Layer.succeed(
  ModelProvider,
  ModelProvider.of({
    id: "scripted",
    modelId: "scripted-double",
    generate: () => Effect.die("the navigation provider must not judge a Jev criterion"),
  }),
);

const withJev = (backend: JevBackend, threshold?: number) =>
  Effect.gen(function* () {
    const jev = yield* jevJudgeFrom({
      model: "jev-1.13.0",
      backend,
      ...(threshold === undefined ? {} : { confidenceThreshold: threshold }),
    });
    return yield* makeVerifier({ jev });
  }).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, provider)));

describe("jev evaluator", () => {
  it.effect("passes from a confident batch and cites only the artifacts Jev accepted", () =>
    Effect.gen(function* () {
      const pixels = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
      let state = "";
      const verifier = yield* withJev(
        scriptedBackend(
          {
            holds: { answer: 0.96, confidence: 0.93 },
            contradicted: { answer: 0.04, confidence: 0.91 },
            settled: { answer: 0.92, confidence: 0.9 },
            absence: { answer: "not-about-absence", confidence: 0.95 },
            missing: { answer: "none", confidence: 0.95 },
            cite_art_1: { answer: 0.9, confidence: 0.88 },
            cite_art_2: { answer: 0.08, confidence: 0.9 },
          },
          { onState: (value) => (state = value) },
        ),
      );
      const response = yield* verifier.verify(
        request([
          observation("art_1", "The list shows Project r_1."),
          observation("art_2", "The home page heading."),
          {
            artifactId: "art_3",
            kind: "screenshot",
            capturedAt: "2026-09-22T08:00:01.000Z",
            summary: 'screenshot "checkpoint-c1"',
            image: { mediaType: "image/png", data: pixels },
          },
        ]),
      );
      expect(verifier.identity).toMatchObject({
        provider: "jev",
        modelId: "jev-1.13.0",
        adapterId: "jev/jev-use",
        backend: "fake",
      });
      expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
      expect(response.outcome._tag).toBe("verdict");
      if (response.outcome._tag !== "verdict") return;
      expect(response.outcome.result.status).toBe("passed");
      expect(response.outcome.result.evidence).toEqual(["art_1"]);
      expect(response.outcome.result.evaluator).toMatchObject({
        kind: "model",
        provider: "jev",
        model: "jev-1.13.0",
        confidence: 0.93,
        confidenceFrom: "reported",
      });
      expect(response.outcome.result.observed).toContain("holds=0.96");
      expect(state).toContain("art_1");
      expect(state).toContain('screenshot "checkpoint-c1"');
      expect(state).not.toContain("137,80,78,71");
      expect(state).toContain("Screenshot image bytes are not included.");
    }),
  );

  it.effect("records inconclusive when the decisive answer escalates", () =>
    Effect.gen(function* () {
      const verifier = yield* withJev(
        scriptedBackend({
          holds: { answer: 0.7, confidence: 0.1 },
          contradicted: { answer: 0.2, confidence: 0.9 },
          settled: { answer: 0.8, confidence: 0.9 },
        }),
      );
      const response = yield* verifier.verify(request([observation("art_1", "A list.")]));
      expect(response.outcome._tag).toBe("verdict");
      if (response.outcome._tag !== "verdict") return;
      expect(response.outcome.result.status).toBe("inconclusive");
      expect(response.outcome.result.evaluator).toMatchObject({ kind: "model", provider: "jev" });
    }),
  );

  it.effect("does not pass when Jev both accepts and contradicts the criterion", () =>
    Effect.gen(function* () {
      const verifier = yield* withJev(
        scriptedBackend({
          holds: { answer: 0.91, confidence: 0.9 },
          contradicted: { answer: 0.9, confidence: 0.9 },
          settled: { answer: 0.9, confidence: 0.9 },
        }),
      );
      const response = yield* verifier.verify(request([observation("art_1", "A list.")]));
      if (response.outcome._tag !== "verdict") throw new Error("expected a verdict");
      expect(response.outcome.result.status).toBe("inconclusive");
      expect(response.outcome.result.limitations).toContain("both");
    }),
  );

  it.effect("fails only when holds is rejected, contradicted, and settled", () =>
    Effect.gen(function* () {
      const verifier = yield* withJev(
        scriptedBackend({
          holds: { answer: 0.08, confidence: 0.91 },
          contradicted: { answer: 0.94, confidence: 0.9 },
          settled: { answer: 0.93, confidence: 0.92 },
          absence: { answer: "not-about-absence", confidence: 0.95 },
          missing: { answer: "none", confidence: 0.95 },
          cite_art_1: { answer: 0.9, confidence: 0.88 },
        }),
      );
      const response = yield* verifier.verify(
        request([observation("art_1", "The list does not include Project r_1.")]),
      );
      if (response.outcome._tag !== "verdict") throw new Error("expected a verdict");
      expect(response.outcome.result.status).toBe("failed");
      expect(response.outcome.result.evidence).toEqual(["art_1"]);
      expect(response.outcome.result.evaluator).toMatchObject({
        kind: "model",
        provider: "jev",
        confidence: 0.9,
        confidenceFrom: "reported",
      });
    }),
  );

  it.effect("stays inconclusive when settled but neither holds nor contradiction is decided", () =>
    Effect.gen(function* () {
      const verifier = yield* withJev(
        scriptedBackend({
          holds: { answer: 0.1, confidence: 0.9 },
          contradicted: { answer: 0.2, confidence: 0.9 },
          settled: { answer: 0.9, confidence: 0.9 },
        }),
      );
      const response = yield* verifier.verify(request([observation("art_1", "A list.")]));
      if (response.outcome._tag !== "verdict") throw new Error("expected a verdict");
      expect(response.outcome.result.status).toBe("inconclusive");
    }),
  );

  it.effect("asks for one catalogued capture, then settles inconclusive at the cap", () =>
    Effect.gen(function* () {
      const verifier = yield* withJev(
        scriptedBackend({
          settled: { answer: 0.08, confidence: 0.92 },
          missing: { answer: "observation-after-reload", confidence: 0.9 },
        }),
      );
      const evidence = [observation("art_1", "The list before reload.")];
      const first = yield* verifier.verify(request(evidence));
      expect(first.outcome).toMatchObject({
        _tag: "needsEvidence",
        missing: ["observation-after-reload"],
        hint: "reload the page and observe it again",
      });
      const second = yield* verifier.verify(request(evidence));
      expect(second.outcome._tag).toBe("verdict");
      if (second.outcome._tag !== "verdict") return;
      expect(second.outcome.result.status).toBe("inconclusive");
      expect(second.outcome.result.limitations).toContain("observation-after-reload");
    }),
  );

  it.effect("turns an unreachable backend into a retryable verifier error", () =>
    Effect.gen(function* () {
      const failure = new BackendError("fake", "upstream timed out", 503);
      failure.retryAfterMs = 1200;
      const verifier = yield* withJev(scriptedBackend({}, { fail: failure }));
      const exit = yield* verifier
        .verify(request([observation("art_1", "A list.")]))
        .pipe(Effect.result);
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(exit.failure.reason).toContain("unreachable");
      expect(exit.failure.reason).toContain("upstream timed out");
      expect(exit.failure.retryable).toBe(true);
      expect(exit.failure.retryAfterMs).toBe(1200);
    }),
  );

  it.effect("does not retry a 401 from the backend", () =>
    Effect.gen(function* () {
      const verifier = yield* withJev(
        scriptedBackend({}, { fail: new BackendError("fake", "bad key", 401) }),
      );
      const exit = yield* verifier
        .verify(request([observation("art_1", "A list.")]))
        .pipe(Effect.result);
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(exit.failure.retryable).not.toBe(true);
    }),
  );

  it.effect("stops when the harness aborts, without waiting for the backend", () => {
    const hold: { release: () => void } = { release: () => undefined };
    const controller = new AbortController();
    controller.abort();
    return Effect.gen(function* () {
      const verifier = yield* withJev(scriptedBackend({}, { hold }));
      const exit = yield* verifier
        .verify(request([observation("art_1", "A list.")], controller.signal))
        .pipe(Effect.result);
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(exit.failure.reason).toContain("aborted");
      expect(exit.failure.retryable).not.toBe(true);
    }).pipe(Effect.ensuring(Effect.sync(() => hold.release())));
  });

  it.effect("leaves an oversized state unjudged instead of trimming evidence", () =>
    Effect.gen(function* () {
      const calls = { count: 0 };
      const verifier = yield* withJev(scriptedBackend({}, { calls }));
      const response = yield* verifier.verify(request([observation("art_1", "x".repeat(140_000))]));
      expect(calls.count).toBe(0);
      expect(response.outcome._tag).toBe("verdict");
      if (response.outcome._tag !== "verdict") return;
      expect(response.outcome.result.status).toBe("inconclusive");
      expect(response.outcome.result.evidence).toEqual([]);
      expect(response.outcome.result.limitations).toContain("oversized");
    }),
  );

  it.effect("treats a writing refusal as an adapter fault", () =>
    Effect.gen(function* () {
      const criterion = request([]).criterion;
      const exit = yield* interpretJevJudgment({
        judgment: {
          answers: {
            holds: {
              id: "holds",
              type: "noul",
              answer: null,
              confidence: 0,
              escalate: true,
              reason: "writing",
            },
          },
          backend: "fake",
        },
        criterion,
        criterionHash: "a".repeat(64),
        evidence: [],
        seq: 1,
        asked: 0,
        maxEvidenceRequests: 1,
        modelId: "jev-1.13.0",
      }).pipe(Effect.result);
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(exit.failure.reason).toContain("writing");
      expect(exit.failure.retryable).not.toBe(true);
    }),
  );

  it.effect("resolves mock with no key and refuses typesafe the same way", () =>
    Effect.gen(function* () {
      const mockProject = yield* resolveConfig({
        source: "difmp.config.ts",
        config: {
          evaluator: { provider: "jev", model: "jev-1.13.0", backend: "mock" },
        },
      });
      const mock = yield* openJevEvaluator(mockProject.config, {});
      expect(mock?.backendName).toBe("mock");

      const liveProject = yield* resolveConfig({
        source: "difmp.config.ts",
        config: {
          evaluator: {
            provider: "jev",
            model: "jev-1.13.0",
            backend: "typesafe",
            confidenceThreshold: 0.5,
          },
        },
      });
      const error = yield* openJevEvaluator(liveProject.config, {}).pipe(Effect.flip);
      expect(error.message).toContain("TYPESAFE_API_KEY");
      expect(error.message).not.toContain("sk-");
    }),
  );
});
