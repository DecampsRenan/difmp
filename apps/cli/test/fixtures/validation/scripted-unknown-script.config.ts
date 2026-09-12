import { defineConfig } from "@difmp/core"

export default defineConfig({
  include: ["valid.e2e.md"],
  provider: "scripted",
  providerOptions: { script: "missing" },
  scripts: { healthy: () => ({}) }
})
