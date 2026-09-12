import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts"],
          environment: "node",
        },
      },
      // The CLI suite keeps its own config (it launches a real Chromium, so it disables file
      // parallelism and raises the timeouts). Referencing it here means `npx vitest run` — and the
      // CI job that mirrors it — covers the harness's own tests in ONE command.
      "apps/cli/vitest.config.ts",
    ],
    globals: false,
    passWithNoTests: true,
  },
});
