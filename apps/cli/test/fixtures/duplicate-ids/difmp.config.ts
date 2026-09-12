import { defineConfig } from "@difmp/core"

/** Two specs share `id: twin`. spec §4 requires the pair to be rejected. */
export default defineConfig({ baseUrl: "http://127.0.0.1:3000", provider: "scripted" })
