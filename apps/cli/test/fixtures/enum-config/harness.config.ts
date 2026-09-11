// A TypeScript `enum` is NOT erasable syntax, so Node's type stripping refuses this file and the
// loader has to fall back to tsx's `tsImport` (api-tooling.md §3.2).
import { defineConfig } from "@harness/core"

enum Provider {
  Scripted = "scripted"
}

export default defineConfig({
  baseUrl: "http://127.0.0.1:3000",
  provider: Provider.Scripted,
  providerOptions: { verdict: "passed" },
  inputs: { projectName: "from-enum-config" }
})
