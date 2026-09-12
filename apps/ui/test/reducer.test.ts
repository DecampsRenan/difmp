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
import type { HarnessEvent } from "../src/types/events.js";
import { criterionResult, eventStream } from "./factories.js";

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
