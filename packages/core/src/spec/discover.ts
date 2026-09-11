import { Effect } from "effect"
import { resolve } from "node:path"
import { glob, isDynamicPattern } from "tinyglobby"
import type { ResolvedConfig } from "../domain/config.js"
import { SpecError } from "../domain/errors.js"

export const isLiteralPath = (arg: string): boolean => !isDynamicPattern(arg)

export interface DiscoverOptions {
  readonly cwd: string
  readonly config: ResolvedConfig
  /** CLI arguments: files, directories or globs. Empty means "use the configured `include`". */
  readonly patterns?: ReadonlyArray<string>
}

/**
 * Resolve the selection of `*.e2e.md` files. The result is SORTED so a run is reproducible.
 * Selecting nothing is the caller's decision to report — never a silent success.
 */
export const discoverSpecs = (options: DiscoverOptions): Effect.Effect<ReadonlyArray<string>, SpecError> =>
  Effect.tryPromise({
    try: async () => {
      const requested = options.patterns ?? []
      const literals = requested.filter(isLiteralPath)
      const globs = requested.filter((p) => !isLiteralPath(p))
      const patterns = requested.length === 0
        ? [...options.config.include]
        : [...globs, ...literals.map((p) => (p.endsWith(".e2e.md") ? p : `${p}/**/*.e2e.md`))]

      const files = await glob(patterns, {
        cwd: options.cwd,
        ignore: [...options.config.exclude],
        absolute: true,
        dot: false,
        onlyFiles: true,
        // The default (`true`) would silently turn `foo.e2e.md` into `foo.e2e.md/**/*`.
        expandDirectories: false,
        followSymbolicLinks: false
      })
      return [...new Set(files.map((f) => resolve(f)))].sort()
    },
    catch: (cause) =>
      new SpecError({
        specPath: options.cwd,
        reason: `spec discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`
      })
  })
