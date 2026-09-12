import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  assertUniqueScenarioIds,
  discoverSpecs,
  parseDurationMs,
  parseSpec,
  resolveConfig,
} from "../src/index.js";
import { expectFailure, expectSuccess, fixturePath, readFixture } from "./helpers.js";

const parse = (name: string) => parseSpec({ specPath: name, content: readFixture(name) });

describe("SpecLoader parsing", () => {
  it.effect("accepts the reference scenario and splits its list into one criterion per item", () =>
    Effect.gen(function* () {
      const spec = yield* expectSuccess(parse("project-create.e2e.md"));
      expect(spec.frontmatter.id).toBe("project-create");
      expect(spec.frontmatter.tags).toEqual(["smoke", "projects"]);
      expect(spec.expectationSource).toBe("verification");
      expect(spec.timeoutMs).toBe(90_000);
      expect(spec.criteria.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
      expect(spec.criteria[0]!.sourceText).toBe(
        "The project {{ projectName }} appears in the list after it is created.",
      );
      // Positions are preserved: the block scalar starts on line 11 of the file.
      expect(spec.criteria[0]!.line).toBe(11);
      expect(spec.criteria[1]!.line).toBe(12);
      expect(spec.criteria[2]!.line).toBe(13);
      expect(spec.criteria.every((c) => c.method === "model")).toBe(true);
    }),
  );

  it.effect(
    "reads expectations from a Markdown section and keeps the paragraph as one criterion",
    () =>
      Effect.gen(function* () {
        const spec = yield* expectSuccess(parse("section-expectations.e2e.md"));
        expect(spec.expectationSource).toBe("section");
        expect(spec.criteria).toHaveLength(1);
        expect(spec.criteria[0]!.sourceText).toBe(
          "The dashboard shows the up-to-date balance\nafter the form is submitted.",
        );
        // The following `## Notes` heading ends the section.
        expect(spec.criteria[0]!.sourceText).not.toContain("This is not");
      }),
  );

  it.effect("binds a `checks` entry to its criterion and marks the method as code", () =>
    Effect.gen(function* () {
      const spec = yield* expectSuccess(parse("coded-check.e2e.md"));
      expect(spec.criteria[0]!.method).toBe("model");
      expect(spec.criteria[1]!.method).toBe("code");
      expect(spec.criteria[1]!.checkName).toBe("project-unique-in-storage");
    }),
  );
});

describe("SpecLoader rejections", () => {
  const rejects = (fixture: string, fragment: string, field?: string) =>
    it.effect(`rejects ${fixture}`, () =>
      Effect.gen(function* () {
        const error = yield* expectFailure(parse(fixture));
        expect(error.specPath).toBe(fixture);
        expect(error.message).toContain(fragment);
        if (field !== undefined) expect(error.field).toBe(field);
        expect(error.line).toBeTypeOf("number");
      }),
    );

  rejects("both-sources.e2e.md", "declared twice", "verification");
  rejects("unknown-field.e2e.md", "invalid frontmatter", "profile");
  rejects("duplicate-key.e2e.md", "unique", "frontmatter");
  rejects("bad-version.e2e.md", "unsupported spec version", "version");
  rejects("bad-timeout.e2e.md", "unparseable timeout", "timeout");
  rejects("bad-max-actions.e2e.md", "strictly positive", "maxActions");
  rejects("executable-tag.e2e.md", "tag", "frontmatter");
  rejects("empty-body.e2e.md", "body must not be empty");
  rejects("no-expectations.e2e.md", "no expectations found", "verification");

  it.effect("names the excess frontmatter key in the details", () =>
    Effect.gen(function* () {
      const error = yield* expectFailure(parse("unknown-field.e2e.md"));
      expect(error.details?.join("\n")).toContain("profile");
    }),
  );

  it.effect("rejects a file that does not start with frontmatter", () =>
    Effect.gen(function* () {
      const error = yield* expectFailure(
        parseSpec({ specPath: "no-frontmatter.e2e.md", content: "# Just markdown\n" }),
      );
      expect(error.message).toContain("missing YAML frontmatter");
    }),
  );

  it.effect("rejects a duplicate scenario id across a set of specs", () =>
    Effect.gen(function* () {
      const a = yield* expectSuccess(parse("project-create.e2e.md"));
      const b = { ...a, specPath: "copy.e2e.md" };
      const error = yield* expectFailure(assertUniqueScenarioIds([a, b]));
      expect(error.message).toContain("duplicate scenario id");
      expect(error.message).toContain("project-create.e2e.md");
    }),
  );
});

describe("duration parsing", () => {
  it("accepts the abbreviated and spelled forms Effect cannot parse", () => {
    expect(parseDurationMs("90s")).toBe(90_000);
    expect(parseDurationMs("2m")).toBe(120_000);
    expect(parseDurationMs("1500ms")).toBe(1500);
    expect(parseDurationMs("90 seconds")).toBe(90_000);
    expect(parseDurationMs("90000")).toBe(90_000);
    expect(parseDurationMs(90_000)).toBe(90_000);
  });

  it("rejects non-positive and unparseable durations", () => {
    expect(parseDurationMs("0s")).toBeUndefined();
    expect(parseDurationMs(-1)).toBeUndefined();
    expect(parseDurationMs("soon")).toBeUndefined();
    expect(parseDurationMs("")).toBeUndefined();
  });
});

describe("spec discovery", () => {
  it.effect("returns a sorted, de-duplicated selection and honours the excludes", () =>
    Effect.gen(function* () {
      const project = yield* expectSuccess(
        resolveConfig({ source: "difmp.config.ts", config: { exclude: ["**/bad-*.e2e.md"] } }),
      );
      const found = yield* expectSuccess(
        discoverSpecs({ cwd: fixturePath("."), config: project.config }),
      );
      const names = found.map((f) => f.split("/").pop());
      expect(names).toEqual([...names].toSorted());
      expect(names).toContain("project-create.e2e.md");
      expect(names).not.toContain("bad-version.e2e.md");
    }),
  );
});
