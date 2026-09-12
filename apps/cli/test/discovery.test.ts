import { resolveConfig } from "@difmp/core"
import { Effect } from "effect"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { discoverPaths } from "../src/index.js"
import { exec, fixture } from "./helpers.js"

const project = fixture("project")

/** Decoys that must never be selected, created here so the repository stays clean. */
const decoys = [
  join(project, "node_modules", "ignored.e2e.md"),
  join(project, "dist", "ignored.e2e.md"),
  join(project, "runs", "ignored.e2e.md")
]

const decoyBody = `---
version: 1
id: must-not-be-selected
---

# Decoy

## Expected results

- Never selected.
`

const defaults = Effect.runSync(
  resolveConfig({ source: "test", config: {} }).pipe(Effect.map((p) => p.config))
)

const discover = (patterns: ReadonlyArray<string>, cwd = project) =>
  Effect.runPromise(
    discoverPaths({ cwd, root: project, config: defaults, patterns, tags: [], source: "test" })
  )

describe("spec discovery", () => {
  beforeAll(() => {
    for (const decoy of decoys) {
      mkdirSync(join(decoy, ".."), { recursive: true })
      writeFileSync(decoy, decoyBody, "utf8")
    }
  })
  afterAll(() => {
    for (const dir of ["node_modules", "dist", "runs"]) {
      rmSync(join(project, dir), { recursive: true, force: true })
    }
  })

  it("finds every **/*.e2e.md and excludes node_modules, dist and runs", async () => {
    const found = (await discover([])).map((p) => relative(project, p))
    expect(found).toEqual([
      "tests/alpha.e2e.md",
      "tests/beta.e2e.md",
      "tests/nested/gamma.e2e.md"
    ])
  })

  it("is stably sorted: repeated discovery yields the identical order", async () => {
    const runs = await Promise.all([discover([]), discover([]), discover([])])
    expect(runs[0]).toEqual(runs[1])
    expect(runs[1]).toEqual(runs[2])
    // Sorted, not merely stable.
    expect([...runs[0]!]).toEqual([...runs[0]!].sort())
  })

  it("honours a QUOTED glob passed as an argument (the shell never expanded it)", async () => {
    const found = (await discover(["tests/**/*.e2e.md"])).map((p) => relative(project, p))
    expect(found).toEqual(["tests/alpha.e2e.md", "tests/beta.e2e.md", "tests/nested/gamma.e2e.md"])

    const nestedOnly = (await discover(["tests/nested/*.e2e.md"])).map((p) => relative(project, p))
    expect(nestedOnly).toEqual(["tests/nested/gamma.e2e.md"])

    // A quoted glob that matches nothing must NOT silently fall back to the configured include.
    expect(await discover(["tests/**/*.nope.e2e.md"])).toEqual([])
  })

  it("accepts a literal file and a directory argument", async () => {
    expect((await discover(["tests/beta.e2e.md"])).map((p) => relative(project, p)))
      .toEqual(["tests/beta.e2e.md"])
    expect((await discover(["tests/nested"])).map((p) => relative(project, p)))
      .toEqual(["tests/nested/gamma.e2e.md"])
  })

  it("`difmp list` prints the same stable order and starts no browser", async () => {
    const result = await exec(["list"], { cwd: project })
    expect(result.code).toBe(0)
    const parsed = JSON.parse((await exec(["list", "--json"], { cwd: project })).stdout.join("\n")) as {
      scenarios: ReadonlyArray<{ id: string; path: string }>
    }
    expect(parsed.scenarios.map((s) => s.id)).toEqual(["alpha", "beta", "gamma"])
    expect(parsed.scenarios.map((s) => s.path)).toEqual([
      "tests/alpha.e2e.md",
      "tests/beta.e2e.md",
      "tests/nested/gamma.e2e.md"
    ])
  })

  it("`difmp list --tag` filters, and a quoted glob narrows the selection", async () => {
    const smoke = await exec(["list", "--tag", "smoke"], { cwd: project })
    expect(smoke.code).toBe(0)
    expect(smoke.stdout.join("\n")).toContain("alpha")
    expect(smoke.stdout.join("\n")).toContain("beta")
    expect(smoke.stdout.join("\n")).not.toContain("gamma")

    const glob = await exec(["list", "tests/nested/**/*.e2e.md"], { cwd: project })
    expect(glob.code).toBe(0)
    expect(glob.stdout.join("\n")).toContain("gamma")
    expect(glob.stdout.join("\n")).not.toContain("alpha")
  })
})

/**
 * spec §4: duplicate scenario ids are rejected. The check lives in `SpecLoader.loadAll`, and every
 * command reaches it through `selectSpecs` — this asserts that path end to end rather than the
 * loader in isolation.
 */
describe("duplicate scenario ids", () => {
  const duplicates = fixture("duplicate-ids")

  it("is an explicit error with exit 2 for list, validate and run alike", async () => {
    for (const command of ["list", "validate", "run"]) {
      const result = await exec([command], { cwd: duplicates })
      expect(result.code, `${command}: ${[...result.stdout, ...result.stderr].join("\n")}`).toBe(2)
      expect([...result.stdout, ...result.stderr].join("\n")).toContain("duplicate scenario id")
    }
  })
})
