import { defineConfig } from "@difmp/core"

export default defineConfig({
  include: ["valid.e2e.md"],
  evaluator: { provider: "jev", model: "jev-1.13.0", backend: "nope" },
})
