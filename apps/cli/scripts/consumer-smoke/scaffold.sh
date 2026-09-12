#!/usr/bin/env bash
#
# Create a throw-away CONSUMER project: a package that knows nothing about this repository except
# the `difmp` tarball it installs. Everything it needs — the application under test, the
# scenario, the TypeScript config — is generated here, so the consumer never needs the harness
# checked out.
#
#   scaffold.sh <dir> <esm|cjs>
#
# `esm` produces `"type": "module"` with an erasable (types-only) config, which Node can strip
# natively. `cjs` produces `"type": "commonjs"` with a NON-erasable config (a real `enum`), which
# neither native stripping nor the CommonJS loader can take — only the CLI's bundled `tsx` fallback.
set -euo pipefail
DIR="$1"; KIND="$2"
rm -rf "$DIR"; mkdir -p "$DIR/tests/invalid" "$DIR/public"

if [ "$KIND" = "esm" ]; then TYPE=module; else TYPE=commonjs; fi

cat > "$DIR/package.json" <<JSON
{
  "name": "difmp-consumer-$KIND",
  "private": true,
  "version": "1.0.0",
  "type": "$TYPE",
  "scripts": {
    "test:e2e": "difmp run",
    "test:e2e:ui": "difmp run --ui",
    "e2e:list": "difmp list"
  }
}
JSON

# ---------------------------------------------------------------------------------------------
# The application under test: a trivial static page, served by a zero-dependency Node server.
# ---------------------------------------------------------------------------------------------
cat > "$DIR/public/index.html" <<'HTML'
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Consumer demo</title></head>
<body>
  <h1>Workspace</h1>
  <form id="f">
    <label for="n">Project name</label>
    <input id="n" name="n" type="text">
    <button type="submit">Create</button>
  </form>
  <h2>Projects</h2>
  <ul id="list"></ul>
  <script>
    document.getElementById("f").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = document.getElementById("n").value;
      if (!v) return;
      var li = document.createElement("li");
      li.textContent = v;
      document.getElementById("list").appendChild(li);
      document.getElementById("n").value = "";
    });
  </script>
</body>
</html>
HTML

# `.mjs`, so the same file runs in an ESM-typed and a CommonJS-typed consumer.
cat > "$DIR/server.mjs" <<'JS'
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(resolve(here, "public", "index.html"))
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(page)
})
server.listen(0, "127.0.0.1", () => {
  console.log(`PORT=${server.address().port}`)
})
JS

# ---------------------------------------------------------------------------------------------
# difmp.config.ts — TypeScript, loaded by the installed CLI from the consumer project.
# ---------------------------------------------------------------------------------------------
if [ "$KIND" = "esm" ]; then
cat > "$DIR/difmp.config.ts" <<'TS'
import { defineConfig } from "difmp"

// Erasable TypeScript: a type alias and annotations only. Node >= 22.18 strips this natively.
type Verdict = "passed" | "failed" | "inconclusive"

const baseUrl: string = process.env["CONSUMER_BASE_URL"] ?? "http://127.0.0.1:3000"
const verdict = (process.env["CONSUMER_VERDICT"] ?? "passed") as Verdict

export default defineConfig({
  include: ["tests/**/*.e2e.md"],
  exclude: ["**/invalid/**"],
  baseUrl,
  allowedOrigins: [baseUrl],
  inputs: { projectName: "Project {{ run.id }}" },
  provider: "scripted",
  providerOptions: {
    scenario: "happy-path",
    fills: [{ name: "Project name", value: "Consumer project" }],
    submit: "Create",
    verdict,
    observed: "the list shows the created entry (scripted test double)"
  },
  maxActions: 25,
  outputDir: "runs"
})
TS
else
cat > "$DIR/difmp.config.ts" <<'TS'
import { defineConfig } from "difmp"

// NON-ERASABLE TypeScript inside a CommonJS-typed package. Node's native type stripping refuses
// `enum`, and the CommonJS loader refuses the `import` statement above, so this file loads ONLY
// through the `tsx` fallback the CLI ships as a real dependency.
enum Verdict {
  Passed = "passed",
  Failed = "failed",
  Inconclusive = "inconclusive"
}

const baseUrl = process.env["CONSUMER_BASE_URL"] ?? "http://127.0.0.1:3000"
const fromEnv = process.env["CONSUMER_VERDICT"]
const verdict = fromEnv === "failed"
  ? Verdict.Failed
  : fromEnv === "inconclusive"
  ? Verdict.Inconclusive
  : Verdict.Passed

export default defineConfig({
  include: ["tests/**/*.e2e.md"],
  exclude: ["**/invalid/**"],
  baseUrl,
  allowedOrigins: [baseUrl],
  inputs: { projectName: "Project {{ run.id }}" },
  provider: "scripted",
  providerOptions: {
    scenario: "happy-path",
    fills: [{ name: "Project name", value: "Consumer project" }],
    submit: "Create",
    verdict,
    observed: "the list shows the created entry (scripted test double)"
  },
  maxActions: 25,
  outputDir: "runs"
})
TS
fi

# --------------------------------------------------------------------------------------------
# The scenario, and a spec that MUST be rejected before any browser starts.
# --------------------------------------------------------------------------------------------
cat > "$DIR/tests/project-create.e2e.md" <<'MD'
---
version: 1
id: consumer-project-create
tags: [smoke]
timeout: 90s
maxActions: 25
inputs:
  projectName: "Project {{ run.id }}"
verification: |
  - The created project appears in the project list on the page.
---

# Create a project from a consumer project

From the home page, type a name into the "Project name" field, then confirm with "Create".
Then observe the project list.
MD

cat > "$DIR/tests/invalid/bad-frontmatter.e2e.md" <<'MD'
---
version: 1
id: consumer-invalid
unknownKey: nope
verification: |
  - This must never be executed.
---

# Invalid spec
MD
