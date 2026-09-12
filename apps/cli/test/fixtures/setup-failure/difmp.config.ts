import { defineConfig } from "@difmp/core"

/**
 * A project whose fixture always fails. It exists to prove that a run dying in INFRASTRUCTURE
 * setup — before the contract is frozen — is still reported: spec §6 step 2 persists the initial
 * manifest first, so `junit.xml` and `report.html` can be produced from it.
 */
export default defineConfig({
  baseUrl: "http://127.0.0.1:3000",
  provider: "scripted",
  providerOptions: { verdict: "passed" },
  fixtures: {
    "broken-seed": async () => {
      throw new Error("seed API refused the request (HTTP 503)")
    }
  },
  outputDir: "runs"
})
