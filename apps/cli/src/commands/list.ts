import { SpecLoader } from "@harness/core"
import { Console, Effect, FileSystem, Option, Path } from "effect"
import type { UsageError } from "../errors.js"
import { loadProject } from "../project.js"
import { selectSpecs } from "../select.js"
import type { SelectFlags } from "./types.js"

/** `harness list` starts NEITHER a model NOR a browser: it only reads spec files. */
export const listHandler = (
  flags: SelectFlags
): Effect.Effect<void, UsageError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const cwd = process.cwd()
    const project = yield* loadProject({
      cwd,
      ...(Option.isSome(flags.config) ? { configPath: flags.config.value } : {})
    })
    const selection = yield* selectSpecs({
      cwd,
      root: project.location.root,
      config: project.config,
      patterns: flags.paths,
      tags: flags.tag,
      source: project.location.source
    }).pipe(Effect.provide(SpecLoader.layer))

    const rows = selection.specs.map((spec, index) => ({
      id: spec.frontmatter.id,
      path: selection.relativePaths[index]!,
      tags: [...(spec.frontmatter.tags ?? [])],
      fixture: spec.frontmatter.fixture ?? null,
      criteria: spec.criteria.length,
      expectations: spec.expectationSource
    }))

    if (flags.json) {
      return yield* Console.log(JSON.stringify({ schemaVersion: 1, scenarios: rows }, null, 2))
    }
    const width = Math.max(...rows.map((r) => r.id.length), 2)
    yield* Console.log(`${rows.length} scenario${rows.length === 1 ? "" : "s"}`)
    for (const row of rows) {
      const tags = row.tags.length === 0 ? "" : `  [${row.tags.join(", ")}]`
      const fixture = row.fixture === null ? "" : `  fixture:${row.fixture}`
      yield* Console.log(
        `  ${row.id.padEnd(width)}  ${row.criteria} criteri${row.criteria === 1 ? "on" : "a"}${tags}${fixture}  ${row.path}`
      )
    }
  })
