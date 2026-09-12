import { NodeFileSystem, NodePath } from "@effect/platform-node"
import type { ReportOutput } from "@difmp/core"
import { Reporter } from "@difmp/core"
import { Effect, Layer } from "effect"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Browser, Page } from "playwright"
import { chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { renderJUnitReport } from "../src/junit.js"
import { fileReporterLayer } from "../src/reporter.js"
import type { FixtureName } from "./fixtures.js"
import { fixtureNames, loadFixture } from "./fixtures.js"

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

interface Rendered {
  readonly outputs: ReadonlyArray<ReportOutput>
  readonly reportPath: string
  readonly junitPath: string
  readonly root: string
}

/** Write the three outputs through the real `Reporter` layer, exactly as the CLI would. */
const renderToDisk = (name: FixtureName, outputDir: string): Promise<Rendered> => {
  const input = loadFixture(name, outputDir)
  // Present artifacts must resolve as relative links from the report, so materialise them.
  for (const artifact of input.inventory.artifacts) {
    if (artifact.state !== "present" || artifact.path === undefined) continue
    const target = join(input.layout.root, artifact.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `contenu de démonstration pour ${artifact.artifactId}\n`)
  }
  return Effect.gen(function*() {
    const reporter = yield* Reporter
    const outputs = yield* reporter.report(input)
    return {
      outputs,
      reportPath: input.layout.report,
      junitPath: input.layout.junit,
      root: input.layout.root
    }
  }).pipe(
    Effect.provide(fileReporterLayer().pipe(Layer.provide(platform))),
    Effect.runPromise
  )
}

let browser: Browser
let outputDir: string

beforeAll(async () => {
  outputDir = mkdtempSync(join(tmpdir(), "difmp-report-"))
  browser = await chromium.launch()
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

describe.each(fixtureNames)("standalone report for %s", (name: FixtureName) => {
  let page: Page
  let rendered: Rendered
  const requests: Array<string> = []

  beforeAll(async () => {
    rendered = await renderToDisk(name, outputDir)
    page = await browser.newPage()
    page.on("request", (request) => requests.push(request.url()))
    await page.goto(pathToFileURL(rendered.reportPath).href)
  }, 60_000)

  it("writes the three documented files", () => {
    expect(rendered.outputs.map((o) => o.kind)).toEqual(["json", "junit", "html"])
    expect(rendered.outputs.every((o) => o.path !== undefined)).toBe(true)
  })

  it("opens from file:// and fetches nothing over the network", () => {
    expect(requests.every((url) => url.startsWith("file://"))).toBe(true)
  })

  it("renders the verdict", async () => {
    const view = loadFixture(name, outputDir)
    const banner = await page.locator("#verdict").innerText()
    expect(banner).toContain(view.result.scenarioId)
    expect(await page.locator("#verdict .big").first().innerText()).not.toBe("")
  })

  it("renders every criterion with its status and its method", async () => {
    const input = loadFixture(name, outputDir)
    const evaluations = await page.locator("#evaluations").innerText()
    for (const criterion of input.contract?.criteria ?? []) {
      expect(evaluations).toContain(criterion.id)
      expect(evaluations).toContain(`méthode ${criterion.method}`)
      expect(evaluations).toContain(criterion.text)
    }
  })

  it("states that a model evaluation is probabilistic, and only for model criteria", async () => {
    const input = loadFixture(name, outputDir)
    const notes = await page.locator("#evaluations .note").allInnerTexts()
    const probabilistic = notes.filter((n) => n.includes("probabiliste"))
    const deterministic = notes.filter((n) => n.includes("déterministe") && !n.includes("probabiliste"))
    const criteria = input.contract?.criteria ?? []
    expect(probabilistic.length).toBeGreaterThanOrEqual(criteria.filter((c) => c.method === "model").length)
    expect(deterministic.length).toBeGreaterThanOrEqual(criteria.filter((c) => c.method === "code").length)
  })

  it("keeps budgets and the indicative action threshold apart", async () => {
    const section = await page.locator("#comptes").innerText()
    expect(section).toContain("Budgets bloquants")
    expect(section).toContain("indicatives")
    // `th` is uppercased by the stylesheet, so compare case-insensitively.
    expect(section.toLowerCase()).toContain("consommé")
    expect(section.toLowerCase()).toContain("restant")
    const budgetTableText = await page.locator("#comptes table").first().innerText()
    expect(budgetTableText).not.toContain("indicatives")
  })

  it("lists artifacts, including missing ones with their reason", async () => {
    const input = loadFixture(name, outputDir)
    const section = await page.locator("#artefacts").innerText()
    for (const artifact of input.inventory.artifacts) {
      expect(section).toContain(artifact.artifactId)
      if (artifact.reason !== undefined) expect(section).toContain(artifact.reason.slice(0, 40))
    }
  })

  it("links artifacts as relative paths that resolve next to the report", async () => {
    const input = loadFixture(name, outputDir)
    const linkable = input.inventory.artifacts.filter((a) => a.state === "present" && a.path !== undefined)
    const hrefs = await page.locator("#artefacts a").evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLAnchorElement).getAttribute("href") ?? "")
    )
    expect(hrefs.length).toBe(linkable.length)
    if (linkable.length === 0) return
    for (const href of hrefs) {
      expect(href.startsWith("/")).toBe(false)
      expect(href).not.toMatch(/^[a-z]+:/i)
      expect(readFileSync(join(rendered.root, decodeURIComponent(href)), "utf8")).toContain("démonstration")
    }
  })

  it("shows the timeline of actions, observations, verifications and errors", async () => {
    const input = loadFixture(name, outputDir)
    const rows = await page.locator("#faits tbody tr").count()
    expect(rows).toBe(input.events.length)
  })

  it("separates factual observations, expectations, evaluations and diagnostic hypotheses", async () => {
    for (const id of ["#attentes", "#evaluations", "#faits", "#diagnostics"]) {
      expect(await page.locator(id).count()).toBe(1)
    }
  })

  it("carries an inert, parseable data island rather than executable state", async () => {
    const scripts = await page.locator("script").evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLScriptElement).type)
    )
    expect(scripts).toEqual(["application/json"])
    const parsed = await page.evaluate(() =>
      JSON.parse(document.getElementById("harness-report-data")!.textContent!) as { runId: string }
    )
    expect(parsed.runId).toBe(rendered.root.split("/").pop())
  })

  it("produces JUnit XML that parses back with no error", async () => {
    const xml = readFileSync(rendered.junitPath, "utf8")
    expect(xml).toBe(renderJUnitReport(loadFixture(name, outputDir)))
    const parsed = await page.evaluate((source) => {
      const doc = new DOMParser().parseFromString(source, "application/xml")
      const error = doc.querySelector("parsererror")
      return {
        parserError: error === null ? null : error.textContent,
        root: doc.documentElement.tagName,
        suites: doc.querySelectorAll("testsuite").length,
        cases: doc.querySelectorAll("testcase").length,
        failures: doc.querySelectorAll("failure").length,
        errors: doc.querySelectorAll("error").length,
        skipped: doc.querySelectorAll("skipped").length,
        declaredFailures: doc.documentElement.getAttribute("failures"),
        declaredErrors: doc.documentElement.getAttribute("errors")
      }
    }, xml)
    expect(parsed.parserError).toBeNull()
    expect(parsed.root).toBe("testsuites")
    expect(parsed.suites).toBe(1)
    expect(parsed.skipped).toBe(0)
    expect(String(parsed.failures)).toBe(parsed.declaredFailures)
    expect(String(parsed.errors)).toBe(parsed.declaredErrors)
  })
})

describe("hostile content in the report", () => {
  let page: Page
  const requests: Array<string> = []

  beforeAll(async () => {
    const rendered = await renderToDisk("error", outputDir)
    page = await browser.newPage()
    page.on("request", (request) => requests.push(request.url()))
    await page.goto(pathToFileURL(rendered.reportPath).href)
  }, 60_000)

  it("does not execute the payload hidden in the project name or in the model message", async () => {
    const state = await page.evaluate(() => ({
      title: document.title,
      injectedScripts: document.querySelectorAll("script:not([type='application/json'])").length,
      handlers: document.querySelectorAll("[onerror], [onload], [onclick]").length,
      images: document.querySelectorAll("img").length,
      svg: document.querySelectorAll("svg").length,
      pwned: "__pwned" in window
    }))
    expect(state.title).not.toContain("PWNED")
    expect(state.injectedScripts).toBe(0)
    expect(state.handlers).toBe(0)
    expect(state.images).toBe(0)
    expect(state.svg).toBe(0)
    expect(state.pwned).toBe(false)
  })

  it("shows the payload as literal text instead", async () => {
    const body = await page.locator("body").innerText()
    expect(body).toContain(`<img src=x onerror="document.title='PWNED-NAME'">`)
    expect(body).toContain(`<script>document.title='PWNED-MODEL'</script>`)
  })

  it("still loads nothing from the network", () => {
    expect(requests.every((url) => url.startsWith("file://"))).toBe(true)
  })
})
