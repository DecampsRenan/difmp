import { defineConfig } from "@difmp/core";
import { projectUniqueInStorage } from "./checks/project-unique-in-storage.js";
import { authenticatedWorkspace } from "./fixtures/authenticated-workspace.js";
import { fixtureAppScriptRegistry } from "./scripts/registry.js";

/**
 * Demo configuration for the example scenarios.
 *
 * `DIFMP_BASE_URL` exists because the fixture app binds an ephemeral port by default
 * (`--port 0`); a test harness that started it programmatically exports the URL it actually got.
 * With `node dist/main.js --port 3000 --seed` the default below is already correct.
 */
const baseUrl = process.env["DIFMP_BASE_URL"] ?? "http://127.0.0.1:3000";

export default defineConfig({
  // Discovery. `include`/`exclude` are resolved against the DIRECTORY OF THIS FILE, not the
  // invocation directory — so a consumer gets the same selection wherever they run `difmp` from.
  // Paths given as CLI arguments are resolved against the invocation directory instead.
  // `invalid/` holds specs that MUST be rejected; they are fixtures for the loader, not runs, and
  // naming one explicitly (`difmp run examples/scenarios/invalid/x.e2e.md`) still reaches it.
  include: ["../scenarios/**/*.e2e.md"],
  exclude: ["**/invalid/**"],

  // Target.
  baseUrl,
  // Tool-level navigation allow-list, not network isolation (see README, "Security").
  // The baseUrl origin is always allowed; it is repeated here only for readability.
  allowedOrigins: [baseUrl],

  // Project-level input defaults (lowest priority: config < spec < --inputs-file < --input).
  // `{{ run.id }}` makes the name unique per run, so two runs never collide in one workspace.
  inputs: {
    projectName: "Project {{ run.id }}",
  },

  // Registries. A spec references these NAMES; it can never name a module path.
  fixtures: {
    "authenticated-workspace": authenticatedWorkspace,
  },
  checks: {
    "project-unique-in-storage": projectUniqueInStorage,
  },
  // Deterministic browsing scripts for `provider: "scripted"`, selected BY NAME below. Each entry
  // is a factory: the real project name only exists once the run id is minted.
  scripts: fixtureAppScriptRegistry(),

  // Model. `scripted` is the deterministic, network-free double, so the repository's tests need no
  // API key. Switch to the real adapter with:
  //   provider: "anthropic", model: "claude-sonnet-5"   (+ ANTHROPIC_API_KEY in the environment)
  // or, without editing this file, `difmp run --provider anthropic --model claude-sonnet-5`.
  // A scripted run never validates a model's ability to navigate — the report names the adapter.
  provider: "scripted",
  providerOptions: {
    // "auto" picks the journey from the scenario and from FIXTURE_APP_VARIANT, so the four
    // variants of spec §13 run without editing this file. DIFMP_SCRIPT selects one of the
    // harness-behaviour cases instead (premature-finish, exceed-actions, stale-observation,
    // budget-exhausted, invented-evidence, needs-evidence).
    script: process.env["DIFMP_SCRIPT"] ?? "auto",
    maxTokens: 2048,
    temperature: 0,
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
    // A pool for the final verification: withheld from the browsing loop, and guaranteed to the
    // verifier even if a browsing turn overshot the ceiling. See design-contracts §7.
    verifierReserveTokens: 20_000,
    fixtureCleanupTimeoutMs: 15_000,
  },

  capture: {
    trace: "on",
    video: "off",
    screenshots: "checkpoints",
    retainTraceOn: "all",
  },

  outputDir: "runs",
  reporters: ["console", "json", "junit", "html"],
});
