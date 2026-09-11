import { defineConfig } from "@harness/core"

export default defineConfig({
  baseUrl: "http://127.0.0.1:3000",
  provider: "scripted",
  providerOptions: { verdict: "passed", observed: "page rendue" },
  inputs: { projectName: "from-config", fromConfigOnly: "cfg", retries: 1 },
  outputDir: "runs"
})
