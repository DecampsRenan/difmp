import { defineConfig } from "tsdown";

/**
 * A standalone tarball: the `@difmp/*` workspace packages are PRIVATE, so they must be bundled
 * rather than left as dependencies.
 *
 * `effect` and `@effect/*` are bundled into the JavaScript too. They are published as a lockstep
 * family of exact prereleases, but `@effect/*` declare `effect` as a caret peer: npm and Yarn then
 * install a second, newer `effect` for them, and a breaking prerelease (4.0.0-rc.118 dropped
 * `unstable/encoding/Sse.js`, which `@effect/ai-anthropic@rc.113` imports) crashes the CLI at
 * startup. Bundled, the whole family is the exact set the workspace was tested with, and there is a
 * single module instance, so `Context`/service identity holds. The declaration files still import
 * `effect` for the public types, so it stays a dependency; `@effect/*` are build-time only.
 *
 * Everything else — playwright, tsx, yaml — stays external (api-tooling.md §4.3): `playwright`
 * cannot be bundled at all.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/scripted.ts", "src/bin/difmp.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22.12",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  clean: true,
  shims: false,
  treeshake: true,
  noExternal: (id, importer) =>
    id.startsWith("@difmp/") ||
    (/^(effect(\/|$)|@effect\/)/.test(id) && !importer?.endsWith(".d.ts")),
  // tsdown writes .mjs / .d.mts for the esm format by default; `bin` and `exports` point at .js.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
