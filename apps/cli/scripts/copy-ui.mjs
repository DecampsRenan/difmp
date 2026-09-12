// Copy the built live UI (apps/ui/dist) into this package's `assets/ui`, which is what the
// installed CLI serves. Resolved at BUILD time from the workspace; at RUN time the server only
// ever looks at `assets/ui` relative to `import.meta.url`, never at a workspace path.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, "..", "..", "ui", "dist")
const target = resolve(here, "..", "assets", "ui")

if (!existsSync(source)) {
  console.log(`[difmp] no built UI at ${source} — the CLI will serve assets/dashboard.html instead`)
  mkdirSync(target, { recursive: true })
  process.exit(0)
}
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })
console.log(`[difmp] copied ${source} -> ${target}`)
