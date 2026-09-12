import { Effect } from "effect"
import { isAbsolute, relative, resolve } from "node:path"
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

/** Glob syntax is always `/`-separated, whatever the platform's own separator is. */
const posix = (p: string): string => p.split("\\").join("/")

/** The literal directory prefix of a pattern: everything before its first magic segment. */
const baseOf = (pattern: string): string => {
  const parts = pattern.split("/")
  const magic = parts.findIndex((part) => isDynamicPattern(part))
  const statics = magic === -1 ? parts.slice(0, -1) : parts.slice(0, magic)
  return statics.join("/") || "/"
}

const commonBase = (paths: ReadonlyArray<string>): string => {
  if (paths.length === 0) return "/"
  let common = paths[0]!.split("/")
  for (const path of paths.slice(1)) {
    const parts = path.split("/")
    let i = 0
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++
    common = common.slice(0, i)
  }
  return common.join("/") || "/"
}

/**
 * Resolve the selection of `*.e2e.md` files. The result is SORTED so a run is reproducible.
 * Selecting nothing is the caller's decision to report — never a silent success.
 *
 * Patterns are globbed from the deepest directory that contains all of them rather than from
 * `cwd`. That matters because `ignore` entries are matched against paths RELATIVE to the glob's
 * cwd, and a `**\/…` ignore never matches a path that starts with `../`: an `include` reaching
 * outside the config directory (`../scenarios/**` — normal when the config and the specs are
 * sibling directories) would otherwise silently lose `**\/node_modules\/**` and the rest of the
 * mandatory excludes.
 */
export const discoverSpecs = (options: DiscoverOptions): Effect.Effect<ReadonlyArray<string>, SpecError> =>
  Effect.tryPromise({
    try: async () => {
      const requested = options.patterns ?? []
      const literals = requested.filter(isLiteralPath)
      const globs = requested.filter((p) => !isLiteralPath(p))
      // Naming ONE file on the command line is an unambiguous instruction, so it is not filtered
      // by `exclude`; a glob or a directory still is, otherwise `difmp run .` would walk
      // node_modules. This is what makes `difmp run examples/scenarios/invalid/x.e2e.md`
      // reach the loader (and be rejected by it) rather than silently select nothing.
      const namedFiles = literals.filter((p) => p.endsWith(".e2e.md"))
      const searched = requested.length === 0
        ? [...options.config.include]
        : [...globs, ...literals.filter((p) => !p.endsWith(".e2e.md")).map((p) => `${p}/**/*.e2e.md`)]

      const absolute = (pattern: string): string =>
        posix(isAbsolute(pattern) ? pattern : resolve(options.cwd, pattern))

      const shared = {
        absolute: true,
        dot: false,
        onlyFiles: true,
        // The default (`true`) would silently turn `foo.e2e.md` into `foo.e2e.md/**/*`.
        expandDirectories: false,
        followSymbolicLinks: false
      } as const

      const runSearch = async (): Promise<ReadonlyArray<string>> => {
        if (searched.length === 0) return []
        const absolutePatterns = searched.map(absolute)
        const base = commonBase(absolutePatterns.map(baseOf))
        return glob(
          absolutePatterns.map((p) => posix(relative(base, p))),
          { ...shared, cwd: base, ignore: [...options.config.exclude] }
        )
      }
      const runNamed = async (): Promise<ReadonlyArray<string>> =>
        namedFiles.length === 0 ? [] : glob(namedFiles.map(absolute), { ...shared, cwd: options.cwd })

      const [searchedFiles, explicitFiles] = await Promise.all([runSearch(), runNamed()])
      return [...new Set([...searchedFiles, ...explicitFiles].map((f) => resolve(f)))].sort()
    },
    catch: (cause) =>
      new SpecError({
        specPath: options.cwd,
        reason: `spec discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`
      })
  })
