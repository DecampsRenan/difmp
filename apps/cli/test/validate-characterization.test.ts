import { describe, expect, it } from "vitest";
import { exec, fixture } from "./helpers.js";

/**
 * CHARACTERIZATION — pinned from the real output of `difmp validate` on the `validate-problems`
 * fixture BEFORE the `prepareRun` refactor (issue #42, decision 3). The tolerant door must keep
 * reporting every problem of a scenario, in one accumulation order, with messages that name
 * source position. These strings are machine-readable output: a change here is a change in the
 * CLI contract, never an accident of refactoring.
 */
const problemsOf = async (): Promise<ReadonlyArray<string>> => {
  const result = await exec(["validate", "--json"], { cwd: fixture("validate-problems") });
  expect(result.code).toBe(2);
  const parsed = JSON.parse(result.stdout.join("\n")) as {
    valid: boolean;
    scenarios: ReadonlyArray<{ scenarioId: string; problems: ReadonlyArray<string> }>;
  };
  expect(parsed.valid).toBe(false);
  expect(parsed.scenarios).toHaveLength(1);
  return parsed.scenarios[0]!.problems;
};

describe("validate output (characterized)", () => {
  it("reports every problem class of the mixed scenario, in the pinned order", async () => {
    const problems = await problemsOf();
    expect(problems).toHaveLength(6);
    // Input-value interpolation first…
    expect(problems[0]).toMatch(
      /mixed\.e2e\.md:1:1 \(field `inputs\.broken`\): \{\{ nope \}\} — unknown variable/,
    );
    // …then the body, then each criterion in source order, with absolute positions…
    expect(problems[1]).toMatch(/mixed\.e2e\.md:13:6 \(field `body`\): \{\{ nopeEither \}\}/);
    expect(problems[2]).toMatch(/mixed\.e2e\.md:17:7 \(field `c1`\): \{\{ nopeTwo \}\}/);
    expect(problems[3]).toMatch(/mixed\.e2e\.md:18:27 \(field `c2`\): \{\{ nopeThree \}\}/);
    // …then the registry names, check before fixture.
    expect(problems[4]).toContain("ghost-check");
    expect(problems[5]).toContain("ghost-fixture");
  });

  it("names what WAS available in every unknown-variable message", async () => {
    const problems = await problemsOf();
    for (const problem of problems.slice(0, 4)) {
      expect(problem).toContain("available: run.id, attempt.id, fixture.<key>");
      expect(problem).toContain("declared inputs: none declared");
    }
  });

  it("accepts unresolved {{ fixture.* }} references (no setup has run)", async () => {
    const result = await exec(["validate", "--json"], { cwd: fixture("bad-refs") });
    const parsed = JSON.parse(result.stdout.join("\n")) as {
      scenarios: ReadonlyArray<{ scenarioId: string; problems: ReadonlyArray<string> }>;
    };
    const fixtureRef = parsed.scenarios.find((s) => s.scenarioId === "fixture-reference");
    expect(fixtureRef?.problems).toEqual([]);
  });
});
