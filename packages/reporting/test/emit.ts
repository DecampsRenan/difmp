/**
 * Renders every fixture to a throwaway run directory so the three outputs can be opened by hand:
 *   npx tsx packages/reporting/test/emit.ts /tmp/harness-samples
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { renderHtmlReport } from "../src/html.js"
import { renderJsonReport } from "../src/json.js"
import { renderJUnitReport } from "../src/junit.js"
import { fixtureNames, loadFixture } from "./fixtures.js"

const out = process.argv[2]!
for (const name of fixtureNames) {
  const input = loadFixture(name, out)
  const write = (file: string, content: string) => {
    const target = join(input.layout.root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  for (const artifact of input.inventory.artifacts) {
    if (artifact.state === "present" && artifact.path !== undefined) {
      write(artifact.path, `contenu de démonstration pour ${artifact.artifactId}\n`)
    }
  }
  write("result.json", renderJsonReport(input))
  write("junit.xml", renderJUnitReport(input))
  write("report.html", renderHtmlReport(input))
  console.log(`${name} -> ${input.layout.root}`)
}
