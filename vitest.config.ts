import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", ".recon/tooling/**/*.test.ts"],
          environment: "node"
        }
      }
    ],
    globals: false,
    passWithNoTests: true
  }
})
