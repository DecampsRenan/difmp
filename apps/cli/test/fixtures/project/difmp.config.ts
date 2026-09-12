import { defineConfig } from "@difmp/core"

export default defineConfig({
  baseUrl: "http://127.0.0.1:3000",
  provider: "scripted",
  providerOptions: { verdict: "passed", observed: "the page rendered" },
  inputs: { projectName: "from-config", fromConfigOnly: "cfg", retries: 1 },
  outputDir: "runs"
})
