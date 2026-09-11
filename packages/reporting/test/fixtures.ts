import type { ReportInput } from "@harness/core"
import {
  ArtifactInventory,
  decodeStrictSync,
  HarnessEvent,
  makeRunLayout,
  Manifest,
  RunResult,
  ScenarioContract,
  scanJsonl
} from "@harness/core"
import { NodePath } from "@effect/platform-node"
import { Effect, Path } from "effect"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

/** Fixture names, one directory each, all hand-written JSON decoded through core's schemas. */
export const fixtureNames = ["passed", "failed-persistence", "inconclusive", "error"] as const
export type FixtureName = typeof fixtureNames[number]

const nodePath: Path.Path = Effect.runSync(
  Effect.provide(Effect.gen(function*() {
    return yield* Path.Path
  }), NodePath.layer)
)

const read = (name: FixtureName, file: string): string => readFileSync(join(here, "fixtures", name, file), "utf8")

const decodeManifest = decodeStrictSync(Manifest)
const decodeContract = decodeStrictSync(ScenarioContract)
const decodeResult = decodeStrictSync(RunResult)
const decodeInventory = decodeStrictSync(ArtifactInventory)
const decodeEvent = decodeStrictSync(HarnessEvent)

/**
 * Build a `ReportInput` the way `harness report <run-directory>` does: persisted files only,
 * every one of them validated against the schema that owns it.
 */
export const loadFixture = (name: FixtureName, outputDir = join(here, "fixtures")): ReportInput => {
  const manifest = decodeManifest(JSON.parse(read(name, "manifest.json")))
  const contract = decodeContract(JSON.parse(read(name, "contract.json")))
  const result = decodeResult(JSON.parse(read(name, "result.json")))
  const inventory = decodeInventory(JSON.parse(read(name, "artifacts.json")))
  const scan = scanJsonl(read(name, "events.jsonl"))
  const events = scan.records.map((record) => decodeEvent(record))
  const finalized = !scan.truncatedTail && events.some((e) => e.type === "runFinished")
  return {
    layout: makeRunLayout(nodePath, outputDir, manifest.runId),
    manifest,
    contract,
    result,
    inventory,
    events,
    finalized
  }
}
