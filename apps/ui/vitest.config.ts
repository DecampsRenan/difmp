import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Component suite for the live dashboard. Kept next to the app — like `apps/cli/vitest.config.ts` —
 * so it runs on its own (`npx vitest run --config apps/ui/vitest.config.ts`) as well as from the
 * root config, which lists it as a project.
 *
 * `environment: "jsdom"`: these are COMPONENT tests, not browser tests. Nothing here launches
 * Chromium — that is the CLI suite's job — so the whole file runs in seconds and needs no
 * `playwright install`.
 */
export default defineConfig({
  // Pinned to this directory so `--config apps/ui/vitest.config.ts` from the repository root
  // resolves `test/**` here and not against the caller's cwd.
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  test: {
    name: "ui",
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
    environment: "jsdom",
    globals: false,
    setupFiles: ["test/setup.ts"],
    restoreMocks: true,
  },
});
