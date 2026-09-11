import { Effect, FileSystem } from "effect"
import { existsSync } from "node:fs"
import { extname, join, normalize, resolve, sep } from "node:path"
import { packageRoot } from "../version.js"

/**
 * Assets are resolved from the INSTALLED package (`packageRoot` is computed from
 * `import.meta.url`), never from a workspace path. `apps/ui` builds to `apps/ui/dist`; the CLI
 * build copies that into `assets/ui`. When the built UI is absent the CLI still serves a working
 * dashboard from `assets/dashboard.html`.
 */
export const uiAssetsRoot: string = resolve(packageRoot, "assets", "ui")
export const fallbackDashboard: string = resolve(packageRoot, "assets", "dashboard.html")

export const hasBuiltUi = (): boolean => existsSync(join(uiAssetsRoot, "index.html"))

const mimeTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
}

export const contentTypeOf = (path: string): string =>
  mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream"

/**
 * Map a request path to a file inside `root`, or `undefined` when it escapes. A single-page app
 * route (no extension) falls back to `index.html`.
 */
export const resolveAsset = (root: string, urlPath: string): string | undefined => {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath.split("?")[0] ?? "/")
    } catch {
      return undefined
    }
  })()
  if (decoded === undefined || decoded.includes("\0")) return undefined
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "")
  const candidate = resolve(root, relative === "" ? "index.html" : relative)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (candidate !== root && !candidate.startsWith(prefix)) return undefined
  if (existsSync(candidate)) {
    return extname(candidate) === "" ? join(root, "index.html") : candidate
  }
  // Unknown deep route with no extension: hand the SPA its shell.
  return extname(candidate) === "" ? join(root, "index.html") : undefined
}

/**
 * Read the bytes rather than handing a path to the platform: under yarn PnP the resolved path is
 * inside a zip and is not a real file (api-tooling.md §4.4).
 */
export const readAsset = (path: string): Effect.Effect<Uint8Array, string, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFile(path).pipe(Effect.mapError((cause) => cause.message))
  })
