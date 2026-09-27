import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeRegistry,
  parseSpec,
  prepareRun,
  checkRun,
  resolveConfig,
  resolveRunInputs,
} from "../src/index.js";
import type { LoadedSpec, Registries } from "../src/index.js";
import { expectSuccess, platform } from "./helpers.js";

const runId = "r_abcdefghijklm";
const attemptId = "a1";

const baseConfig = () =>
  expectSuccess(
    resolveConfig({
      source: "difmp.config.ts",
      config: {
        baseUrl: "http://127.0.0.1:3000",
        provider: "scripted",
        inputs: { fromConfig: "config-value" },
      },
    }),
  );
const resolvedConfig = () => baseConfig().pipe(Effect.map((project) => project.config));

const parse = (name: string, content: string): LoadedSpec =>
  Effect.runSync(parseSpec({ specPath: name, content }));

const registries = (over: Partial<Registries> = {}): Registries => ({
  fixtures: makeRegistry("fixture", { auth: async () => ({}) }),
  checks: makeRegistry("check", {
    "store-check": async () => ({ status: "passed", expected: "", observed: "", evidence: [] }),
  }),
  ...over,
});

const plainSpec = parse(
  "plain.e2e.md",
  `---
version: 1
id: plain
inputs:
  workspaceName: "Workspace {{ run.id }}"
---

# Plain

Open the workspace {{ workspaceName }}.

## Expected results

- The workspace {{ workspaceName }} is visible.
- The store confirms it.
`,
);

describe("prepareRun — strict door", () => {
  it.effect("resolves inputs through the full precedence before anything else", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareRun({
        spec: plainSpec,
        specPath: "plain.e2e.md",
        config: yield* resolvedConfig(),
        registries: registries(),
        runId,
        attemptId,
        fileInputs: { fromConfig: "file-value" },
        cliInputs: { workspaceName: "cli-ws" },
      }).pipe(Effect.provide(platform));
      // config < spec < file < CLI, exactly once, with phase-1 interpolation of what is left.
      expect(prepared.inputs).toEqual({ fromConfig: "file-value", workspaceName: "cli-ws" });
      const second = yield* prepareRun({
        spec: plainSpec,
        specPath: "plain.e2e.md",
        config: yield* resolvedConfig(),
        registries: registries(),
        runId,
        attemptId,
        fileInputs: { fromConfig: "file-value" },
        cliInputs: { workspaceName: "cli-ws" },
      }).pipe(Effect.provide(platform));
      expect(second.inputs).toEqual(prepared.inputs);
    }),
  );

  it.effect("the input stage fails BEFORE the registry stage is consulted", () =>
    Effect.gen(function* () {
      const bad = parse(
        "bad.e2e.md",
        `---
version: 1
id: bad
checks:
  c1: not-registered
---

# Bad

Open the page.

## Expected results

- The page renders.
`,
      );
      const result = yield* prepareRun({
        spec: bad,
        specPath: "bad.e2e.md",
        config: yield* resolvedConfig(),
        registries: registries(),
        runId,
        attemptId,
        fileInputs: { rogue: "x" },
      }).pipe(Effect.result, Effect.provide(platform));
      // The pinned order (issue #42, decision 6): a precedence violation fails the input stage;
      // the registry problem behind it never gets a turn to speak first.
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain('--inputs-file declares "rogue"');
        expect(result.failure.message).not.toContain("not-registered");
      }
    }),
  );

  it.effect("registry names are refused before the freeze, with the registry's own voice", () =>
    Effect.gen(function* () {
      const unbound = parse(
        "unbound.e2e.md",
        `---
version: 1
id: unbound
checks:
  c1: not-registered
---

# Unbound

Open the page.

## Expected results

- The page renders.
- The store confirms.
`,
      );
      const result = yield* prepareRun({
        spec: unbound,
        specPath: "unbound.e2e.md",
        config: yield* resolvedConfig(),
        registries: registries(),
        runId,
        attemptId,
      }).pipe(Effect.result, Effect.provide(platform));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain('check "not-registered"');
        expect(result.failure.message).toContain("mapped to criterion c1");
      }
    }),
  );

  it.effect("the freeze interpolates strictly, is deterministic, and hashes its content", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareRun({
        spec: plainSpec,
        specPath: "plain.e2e.md",
        config: yield* resolvedConfig(),
        registries: registries(),
        runId,
        attemptId,
      }).pipe(Effect.provide(platform));
      const first = yield* prepared.contract().pipe(Effect.provide(platform));
      const second = yield* prepared.contract().pipe(Effect.provide(platform));
      expect(first.body).toContain("Workspace r_abcdefghijklm");
      expect(first.criteria.map((c) => c.text)).toEqual([
        "The workspace Workspace r_abcdefghijklm is visible.",
        "The store confirms it.",
      ]);
      expect(first.hashes.contract).toBe(second.hashes.contract);
      expect(Object.keys(first.hashes.criteria)).toEqual(["c1", "c2"]);
      expect(first.hashes.spec).not.toBe("");
    }),
  );

  it.effect("the scenario `timeout` replaces attemptTimeoutMs — and only it — in the freeze", () =>
    Effect.gen(function* () {
      const spec = parse(
        "timed.e2e.md",
        `---
version: 1
id: timed
timeout: 60s
---

# Timed

Open the page.

## Expected results

- The page renders.
`,
      );
      const config = yield* resolvedConfig();
      const prepared = yield* prepareRun({
        spec,
        specPath: "timed.e2e.md",
        config,
        registries: registries(),
        runId,
        attemptId,
      }).pipe(Effect.provide(platform));
      const contract = yield* prepared.contract().pipe(Effect.provide(platform));
      expect(contract.budgets.attemptTimeoutMs).toBe(60_000);
      // Every other budget still comes from the config untouched.
      expect(contract.budgets.maxModelCalls).toBe(config.budgets.maxModelCalls);
      expect(contract.budgets.operationTimeoutMs).toBe(config.budgets.operationTimeoutMs);
      // The override is part of the frozen content: the hash proves it.
      const withoutOverride = yield* prepareRun({
        spec: parse("timed.e2e.md", spec.source.replace("timeout: 60s\n", "")),
        specPath: "timed.e2e.md",
        config,
        registries: registries(),
        runId,
        attemptId,
      }).pipe(Effect.provide(platform));
      const plain = yield* withoutOverride.contract().pipe(Effect.provide(platform));
      expect(plain.budgets.attemptTimeoutMs).toBe(config.budgets.attemptTimeoutMs);
      expect(plain.hashes.contract).not.toBe(contract.hashes.contract);
    }),
  );

  it.effect("{{ fixture.* }} is rejected by the freeze unless the public values answer it", () =>
    Effect.gen(function* () {
      const spec = parse(
        "fixture-ref.e2e.md",
        `---
version: 1
id: fixture-ref
fixture: auth
---

# Fixture ref

Open the {{ fixture.workspaceName }} workspace.

## Expected results

- The workspace is displayed.
`,
      );
      const prepared = yield* prepareRun({
        spec,
        specPath: "fixture-ref.e2e.md",
        config: yield* resolvedConfig(),
        registries: registries(),
        runId,
        attemptId,
      }).pipe(Effect.provide(platform));
      const strict = yield* prepared.contract().pipe(Effect.result, Effect.provide(platform));
      expect(strict._tag).toBe("Failure");
      if (strict._tag === "Failure") {
        expect(strict.failure.message).toContain("fixture.workspaceName");
      }
      const withFixture = yield* prepared
        .contract({ fixturePublic: { workspaceName: "Demo workspace" } })
        .pipe(Effect.provide(platform));
      expect(withFixture.body).toContain("the Demo workspace workspace");
    }),
  );
});

describe("prepareRun — doors agree", () => {
  it.effect("resolveRunInputs IS the strict door's first stage, value for value", () =>
    Effect.gen(function* () {
      const request = {
        spec: plainSpec,
        specPath: "plain.e2e.md",
        config: yield* resolvedConfig(),
        runId,
        attemptId,
        fileInputs: { fromConfig: 42 },
      };
      const stage = yield* resolveRunInputs(request).pipe(Effect.provide(platform));
      const prepared = yield* prepareRun({
        ...request,
        registries: registries(),
      }).pipe(Effect.provide(platform));
      expect(prepared.inputs).toEqual(stage);
    }),
  );
});

describe("checkRun — tolerant door", () => {
  it.effect("accumulates every problem instead of stopping at the first", () =>
    Effect.gen(function* () {
      const spec = parse(
        "mixed.e2e.md",
        `---
version: 1
id: mixed
fixture: ghost
checks:
  c2: ghost-check
inputs:
  broken: "{{ nope }}"
---

# Mixed

Open {{ nopeEither }}.

## Expected results

- The {{ nopeTwo }} thing shows.
- Second with {{ nopeThree }}.
`,
      );
      const problems = yield* checkRun({
        spec,
        specPath: "mixed.e2e.md",
        config: yield* resolvedConfig(),
        registries: registries(),
        source: "difmp.config.ts",
      });
      // Same classes, same order as the CLI contract pins (apps/cli/test/validate-characterization).
      expect(problems).toHaveLength(6);
      expect(problems[0]).toContain("inputs.broken");
      expect(problems[1]).toContain("field `body`");
      expect(problems[2]).toContain("field `c1`");
      expect(problems[3]).toContain("field `c2`");
      expect(problems[4]).toContain("ghost-check");
      expect(problems[5]).toContain('fixture "ghost"');
    }),
  );

  it.effect("accepts unresolved {{ fixture.* }} — no setup has run", () =>
    Effect.gen(function* () {
      const spec = parse(
        "fixture-ref.e2e.md",
        `---
version: 1
id: fixture-ref
fixture: auth
---

# Fixture ref

Open the {{ fixture.workspaceName }} workspace.

## Expected results

- The {{ fixture.workspaceName }} workspace is displayed.
`,
      );
      const problems = yield* checkRun({
        spec,
        specPath: "fixture-ref.e2e.md",
        config: yield* resolvedConfig(),
        registries: registries(),
        source: "difmp.config.ts",
      });
      expect(problems).toEqual([]);
    }),
  );

  it.effect("uses placeholder ids, and names them in the messages", () =>
    Effect.gen(function* () {
      const spec = parse(
        "runref.e2e.md",
        `---
version: 1
id: runref
inputs:
  workspaceName: "Workspace {{ run.id }}"
---

# Run ref

Open {{ workspaceName }}.

## Expected results

- It shows.
`,
      );
      const problems = yield* checkRun({
        spec,
        specPath: "runref.e2e.md",
        config: yield* resolvedConfig(),
        registries: registries(),
        source: "difmp.config.ts",
      });
      expect(problems).toEqual([]);
      // The body still references the placeholder — validate never runs, and the message
      // vocabulary is the freeze's own: no complaint about `run.id` at validation time.
    }),
  );
});
