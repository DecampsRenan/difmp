import { defineConfig } from "@harness/core"

// `nope` is not a configuration key. Unknown top-level keys are REJECTED.
export default defineConfig({ baseUrl: "http://127.0.0.1:3000", nope: true } as never)
