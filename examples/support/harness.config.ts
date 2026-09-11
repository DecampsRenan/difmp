import { defineConfig } from "@harness/core"
import { projectUniqueInStorage } from "./checks/project-unique-in-storage.js"
import { authenticatedWorkspace } from "./fixtures/authenticated-workspace.js"

/**
 * Demo configuration for the example scenarios.
 *
 * `HARNESS_BASE_URL` exists because the fixture app binds an ephemeral port by default
 * (`--port 0`); a test harness that started it programmatically exports the URL it actually got.
 * With `node dist/main.js --port 3000 --seed` the default below is already correct.
 */
const baseUrl = process.env["HARNESS_BASE_URL"] ?? "http://127.0.0.1:3000"

export default defineConfig({
  // Discovery. Globs are resolved against the directory the CLI runs in — these assume the
  // workspace root. `harness run <path>` overrides them for a single scenario.
  // `**/invalid/**` holds specs that MUST be rejected; they are fixtures for the loader, not runs.
  include: ["examples/scenarios/**/*.e2e.md"],
  exclude: ["**/invalid/**"],

  // Target.
  baseUrl,
  // Tool-level navigation allow-list, not network isolation (see README, "Security").
  // The baseUrl origin is always allowed; it is repeated here only for readability.
  allowedOrigins: [baseUrl],

  // Project-level input defaults (lowest priority: config < spec < --inputs-file < --input).
  // `{{ run.id }}` makes the name unique per run, so two runs never collide in one workspace.
  inputs: {
    projectName: "Projet {{ run.id }}"
  },

  // Registries. A spec references these NAMES; it can never name a module path.
  fixtures: {
    "authenticated-workspace": authenticatedWorkspace
  },
  checks: {
    "project-unique-in-storage": projectUniqueInStorage
  },

  // Model. `scripted` is the deterministic, network-free double, so the repository's tests need no
  // API key. Switch to the real adapter with:
  //   provider: "anthropic", model: "claude-sonnet-5"   (+ ANTHROPIC_API_KEY in the environment)
  // or, without editing this file, `harness run --provider anthropic --model claude-sonnet-5`.
  // A scripted run never validates a model's ability to navigate — the report names the adapter.
  provider: "scripted",
  providerOptions: {
    maxTokens: 2048,
    temperature: 0
  },

  // INDICATIVE journey length. Crossing it warns once and changes nothing else: no tool is
  // refused, no verdict is degraded. The blocking limits are `budgets` below.
  maxActions: 25,

  // BLOCKING budgets. Exhausting one ends the attempt as `inconclusive`, never `failed`.
  budgets: {
    attemptTimeoutMs: 120_000,
    operationTimeoutMs: 15_000,
    maxModelCalls: 40,
    maxTokens: 200_000,
    // Held back from the browsing loop so the final verification can always run.
    verifierReserveTokens: 20_000,
    fixtureCleanupTimeoutMs: 15_000
  },

  capture: {
    trace: "on",
    video: "off",
    screenshots: "checkpoints",
    retainTraceOn: "all"
  },

  outputDir: "runs",
  reporters: ["console", "json", "junit", "html"]
})
