import type { LoadedSpec, ResolvedConfig } from "@difmp/core"
import { discoverSpecs, SpecLoader } from "@difmp/core"
import { Effect } from "effect"
import { relative } from "node:path"
import { UsageError } from "./errors.js"

export interface SelectOptions {
  readonly cwd: string
  readonly root: string
  readonly config: ResolvedConfig
  /** Files, directories or globs from argv. Quoted globs arrive here unexpanded, as raw patterns. */
  readonly patterns: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  /** Named in the "no spec selected" message so the user knows which settings were in play. */
  readonly source: string
}

export interface Selection {
  readonly specs: ReadonlyArray<LoadedSpec>
  /** Absolute paths, stably sorted. */
  readonly paths: ReadonlyArray<string>
  /** Paths relative to the config root — what goes into the contract and the reports. */
  readonly relativePaths: ReadonlyArray<string>
}

/**
 * Patterns given on the command line are resolved against the invocation directory (that is where
 * the user typed them); the configured `include` is resolved against the config root.
 */
export const discoverPaths = (options: SelectOptions): Effect.Effect<ReadonlyArray<string>, UsageError> =>
  discoverSpecs({
    cwd: options.patterns.length === 0 ? options.root : options.cwd,
    config: options.config,
    patterns: options.patterns
  }).pipe(Effect.mapError((error) => new UsageError({ message: error.message })))

const matchesTags = (spec: LoadedSpec, tags: ReadonlyArray<string>): boolean =>
  tags.length === 0 || (spec.frontmatter.tags ?? []).some((tag) => tags.includes(tag))

const describe = (options: SelectOptions): string => {
  const where = options.patterns.length === 0
    ? `include ${JSON.stringify(options.config.include)} under ${options.root}`
    : `arguments ${JSON.stringify(options.patterns)} under ${options.cwd}`
  const tags = options.tags.length === 0 ? "" : ` filtered by --tag ${options.tags.join(", ")}`
  return `${where}${tags}`
}

/**
 * Resolve the selection. Discovery is stably sorted by `discoverSpecs`, and the load preserves that
 * order, so two invocations with the same arguments run the same scenarios in the same sequence.
 *
 * **Selecting nothing is an explicit error (exit 2), never a silent success.**
 */
export const selectSpecs = (options: SelectOptions): Effect.Effect<Selection, UsageError, SpecLoader> =>
  Effect.gen(function*() {
    const loader = yield* SpecLoader
    const discovered = yield* discoverPaths(options)
    if (discovered.length === 0) {
      return yield* Effect.fail(
        new UsageError({
          message: `no *.e2e.md scenario selected — ${describe(options)} (config: ${options.source})`
        })
      )
    }
    const loaded = yield* loader.loadAll(discovered).pipe(
      Effect.mapError((error) => new UsageError({ message: error.message }))
    )
    const specs = loaded.filter((spec) => matchesTags(spec, options.tags))
    if (specs.length === 0) {
      return yield* Effect.fail(
        new UsageError({
          message: `no *.e2e.md scenario selected — ${describe(options)} (${discovered.length} discovered, none matched the tag filter)`
        })
      )
    }
    return {
      specs,
      paths: specs.map((s) => s.specPath),
      relativePaths: specs.map((s) => relative(options.root, s.specPath))
    }
  })
