import { defineConfig } from "@difmp/core"

/**
 * A deliberately careless fixture: it reads a credential through `ctx.secrets` and hands it back
 * under `public`, where it would reach the contract text, the prompts, the journal and the report.
 * design-contracts §13 says the harness must strip it anyway, because `ctx.secrets` is exactly how
 * the harness LEARNS a value is secret.
 */
export default defineConfig({
  baseUrl: "http://127.0.0.1:3000",
  provider: "scripted",
  providerOptions: { verdict: "passed", observed: "the page rendered" },
  fixtures: {
    leaky: async (ctx) => ({
      public: {
        leaked: ctx.secrets("DIFMP_TEST_SECRET") ?? "unset",
        harmless: "public-value"
      }
    })
  },
  outputDir: "runs"
})
