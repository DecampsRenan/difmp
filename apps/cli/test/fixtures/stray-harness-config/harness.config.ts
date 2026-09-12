// A project carrying a leftover `harness.config.ts` from the old tool name. Discovery must NOT
// load it: only `difmp.config.*` is recognised.
import { defineConfig } from "@difmp/core"

export default defineConfig({
  baseUrl: "http://127.0.0.1:3000",
  provider: "scripted",
  providerOptions: { verdict: "passed", observed: "the page rendered" },
  inputs: { configBasename: "harness" },
  outputDir: "runs"
})
