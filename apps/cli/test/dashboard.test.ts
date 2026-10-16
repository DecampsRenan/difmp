import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- jsdom ships no types and CLI tests are not typechecked; the root devDependency is used.
import { JSDOM } from "jsdom";
import { fallbackDashboard } from "../src/server/assets.js";

/**
 * The fallback dashboard decodes the SSE wire by hand. These tests feed it frames shaped exactly
 * like the bus publishes them (`{ seq, type, data }`, harness events under `data.event`) and read
 * the DOM back, so a field read from the wrong place (#58) shows up as a wrong panel.
 */
const boot = () => {
  const listeners = new Map<string, (ev: { data: string }) => void>();
  const dom = new JSDOM(readFileSync(fallbackDashboard, "utf8"), {
    runScripts: "dangerously",
    beforeParse(window: any) {
      window.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });
      window.EventSource = class {
        onmessage: ((ev: { data: string }) => void) | null = null;
        constructor() {
          queueMicrotask(() => {
            if (this.onmessage) listeners.set("message", this.onmessage);
          });
        }
        addEventListener(type: string, fn: (ev: { data: string }) => void) {
          listeners.set(type, fn);
        }
      };
    },
  });
  let seq = 0;
  const send = (type: string, data: unknown) =>
    listeners.get(type)?.({ data: JSON.stringify({ seq: ++seq, type, data }) });
  const harness = (event: Record<string, unknown>) => send("harness", { runId: "r_1", event });
  const text = (id: string) => dom.window.document.getElementById(id)?.textContent ?? "";
  return { harness, text };
};

describe("fallback dashboard — verificationFinished (#58)", () => {
  it("shows the verdict and expectation carried under `result`", () => {
    const { harness, text } = boot();
    harness({ type: "contractFrozen", criterionIds: ["c1"] });
    expect(text("criteria")).toContain("pending");

    harness({
      type: "verificationFinished",
      criterionId: "c1",
      result: {
        criterionId: "c1",
        status: "passed",
        expected: "The project appears in the list",
        observed: "it does",
        evidence: [],
      },
    });

    expect(text("criteria")).toContain("passed");
    expect(text("criteria")).toContain("The project appears in the list");
    expect(text("criteria")).not.toContain("pending");
  });

  it("puts the verdict status in the timeline line", () => {
    const { harness, text } = boot();
    harness({
      type: "verificationFinished",
      criterionId: "c2",
      result: { criterionId: "c2", status: "failed", expected: "x", observed: "y", evidence: [] },
    });
    expect(text("timeline")).toContain("verificationFinished");
    expect(text("timeline")).toContain("failed");
  });
});
