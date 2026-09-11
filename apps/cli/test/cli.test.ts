import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { allOutput, exec, fixture } from "./helpers.js"

const project = fixture("project")
const badRefs = fixture("bad-refs")
const enumProject = fixture("enum-config")

const empty = mkdtempSync(join(tmpdir(), "harness-empty-"))

afterAll(() => {
  rmSync(empty, { recursive: true, force: true })
})

describe("no spec selected", () => {
  it("is an explicit error with exit 2, never a silent success — run", async () => {
    const result = await exec(["run"], { cwd: empty })
    expect(result.code).toBe(2)
    expect(allOutput(result)).toContain("no *.e2e.md scenario selected")
  })

  it("is an explicit error with exit 2 — list and validate too", async () => {
    for (const command of ["list", "validate"]) {
      const result = await exec([command], { cwd: empty })
      expect(result.code, command).toBe(2)
      expect(allOutput(result)).toContain("no *.e2e.md scenario selected")
    }
  })

  it("reports a glob that matched nothing rather than falling back to the configured include", async () => {
    const result = await exec(["list", "tests/**/*.nope.e2e.md"], { cwd: project })
    expect(result.code).toBe(2)
    expect(allOutput(result)).toContain("no *.e2e.md scenario selected")
    expect(allOutput(result)).toContain("tests/**/*.nope.e2e.md")
  })

  it("reports a --tag that matched nothing, naming the tag", async () => {
    const result = await exec(["list", "--tag", "does-not-exist"], { cwd: project })
    expect(result.code).toBe(2)
    expect(allOutput(result)).toContain("--tag does-not-exist")
    expect(allOutput(result)).toContain("none matched the tag filter")
  })
})

describe("exit-code mapping", () => {
  it("0 for --help and --version", async () => {
    expect((await exec(["--help"], { cwd: project })).code).toBe(0)
    expect((await exec(["--version"], { cwd: project })).code).toBe(0)
    expect((await exec(["run", "--help"], { cwd: project })).code).toBe(0)
  })

  it("2 for an unrecognized flag", async () => {
    const result = await exec(["run", "--nope"], { cwd: project })
    expect(result.code).toBe(2)
    expect(allOutput(result)).toContain("Unrecognized flag: --nope")
  })

  it("2 for a missing required argument", async () => {
    expect((await exec(["report"], { cwd: project })).code).toBe(2)
  })

  it("2 for an unknown --reporter", async () => {
    const result = await exec(["run", "--reporter", "teapot"], { cwd: project })
    expect(result.code).toBe(2)
    expect(allOutput(result)).toContain("unknown reporter")
  })

  it("2 for an invalid configuration (unknown top-level key)", async () => {
    const result = await exec(["list", "--config", "harness.invalid.config.ts"], { cwd: project })
    expect(result.code).toBe(2)
    expect(allOutput(result)).toContain("invalid configuration")
  })

  it("2 for --config pointing at a file that does not exist", async () => {
    const result = await exec(["list", "--config", "nope.config.ts"], { cwd: project })
    expect(result.code).toBe(2)
    expect(allOutput(result)).toContain("no such file")
  })

  it("2 for a run directory that does not exist", async () => {
    const result = await exec(["report", join(project, "runs", "r_does_not_exist")], { cwd: project })
    expect(result.code).toBe(2)
  })
})

describe("config loading", () => {
  it("loads harness.config.ts from an upward lookup and reports the resolved values", async () => {
    const result = await exec(["validate"], { cwd: join(project, "tests", "nested") })
    expect(result.code).toBe(0)
    // The upward lookup found the config two directories above, so the sibling specs are in scope.
    expect(allOutput(result)).toContain("gamma")
  })

  it("loads a TS config that needs a transpiler (non-erasable `enum` -> tsx fallback)", async () => {
    const result = await exec(["list", "--json", "--config", join(enumProject, "harness.config.ts")], {
      cwd: project
    })
    expect(result.code).toBe(2)
    // The enum config selects specs relative to ITS OWN directory, which holds none — the point is
    // that the module loaded at all, which the "no scenario selected" message proves.
    expect(allOutput(result)).toContain("no *.e2e.md scenario selected")
    expect(allOutput(result)).toContain("enum-config")
  })

  it("uses built-in defaults when the project has no config file", async () => {
    const result = await exec(["run"], { cwd: empty })
    expect(result.code).toBe(2)
    expect(allOutput(result)).toContain("<built-in defaults>")
  })
})

describe("validate", () => {
  it("passes on the fixture project and starts neither a model nor a browser", async () => {
    const result = await exec(["validate"], { cwd: project })
    expect(result.code).toBe(0)
    expect(allOutput(result)).toContain("3/3 scenarios valid")
  })

  it("accepts unresolved {{ fixture.* }} but rejects every other unknown variable", async () => {
    const result = await exec(["validate", "--json"], { cwd: badRefs })
    expect(result.code).toBe(2)
    const parsed = JSON.parse(result.stdout.join("\n")) as {
      valid: boolean
      scenarios: ReadonlyArray<{ scenarioId: string; problems: ReadonlyArray<string> }>
    }
    expect(parsed.valid).toBe(false)
    const byId = new Map(parsed.scenarios.map((s) => [s.scenarioId, s.problems]))
    // No setup has run, so fixture values cannot exist yet: `validate` must not complain.
    expect(byId.get("fixture-reference")).toEqual([])
    const unknown = byId.get("unknown-variable") ?? []
    expect(unknown.length).toBeGreaterThan(0)
    expect(unknown.join("\n")).toContain("notDeclared")
    expect(unknown.join("\n")).toContain("alsoNotDeclared")
    // Errors name the file and the line.
    expect(unknown.join("\n")).toMatch(/unknown\.e2e\.md:\d+:\d+/)
  })
})
