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
      // The UI suite likewise keeps its own config: it needs `environment: "jsdom"` and the React
      // plugin to compile JSX, neither of which the node-environment `unit` project above may
      // inherit. Listed here so `pnpm run test` covers it too.
      "apps/ui/vitest.config.ts",
    ],
    globals: false,
    passWithNoTests: true,
  },
});
