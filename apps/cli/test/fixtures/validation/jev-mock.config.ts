import { defineConfig } from "@difmp/core"

export default defineConfig({
  include: ["valid.e2e.md"],
  provider: "scripted",
  evaluator: { provider: "jev", model: "jev-1.13.0", backend: "mock" },
})
