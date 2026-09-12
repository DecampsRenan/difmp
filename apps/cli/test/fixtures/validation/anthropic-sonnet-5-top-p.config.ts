import { defineConfig } from "@difmp/core"

export default defineConfig({
  include: ["valid.e2e.md"],
  provider: "anthropic",
  model: "claude-sonnet-5",
  providerOptions: { topP: 0.9 }
})
