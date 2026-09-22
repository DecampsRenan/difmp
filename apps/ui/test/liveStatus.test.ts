import { describe, expect, it } from "vitest";
import {
  liveStatusFromCriterion,
  liveStatusFromRun,
  liveStatusTone,
} from "../src/state/liveStatus.js";

describe("liveStatusFromRun", () => {
  it.each([
    ["pending", "not tested"],
    ["running", "in progress"],
    ["passed", "passed"],
    ["failed", "failed"],
    ["error", "failed"],
    ["inconclusive", "need details"],
    ["cancelled", "need details"],
  ] as const)("maps %s → %s", (from, to) => {
    expect(liveStatusFromRun(from)).toBe(to);
  });
});

describe("liveStatusFromCriterion", () => {
  it("maps pending without evidence to not tested", () => {
    expect(liveStatusFromCriterion({ status: "pending", evidenceRequested: false })).toBe(
      "not tested",
    );
  });

  it("maps pending with evidence requested to in progress", () => {
    expect(liveStatusFromCriterion({ status: "pending", evidenceRequested: true })).toBe(
      "in progress",
    );
  });

  it("maps inconclusive (needsEvidence / unfinished) to need details", () => {
    expect(liveStatusFromCriterion({ status: "inconclusive", evidenceRequested: true })).toBe(
      "need details",
    );
  });

  it.each([
    ["passed", "passed"],
    ["failed", "failed"],
    ["error", "failed"],
  ] as const)("maps %s → %s", (from, to) => {
    expect(liveStatusFromCriterion({ status: from, evidenceRequested: false })).toBe(to);
  });
});

describe("liveStatusTone", () => {
  it("keeps a tone for every live status", () => {
    expect(liveStatusTone("passed")).toBe("ok");
    expect(liveStatusTone("failed")).toBe("bad");
    expect(liveStatusTone("need details")).toBe("warn");
    expect(liveStatusTone("in progress")).toBe("info");
    expect(liveStatusTone("not tested")).toBe("neutral");
  });
});
