import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * `base: "./"` so the CLI can mount `dist/` at any path (api-tooling.md §8.1). It is NOT enough for
 * `file://` — but this app is always served over http by the CLI; the offline single-file report is
 * `@harness/reporting`'s job, not this one.
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    modulePreload: { polyfill: false }
  },
  server: {
    host: "127.0.0.1"
  }
})
