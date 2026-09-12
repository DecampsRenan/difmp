/**
 * The reducer's immutability contract, which the component tests structurally cannot see.
 *
 * Every other suite in this directory asserts through the rendered DOM, and that is the right
 * default. It cannot reach this: a reducer that mutates the state it was handed still RENDERS
 * correctly, because the model and array identities around the mutated object change anyway. The
 * damage only shows up once something retains an earlier state or memoizes a row on its object
 * identity — which is to say, later, and somewhere else. So these assertions are made directly.
 */
import { describe, expect, it } from "vitest";
import { emptyRunModel } from "../src/state/model.js";
import type { CriterionView, RunModel } from "../src/state/model.js";
import { runReducer } from "../src/state/reducer.js";
import { harnessEventTypes } from "../src/types/events.js";
import type { HarnessEvent, HarnessEventType } from "../src/types/events.js";
import { capture, criterionResult, eventStream, resolvedConfig } from "./factories.js";

const fold = (model: RunModel, events: ReadonlyArray<HarnessEvent>): RunModel =>
  events.reduce((m, event) => runReducer(m, { kind: "event", event }), model);

const findCriterion = (model: RunModel, id: string): CriterionView => {
  const found = model.criteria.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no criterion ${id}`);
  return found;
};

/**
 * A run with one criterion verified and one left pending — the only shape in which `runFinished`
 * has to change a criterion at all.
 */
const runUpToTheEnd = () => {
  const event = eventStream();
  const model = fold(emptyRunModel, [
    event("runStarted", {
      specPath: "specs/checkout.e2e.md",
      scenarioId: "checkout-flow",
      harnessVersion: "0.1.0",
    }),
    event("contractFrozen", {
      contractHash: "0123456789abcdef",
      specHash: "fedcba9876543210",
      criterionIds: ["c1", "c2"],
    }),
    event("verificationFinished", {
      criterionId: "c1",
      result: criterionResult({ criterionId: "c1", status: "passed" }),
    }),
  ]);
  const finish = event("runFinished", {
    status: "failed",
    criteriaCount: 2,
    failedCriteria: [],
  });
  return { before: model, finish, event };
};

describe("runReducer — runFinished resolves what is still pending", () => {
  it("turns a criterion nobody verified into inconclusive, never into a silent pass", () => {
    const { before, finish } = runUpToTheEnd();
    const after = runReducer(before, { kind: "event", event: finish });
    expect(findCriterion(after, "c2").status).toBe("inconclusive");
    expect(findCriterion(after, "c1").status).toBe("passed");
  });
});

describe("runReducer — it never writes into the state it was handed", () => {
  it("leaves the previous model's criterion untouched", () => {
    const { before, finish } = runUpToTheEnd();
    const pendingBefore = findCriterion(before, "c2");
    expect(pendingBefore.status).toBe("pending");

    const after = runReducer(before, { kind: "event", event: finish });

    // The assertion that matters: reading the OLD model after the reducer ran must still describe
    // the world as it was. `Object.assign(c, …)` rewrote this object in place and passed every
    // DOM-level test in this suite.
    expect(pendingBefore.status).toBe("pending");
    expect(findCriterion(before, "c2").status).toBe("pending");
    expect(findCriterion(after, "c2")).not.toBe(pendingBefore);
  });

  it("does not swap the previous model's criteria array either", () => {
    const { before, finish } = runUpToTheEnd();
    const arrayBefore = before.criteria;
    const snapshot = arrayBefore.map((c) => ({ id: c.id, status: c.status }));

    const after = runReducer(before, { kind: "event", event: finish });

    expect(after.criteria).not.toBe(arrayBefore);
    expect(arrayBefore.map((c) => ({ id: c.id, status: c.status }))).toEqual(snapshot);
  });

  it("survives a criterion that has actually been frozen", () => {
    const { before, finish } = runUpToTheEnd();
    for (const c of before.criteria) Object.freeze(c);
    Object.freeze(before.criteria);

    // Modules are strict mode, so writing to a frozen object throws rather than failing quietly.
    // This is the same defect as the test above, stated in the form a consumer would hit first.
    expect(() => runReducer(before, { kind: "event", event: finish })).not.toThrow();
  });

  it("carries a criterion it has no reason to change over by reference", () => {
    const { before, finish } = runUpToTheEnd();
    const passedBefore = findCriterion(before, "c1");
    const after = runReducer(before, { kind: "event", event: finish });
    // Structural sharing: only what changed is rebuilt. Copying everything would hide the bug
    // above rather than fix it.
    expect(findCriterion(after, "c1")).toBe(passedBefore);
  });

  it("carries every criterion over by reference when none of them was pending", () => {
    // Same stream, so the seq keeps climbing: a fresh one would restart at 1 and the reducer would
    // rightly drop the event as a duplicate.
    const { before, finish, event } = runUpToTheEnd();
    const resolved = fold(before, [
      event("verificationFinished", {
        criterionId: "c2",
        result: criterionResult({ criterionId: "c2", status: "failed" }),
      }),
    ]);
    expect(findCriterion(resolved, "c2").status).toBe("failed");

    const after = runReducer(resolved, { kind: "event", event: finish });
    for (const c of resolved.criteria) expect(after.criteria).toContain(c);
  });
});

/**
 * One event of EVERY type, keyed by that type so the list cannot quietly fall behind the union.
 *
 * Two guards, because they fail in different places and at different times. The mapped type is a
 * compile error the moment a member is added to `HarnessEvent`, reported by an editor and by the
 * `Typecheck the UI suite` step in CI, which is the only thing that reads
 * `apps/ui/tsconfig.test.json`. The runtime check against `harnessEventTypes` below is the one
 * that fails a Vitest run, here and inside `pnpm run test`, with no typecheck in sight.
 *
 * The payloads are deliberately dull: this suite is about what the reducer WRITES, not what it
 * renders, and every field that shapes a rendered string is already pinned by the component suites.
 * Optional fields are filled in anyway — several branches have a spread-or-`{}` on each of them,
 * and an absent field takes the branch that copies nothing.
 */
const oneOfEachEvent: {
  readonly [K in HarnessEventType]: (emit: ReturnType<typeof eventStream>) => HarnessEvent;
} = {
  runStarted: (e) =>
    e("runStarted", {
      specPath: "specs/checkout.e2e.md",
      scenarioId: "checkout-flow",
      harnessVersion: "0.1.0",
    }),
  configResolved: (e) =>
    e("configResolved", { config: resolvedConfig(), configPath: "difmp.config.ts" }),
  contractFrozen: (e) =>
    e("contractFrozen", {
      contractHash: "0123456789abcdef",
      specHash: "fedcba9876543210",
      criterionIds: ["c1", "c2"],
      // Not sent by core today; folded through the branch that honours it if it ever is.
      criteria: [
        { id: "c1", text: "An order number is visible", method: "code", checkName: "chk" },
      ],
    }),
  fixtureReady: (e) =>
    e("fixtureReady", { fixtureName: "seeded-cart", publicValues: { sku: "A-1" } }),
  browserContextOpened: (e) =>
    e("browserContextOpened", {
      baseUrl: "http://localhost:5173",
      usedStorageState: false,
      capture,
    }),
  observationTaken: (e) =>
    e("observationTaken", {
      observationId: "o1",
      url: "http://localhost:5173/cart",
      title: "Cart",
      elementCount: 12,
    }),
  modelCallStarted: (e) =>
    e("modelCallStarted", {
      role: "browser",
      callId: "m1",
      provider: "anthropic",
      model: "claude-sonnet-5",
    }),
  modelCallFinished: (e) =>
    e("modelCallFinished", {
      role: "verifier",
      callId: "m1",
      inputTokens: 120,
      outputTokens: 40,
      toolCalls: 2,
      finishReason: "stop",
      durationMs: 900,
    }),
  actionStarted: (e) =>
    e("actionStarted", {
      actionId: "a1",
      tool: "click",
      params: { selector: "#pay" },
      intent: "Pay",
    }),
  actionFinished: (e) =>
    e("actionFinished", {
      actionId: "a1",
      tool: "click",
      outcome: "error",
      code: "operation-failed",
      message: "no #pay",
    }),
  evidenceRequested: (e) =>
    e("evidenceRequested", {
      criterionId: "c2",
      requestedBy: "verifier",
      note: "needs a screenshot",
    }),
  verificationFinished: (e) =>
    e("verificationFinished", {
      criterionId: "c1",
      result: criterionResult({ criterionId: "c1", status: "passed" }),
    }),
  artifactAvailable: (e) =>
    e("artifactAvailable", {
      artifactId: "shot-1",
      kind: "screenshot",
      state: "present",
      path: "screenshots/shot-1.png",
      // Resolves to the action opened above, so the branch that copies an owner in is the one taken.
      sourceSeq: 9,
    }),
  actionGuidanceExceeded: (e) =>
    e("actionGuidanceExceeded", { used: 12, guidance: 10, rendering: "12 / 10" }),
  budgetExhausted: (e) =>
    e("budgetExhausted", {
      budget: "maxTokens",
      limit: 200_000,
      used: 200_412,
      detail: "verifier reserve spent",
    }),
  progressStalled: (e) =>
    e("progressStalled", { reason: "same action three times", repeatedActions: 3 }),
  error: (e) =>
    e("error", {
      stage: "agent-loop",
      reason: "click failed",
      fatal: false,
      cause: "TimeoutError",
    }),
  cancellationRequested: (e) =>
    e("cancellationRequested", { reason: "user asked", source: "user" }),
  // After the fixture is ready, and before the run ends: this is the branch that rebuilds `fixture`.
  fixtureCleaned: (e) =>
    e("fixtureCleaned", { fixtureName: "seeded-cart", cleanupsRun: 2, timedOut: true }),
  // Last, and with `c2` never verified: the branch that has to resolve a still-pending criterion.
  runFinished: (e) =>
    e("runFinished", { status: "failed", criteriaCount: 2, failedCriteria: ["c1"] }),
};

/** Insertion order is iteration order here, and the order above is a coherent run start to finish. */
const wholeRun = (): ReadonlyArray<HarnessEvent> => {
  const emit = eventStream();
  return Object.values(oneOfEachEvent).map((build) => build(emit));
};

/**
 * Recursively `Object.freeze`. Modules are strict mode, so a write into anything reachable from a
 * frozen model throws — which turns "the reducer mutated its input" from a defect that shows up
 * later and somewhere else into a stack trace on the line that did it.
 */
const deepFreeze = <T>(value: T, seen = new Set<unknown>()): T => {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const inner of Object.values(value as object)) deepFreeze(inner, seen);
  return value;
};

describe("runReducer — the immutability contract, across every branch", () => {
  it("covers every event type the UI accepts", () => {
    // The compile-time guard on `oneOfEachEvent` cannot fail a CI run (see its comment); this can.
    expect(Object.keys(oneOfEachEvent).toSorted()).toEqual(harnessEventTypes.toSorted());
  });

  it("folds a whole run without ever writing into the model it was handed", () => {
    // `emptyRunModel` is a shared module constant, and freezing it is part of the assertion: the
    // reducer is handed it on the first event and returns it verbatim on `reset`.
    let model: RunModel = deepFreeze(emptyRunModel);
    for (const event of wholeRun()) {
      const next = runReducer(model, { kind: "event", event });
      expect(next).not.toBe(model);
      model = deepFreeze(next);
    }

    // The fold reached the end rather than throwing somewhere in the middle and being caught.
    expect(model.applied).toBe(harnessEventTypes.length);
    expect(model.status).toBe("failed");
    expect(findCriterion(model, "c2").status).toBe("inconclusive");
  });

  it("does not write into it on the actions that carry no event either", () => {
    const model = deepFreeze(fold(emptyRunModel, wholeRun()));

    expect(runReducer(model, { kind: "malformed" }).malformed).toBe(1);
    // A `seq` already applied: the branch that only counts the duplicate.
    expect(
      runReducer(model, { kind: "event", event: wholeRun()[0] as HarnessEvent }).duplicates,
    ).toBe(1);
    expect(runReducer(model, { kind: "reset" })).toEqual(emptyRunModel);
    expect(
      runReducer(model, {
        kind: "contract",
        contract: {
          // `c1` exists and is merged into; `c3` does not and is appended.
          criteria: [
            { id: "c1", text: "An order number is visible", method: "model" },
            { id: "c3", text: "The cart is empty", method: "code", checkName: "cartEmpty" },
          ],
          specPath: "specs/checkout.e2e.md",
          id: "checkout-flow",
          maxActions: 40,
        },
      }).criteria.map((c) => c.id),
    ).toEqual(["c1", "c2", "c3"]);
  });
});
