import { defineConfig } from "@difmp/core"

export default defineConfig({
  baseUrl: "http://127.0.0.1:3000",
  provider: "scripted",
  providerOptions: { verdict: "failed", observed: "le titre est absent" },
  inputs: { projectName: "from-config", fromConfigOnly: "cfg", retries: 1 }
})
