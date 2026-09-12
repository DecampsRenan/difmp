import { Effect } from "effect"
import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, parse, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { UsageError } from "./errors.js"

const extensions: ReadonlyArray<string> = ["ts", "mts", "mjs", "js"]

/**
 * `.mts`/`.js`/`.mjs` are accepted alongside `.ts` so a JS-only project is not forced into
 * TypeScript.
 */
export const configBaseNames: ReadonlyArray<string> = ["difmp.config"]

/** Discovery order: `.ts` first. */
export const configFileNames: ReadonlyArray<string> = configBaseNames.flatMap((base) =>
  extensions.map((ext) => `${base}.${ext}`)
)

const isTs = (p: string): boolean => /\.(m|c)?ts$/.test(p)

/**
 * tsx transpiles ESM->CJS when the consumer package is CJS, producing
 * `{ default: { default: cfg, __esModule: true } }`. Unwrap exactly that shape (api-tooling.md §3.1).
 */
const pickDefault = (mod: Record<string, unknown>): unknown => {
  const d = mod["default"]
  if (d !== null && typeof d === "object" && (d as { __esModule?: unknown })["__esModule"] === true) {
    return (d as { default?: unknown })["default"]
  }
  return d
}

/**
 * Load the consumer's config module as TRUSTED project code. Bare `import()` first (Node >= 22.18
 * strips types natively and it costs nothing), falling back to tsx's `tsImport`, which also covers
 * non-erasable TypeScript and CommonJS-typed consumers.
 */
export const importConfigModule = async (absPath: string): Promise<unknown> => {
  const url = pathToFileURL(absPath).href
  let mod: Record<string, unknown>
  try {
    mod = (await import(url)) as Record<string, unknown>
  } catch (err) {
    if (!isTs(absPath)) throw err
    const { tsImport } = await import("tsx/esm/api")
    mod = (await tsImport(url, import.meta.url)) as Record<string, unknown>
  }
  const cfg = pickDefault(mod)
  if (cfg === undefined) {
    throw new Error(`${absPath}: no default export — a difmp config must \`export default defineConfig({...})\``)
  }
  return cfg
}

/** Walk up from `cwd` looking for a config file. Returns `undefined` when the project has none. */
export const findConfigUpwards = (cwd: string): string | undefined => {
  const root = parse(resolve(cwd)).root
  let dir = resolve(cwd)
  for (;;) {
    for (const name of configFileNames) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    if (dir === root) return undefined
    dir = dirname(dir)
  }
}

export interface ConfigLocation {
  /** Absolute path, or `undefined` when the project has no config file and defaults apply. */
  readonly path?: string
  /** Directory the configured `include`/`exclude` patterns are resolved against. */
  readonly root: string
  /** What `manifest.json` and every error message call this configuration. */
  readonly source: string
}

/**
 * The config path comes from `--config` or an upward lookup from cwd — NEVER from a name inside a
 * spec.
 */
export const locateConfig = (options: {
  readonly cwd: string
  readonly explicit?: string
}): Effect.Effect<ConfigLocation, UsageError> =>
  Effect.suspend(() => {
    if (options.explicit !== undefined) {
      const path = isAbsolute(options.explicit) ? options.explicit : resolve(options.cwd, options.explicit)
      if (!existsSync(path)) {
        return Effect.fail(new UsageError({ message: `--config ${options.explicit}: no such file (${path})` }))
      }
      return Effect.succeed({ path, root: dirname(path), source: path })
    }
    const found = findConfigUpwards(options.cwd)
    return Effect.succeed(
      found === undefined
        ? { root: resolve(options.cwd), source: "<built-in defaults>" }
        : { path: found, root: dirname(found), source: found }
    )
  })

/** Read the default export of the located config, or `{}` when the project has no config file. */
export const readConfigModule = (location: ConfigLocation): Effect.Effect<unknown, UsageError> =>
  location.path === undefined
    ? Effect.succeed({})
    : Effect.tryPromise({
      try: () => importConfigModule(location.path!),
      catch: (cause) =>
        new UsageError({
          message: `${location.source}: could not be loaded — ${cause instanceof Error ? cause.message : String(cause)}`
        })
    })
