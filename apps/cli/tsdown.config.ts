import { defineConfig } from "tsdown"

/**
 * A standalone tarball: the `@harness/*` workspace packages are PRIVATE, so they must be bundled
 * rather than left as dependencies. Everything else — effect, @effect/*, playwright, tsx, yaml —
 * stays external (api-tooling.md §4.3): bundling `effect` would fight its module-instance-sensitive
 * service identity, and `playwright` cannot be bundled at all.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/bin/harness.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22.12",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  clean: true,
  shims: false,
  treeshake: true,
  noExternal: [/^@harness\//],
  // tsdown writes .mjs / .d.mts for the esm format by default; `bin` and `exports` point at .js.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" })
})
