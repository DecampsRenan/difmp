import { defineConfig } from "@difmp/core"

export default defineConfig({
  include: ["valid.e2e.md"],
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  providerOptions: { temperature: 0 }
})
