import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { allOutput, exec, execInterrupted, fixture, startPage } from "./helpers.js"

const project = fixture("project")

let page: { url: string; close: () => Promise<void> }
let output: string

beforeAll(async () => {
  page = await startPage()
  output = mkdtempSync(join(tmpdir(), "difmp-runs-"))
})

afterAll(async () => {
  await page.close()
  rmSync(output, { recursive: true, force: true })
})

interface Contract {
  readonly id: string
  readonly inputs: Record<string, string | number | boolean>
  readonly criteria: ReadonlyArray<{ id: string; text: string; sourceText: string }>
}

const latestRunDir = (dir: string): string => {
  const runs = readdirSync(dir).filter((entry) => entry.startsWith("r_")).sort()
  const last = runs[runs.length - 1]
  if (last === undefined) throw new Error(`no run directory under ${dir}`)
  return join(dir, last)
}

/** Read back what was PERSISTED, which is the only thing a report is allowed to depend on. */
const latestContract = (dir: string): Contract =>
  JSON.parse(readFileSync(join(latestRunDir(dir), "contract.json"), "utf8")) as Contract

const runAlpha = (args: ReadonlyArray<string>, dir: string) =>
  exec(["run", "tests/alpha.e2e.md", "--base-url", page.url, "--output", dir, ...args], { cwd: project })

describe("input precedence, end to end through the CLI", () => {
  it("config < spec: the spec's own value wins over the project default", async () => {
    const dir = join(output, "a")
    const result = await runAlpha([], dir)
    expect(result.code, allOutput(result)).toBe(0)
    const contract = latestContract(dir)
    expect(contract.inputs["projectName"]).toBe("from-spec")
    // Declared only in the config, and a JSON number stays a number.
    expect(contract.inputs["fromConfigOnly"]).toBe("cfg")
    expect(contract.inputs["retries"]).toBe(1)
    expect(contract.criteria[0]!.text).toBe("Le projet from-spec est visible, source cfg, retries 1.")
    // The frozen contract keeps the pre-interpolation source verbatim.
    expect(contract.criteria[0]!.sourceText).toContain("{{ projectName }}")
  })

  it("spec < --inputs-file, and --inputs-file preserves JSON types", async () => {
    const dir = join(output, "b")
    const file = join(output, "inputs.json")
    writeFileSync(file, JSON.stringify({ projectName: "from-file", retries: 7 }), "utf8")
    const result = await runAlpha(["--inputs-file", file], dir)
    expect(result.code, allOutput(result)).toBe(0)
    const contract = latestContract(dir)
    expect(contract.inputs["projectName"]).toBe("from-file")
    expect(contract.inputs["retries"]).toBe(7)
    expect(contract.criteria[0]!.text).toBe("Le projet from-file est visible, source cfg, retries 7.")
  })

  it("--inputs-file < --input, and --input always yields a string", async () => {
    const dir = join(output, "c")
    const file = join(output, "inputs.json")
    writeFileSync(file, JSON.stringify({ projectName: "from-file", retries: 7 }), "utf8")
    const result = await runAlpha(
      ["--inputs-file", file, "--input", "projectName=from-cli", "-i", "retries=9"],
      dir
    )
    expect(result.code, allOutput(result)).toBe(0)
    const contract = latestContract(dir)
    expect(contract.inputs["projectName"]).toBe("from-cli")
    expect(contract.inputs["retries"]).toBe("9")
    expect(contract.criteria[0]!.text).toBe("Le projet from-cli est visible, source cfg, retries 9.")
  })

  it("rejects a CLI input key that neither the config nor the spec declares", async () => {
    const dir = join(output, "d")
    const result = await runAlpha(["--input", "bogus=1"], dir)
    // An undeclared input is an execution error for the run: exit 2, never a silent pass.
    expect(result.code).toBe(2)
    expect(allOutput(result)).toContain("bogus")
  })
})

describe("exit codes from real runs", () => {
  it("0 when every selected scenario passes", async () => {
    const result = await runAlpha([], join(output, "e"))
    expect(result.code, allOutput(result)).toBe(0)
    expect(allOutput(result)).toContain("PASS  alpha")
    expect(allOutput(result)).toContain("1 passed")
  })

  it("1 when a criterion fails", async () => {
    const result = await runAlpha(["--config", "difmp.failed.config.ts"], join(output, "f"))
    expect(result.code).toBe(1)
    expect(allOutput(result)).toContain("FAIL  alpha")
    expect(allOutput(result)).toContain("1 failed")
  })

  it("1 when a criterion is inconclusive — never a green skip", async () => {
    const result = await runAlpha(["--config", "difmp.inconclusive.config.ts"], join(output, "g"))
    expect(result.code).toBe(1)
    expect(allOutput(result)).toContain("INCO  alpha")
    expect(allOutput(result)).toContain("1 inconclusive")
  })
})

describe("console and json reporters", () => {
  it("prints the resolved configuration, the durations and the report path", async () => {
    const dir = join(output, "h")
    const result = await runAlpha([], dir)
    expect(result.code, allOutput(result)).toBe(0)
    const text = result.stdout.join("\n")
    expect(text).toContain("Resolved configuration")
    expect(text).toContain("maxActions      25 (indicative only)")
    expect(text).toMatch(/PASS {2}alpha {2}\d+(\.\d+)?(ms|s)/)
    expect(text).toContain("actions 2/25 indicatives")
    expect(text).toContain("report.html")
    expect(text).toContain("Summary  1 scenario")
    // Non-TTY output is plain text: no ANSI escape sequences, no spinner frames.
    expect(text.includes("")).toBe(false)
  })

  it("--reporter json keeps stdout machine-parseable and moves diagnostics to stderr", async () => {
    const dir = join(output, "i")
    const result = await exec(
      ["run", "tests/alpha.e2e.md", "--base-url", page.url, "--output", dir, "--reporter", "json"],
      { cwd: project }
    )
    expect(result.code, allOutput(result)).toBe(0)
    const parsed = JSON.parse(result.stdout.join("\n")) as {
      schemaVersion: number
      summary: { total: number; passed: number }
      runs: ReadonlyArray<{ report: string; result: { status: string }; model: { adapterId: string } }>
    }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.summary).toMatchObject({ total: 1, passed: 1 })
    expect(parsed.runs[0]!.result.status).toBe("passed")
    // A scripted run is never presentable as a model validation.
    expect(parsed.runs[0]!.model.adapterId).toContain("scripted")
    expect(result.stderr.join("\n")).toContain("Resolved configuration")
  })
})

describe("difmp report", () => {
  it("rebuilds the HTML from persisted data, with no model call and no replay", async () => {
    const dir = join(output, "j")
    const run = await runAlpha([], dir)
    expect(run.code, allOutput(run)).toBe(0)
    const runDir = latestRunDir(dir)
    rmSync(join(runDir, "report.html"))

    const result = await exec(["report", runDir], { cwd: project })
    expect(result.code, allOutput(result)).toBe(0)
    const html = readFileSync(join(runDir, "report.html"), "utf8")
    expect(html).toContain("alpha")
    expect(allOutput(result)).toContain("PASS  alpha")
  })
})

const freePort = async (): Promise<number> => {
  const probe = await startPage()
  const port = Number(new URL(probe.url).port)
  await probe.close()
  return port
}

/** Read every SSE frame until the server closes the stream. */
const drainEvents = async (url: string, timeoutMs: number): Promise<ReadonlyArray<{ id: number; event: string }>> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const frames: Array<{ id: number; event: string }> = []
  try {
    const response = await fetch(url, { signal: controller.signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const lines = buffer.slice(0, boundary).split("\n")
        buffer = buffer.slice(boundary + 2)
        frames.push({
          id: Number(lines.find((l) => l.startsWith("id: "))!.slice(4)),
          event: lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message"
        })
        boundary = buffer.indexOf("\n\n")
      }
    }
  } catch {
    // The stream ends when the CLI shuts the server down; whatever arrived is what we assert on.
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return frames
}

describe("live dashboard (--ui)", () => {
  it("serves the dashboard while the run progresses, and the run still finishes", async () => {
    const dir = join(output, "ui")
    const port = await freePort()
    const invocation = exec(
      [
        "run",
        "tests/alpha.e2e.md",
        "--base-url",
        page.url,
        "--output",
        dir,
        "--ui",
        "--ui-port",
        String(port)
      ],
      { cwd: project }
    )

    // Wait for the server, then attach mid-run.
    let state: { lastEventId: number } | undefined
    for (let attempt = 0; attempt < 100 && state === undefined; attempt++) {
      try {
        state = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as { lastEventId: number }
      } catch {
        await new Promise((done) => setTimeout(done, 50))
      }
    }
    expect(state).toBeDefined()

    // The served page carries the endpoint overrides `apps/ui/src/runtime/config.ts` reads.
    const shell = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    expect(shell).toContain("__DIFMP_UI__")
    expect(shell).toContain("/api/ui/events")

    const [frames, uiFrames] = await Promise.all([
      drainEvents(`http://127.0.0.1:${port}/api/events`, 30_000),
      drainEvents(`http://127.0.0.1:${port}/api/ui/events`, 30_000)
    ])
    const result = await invocation

    expect(result.code, allOutput(result)).toBe(0)
    expect(result.stdout.join("\n")).toContain(`Live dashboard  http://127.0.0.1:${port}/`)
    // The ids the dashboard saw are contiguous and in order.
    expect(frames.length).toBeGreaterThan(3)
    expect(frames.map((f) => f.id)).toEqual(frames.map((_, i) => i + 1))
    expect(frames.map((f) => f.event)).toContain("harness")
    expect(frames.map((f) => f.event)).toContain("scenarioFinished")

    // The UI stream is raw HarnessEvents: frames named after the event type, ids = the run's seq.
    expect(uiFrames.map((f) => f.id)).toEqual(uiFrames.map((_, i) => i + 1))
    expect(uiFrames[0]!.event).toBe("runStarted")
    expect(uiFrames.map((f) => f.event)).toContain("runFinished")
  })

  it("runs with no dashboard attached at all", async () => {
    const dir = join(output, "ui-none")
    const port = await freePort()
    const result = await exec(
      ["run", "tests/alpha.e2e.md", "--base-url", page.url, "--output", dir, "--ui", "--ui-port", String(port)],
      { cwd: project }
    )
    expect(result.code, allOutput(result)).toBe(0)
    expect(allOutput(result)).toContain("PASS  alpha")
  })
})

/**
 * design-contracts §11 and §13. A fixture learns a credential through `ctx.secrets`; that call is
 * the ONLY way the harness finds out a value is secret, so the `FixtureManager` must report what
 * was read (`FixtureSession.secretValues`) or the runner's redactor stays the identity function.
 * It did: a secret read through `ctx.secrets` and handed back under `public` used to land verbatim
 * in contract.json, events.jsonl, result.json, junit.xml and report.html.
 */
describe("a secret a fixture read is stripped from everything the run writes", () => {
  const leaky = fixture("secret-fixture")
  const secret = "sk-test-DO-NOT-PERSIST-7f3a"

  it("redacts it from the contract, the journal, the result and both reports", async () => {
    const dir = join(output, "secret-fixture")
    const previous = process.env["DIFMP_TEST_SECRET"]
    process.env["DIFMP_TEST_SECRET"] = secret
    try {
      const result = await exec(["run", "--base-url", page.url, "--output", dir], { cwd: leaky })
      expect(result.code, allOutput(result)).toBe(0)
      const runDir = latestRunDir(dir)
      for (const file of ["contract.json", "events.jsonl", "result.json", "junit.xml", "report.html", "manifest.json"]) {
        const content = readFileSync(join(runDir, file), "utf8")
        expect(content, `${file} leaked the fixture secret`).not.toContain(secret)
      }
      // The redactor strips the VALUE it was told about and nothing else: a public value that was
      // never read through `ctx.secrets` is untouched, and the key itself still appears.
      const contract = readFileSync(join(runDir, "contract.json"), "utf8")
      expect(contract).toContain("public-value")
      expect(contract).toContain("[redacted]")
      expect(allOutput(result)).not.toContain(secret)
    } finally {
      if (previous === undefined) delete process.env["DIFMP_TEST_SECRET"]
      else process.env["DIFMP_TEST_SECRET"] = previous
    }
  })
})

/**
 * spec §6 step 2 + integration.md §5: the initial manifest is persisted before the fixture runs,
 * so a run that dies in infrastructure setup is still reportable. CI must get a JUnit file naming
 * the failure rather than an empty run directory.
 */
describe("a run that fails before the contract is frozen is still reported", () => {
  const failing = fixture("setup-failure")

  it("writes manifest.json, junit.xml and report.html, and exits 2", async () => {
    const dir = join(output, "setup-failure")
    const result = await exec(["run", "--base-url", page.url, "--output", dir], { cwd: failing })
    expect(result.code, allOutput(result)).toBe(2)

    const runDir = latestRunDir(dir)
    const files = readdirSync(runDir)
    expect(files).toContain("manifest.json")
    expect(files).toContain("junit.xml")
    expect(files).toContain("report.html")
    // Nothing was frozen, so there is no contract — and that absence is the information.
    expect(files).not.toContain("contract.json")

    const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as {
      stage: string
      scenarioId: string
      hashes?: unknown
      model: { adapterId: string }
    }
    expect(manifest.stage).toBe("initial")
    expect(manifest.hashes).toBeUndefined()
    expect(manifest.scenarioId).toBe("setup-failure")
    expect(manifest.model.adapterId).toBe("scripted")

    const junit = readFileSync(join(runDir, "junit.xml"), "utf8")
    expect(junit).toContain('tests="1"')
    expect(junit).toContain('errors="1"')
    expect(junit).not.toContain("<skipped")
    expect(junit).toContain("HTTP 503")
    expect(junit).toContain('<property name="harness.adapter" value="scripted"/>')

    const html = readFileSync(join(runDir, "report.html"), "utf8")
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("jamais été gelé")
  })

  it("replays the same outputs through `difmp report <run-directory>`", async () => {
    const dir = join(output, "setup-failure-replay")
    expect((await exec(["run", "--base-url", page.url, "--output", dir], { cwd: failing })).code).toBe(2)
    const runDir = latestRunDir(dir)
    rmSync(join(runDir, "junit.xml"))
    rmSync(join(runDir, "report.html"))
    const replay = await exec(["report", runDir], { cwd: failing })
    expect(replay.code, allOutput(replay)).toBe(0)
    expect(readdirSync(runDir)).toEqual(expect.arrayContaining(["junit.xml", "report.html"]))
  })
})

/**
 * audit §4.6: the run itself already settled correctly under Ctrl-C (`result.json` says
 * `cancelled`, `runFinished` is last, exit 130) but the SIGINT interrupt reached the CLI before the
 * file reporters ran, so an interrupted run left CI without a JUnit file — while the dashboard's
 * Cancel button, which is a cooperative Deferred rather than a fiber interrupt, wrote both. The two
 * cancellation routes must leave the same run directory behind.
 */
describe("a run interrupted by Ctrl-C", () => {
  it("still writes result.json, junit.xml and report.html, and exits 130", async () => {
    const dir = join(output, "sigint")
    // Interrupt only once the run is genuinely under way: the contract is frozen, the run
    // directory exists, and the attempt is opening the browser.
    const underWay = () => {
      try {
        const runs = readdirSync(dir).filter((entry) => entry.startsWith("r_")).sort()
        const last = runs[runs.length - 1]
        if (last === undefined) return false
        return readFileSync(join(dir, last, "events.jsonl"), "utf8").includes("contractFrozen")
      } catch {
        return false
      }
    }
    const result = await execInterrupted(
      ["run", "tests/alpha.e2e.md", "--base-url", page.url, "--output", dir],
      { cwd: project, ready: underWay }
    )
    expect(result.code, allOutput(result)).toBe(130)

    const runDir = latestRunDir(dir)
    const files = readdirSync(runDir)
    expect(files).toContain("result.json")
    expect(files).toContain("junit.xml")
    expect(files).toContain("report.html")

    const persisted = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as { status: string }
    expect(persisted.status).toBe("cancelled")
    // §12: a cancelled run is an `<error type="run-cancelled">`, never a silent `<skipped>`.
    const junit = readFileSync(join(runDir, "junit.xml"), "utf8")
    expect(junit).toContain('type="run-cancelled"')
    expect(junit).not.toContain("<skipped")
    expect(readFileSync(join(runDir, "report.html"), "utf8").startsWith("<!doctype html>")).toBe(true)
  })
})
