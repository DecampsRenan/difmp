import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Packaging invariants of the DISTRIBUTED package. Both of these were real, observed breakages of
 * the tarball; neither is visible from a workspace checkout, where every package is symlinked and
 * every peer dependency happens to be installed.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cliRoot = resolve(here, "..")
const repoRoot = resolve(cliRoot, "..", "..")

const pkg = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

/** Source trees whose code ends up INSIDE the published bundle (tsdown `noExternal: [/^@difmp\//]`). */
const bundledSources = [
  join(cliRoot, "src"),
  join(repoRoot, "packages", "core", "src"),
  join(repoRoot, "packages", "browser-playwright", "src"),
  join(repoRoot, "packages", "agent-runtime", "src"),
  join(repoRoot, "packages", "reporting", "src")
]

const tsFiles = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return tsFiles(full)
    return full.endsWith(".ts") ? [full] : []
  })

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g

/** Comments hold prose and doc-comment `import` examples; only real code declares a dependency. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

/** Every bare specifier the bundled sources import, with the file that imports it. */
const bareImports: Array<{ readonly specifier: string; readonly file: string }> = bundledSources
  .flatMap(tsFiles)
  .flatMap((file) => {
    const text = stripComments(readFileSync(file, "utf8"))
    const found: Array<{ specifier: string; file: string }> = []
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1]!
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue
      found.push({ specifier, file: file.slice(repoRoot.length + 1) })
    }
    return found
  })

/** `@scope/name/deep` -> `@scope/name`; `name/deep` -> `name`. */
const packageOf = (specifier: string): string => {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
}

describe("published package.json", () => {
  it("declares no @difmp/* runtime dependency — they are bundled, and exist on no registry", () => {
    // `pnpm pack` rewrites `workspace:*` to `0.1.0`, so a @difmp/* entry in `dependencies` makes
    // the tarball uninstallable: npm would go looking for `@difmp/core@0.1.0` on the registry.
    expect(Object.keys(pkg.dependencies).filter((name) => name.startsWith("@difmp/"))).toEqual([])
  })

  it("keeps the bundled workspace packages as devDependencies", () => {
    for (const name of ["@difmp/core", "@difmp/browser-playwright", "@difmp/agent-runtime", "@difmp/reporting"]) {
      expect(pkg.devDependencies[name], `${name} must stay a devDependency`).toBe("workspace:*")
    }
  })

  it("declares every package the bundle imports at runtime", () => {
    const undeclared = bareImports
      .filter(({ specifier }) => !specifier.startsWith("@difmp/"))
      .filter(({ specifier }) => pkg.dependencies[packageOf(specifier)] === undefined)
      .map(({ file, specifier }) => `${specifier} (${file})`)
    expect([...new Set(undeclared)]).toEqual([])
  })
})

describe("@effect/platform-node is imported by subpath, never through its barrel", () => {
  it("no bundled source imports the barrel", () => {
    // The barrel re-exports `NodeRedis`, which eagerly imports `redis` — a NON-optional peer
    // dependency of @effect/platform-node. npm and pnpm auto-install peers, so the barrel works
    // there by accident; Yarn does not, and the installed CLI died on its first command with
    // `ERR_MODULE_NOT_FOUND: Cannot find package 'redis'`.
    const offenders = bareImports
      .filter(({ specifier }) => specifier === "@effect/platform-node")
      .map(({ file }) => file)
    expect([...new Set(offenders)]).toEqual([])
  })
})
