import { defineConfig } from "vitest/config";

// The root `vitest.config.ts` only enumerates `packages/*/test`; this project keeps the CLI suite
// runnable on its own: `npx vitest run --config apps/cli/vitest.config.ts`.
export default defineConfig({
  test: {
    name: "cli",
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    // A scenario launches a real Chromium through the Playwright driver.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
