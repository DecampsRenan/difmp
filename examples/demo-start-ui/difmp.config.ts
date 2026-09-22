import { defineConfig } from "@difmp/core";
import { demoStartUiScriptRegistry } from "./scripts/registry.js";

/**
 * Local battery against the public Start UI demo (https://demo.start-ui.com).
 *
 * Default provider is `scripted` so developers can exercise real Playwright navigation
 * without an API key. Override with DIFMP_PROVIDER=anthropic (and ANTHROPIC_API_KEY), or
 * set evaluator for Jev — see README.
 */
const baseUrl = process.env["DIFMP_BASE_URL"] ?? "https://demo.start-ui.com";
const realProvider = process.env["DIFMP_PROVIDER"] === "anthropic";
const useJev = process.env["DIFMP_EVALUATOR"] === "jev";
const jevBackend = process.env["DIFMP_JEV_BACKEND"] ?? "mock";

export default defineConfig({
  // Discovery is resolved against THIS directory, not the invocation cwd.
  include: ["scenarios/**/*.e2e.md"],

  baseUrl,
  // Tool-level navigate allow-list (not network isolation). Keep the demo origin only.
  allowedOrigins: [baseUrl],

  scripts: demoStartUiScriptRegistry(),

  provider: realProvider ? "anthropic" : "scripted",
  ...(realProvider ? { model: process.env["DIFMP_MODEL"] ?? "claude-sonnet-5" } : {}),
  providerOptions: realProvider
    ? { maxTokens: 2048 }
    : {
        script: process.env["DIFMP_SCRIPT"] ?? "auto",
        maxTokens: 2048,
      },

  // Optional Jev criterion judge (separate from navigation). `mock` needs no key.
  ...(useJev
    ? {
        evaluator: {
          provider: "jev" as const,
          model: process.env["DIFMP_JEV_MODEL"] ?? "jev-1.13.0",
          backend: jevBackend as "mock" | "typesafe" | "openrouter" | "vercel",
        },
      }
    : {}),

  // SPA hydration pauses + poll slots spend actions; keep headroom above the walkthrough length.
  maxActions: 100,
  budgets: {
    attemptTimeoutMs: 300_000,
    operationTimeoutMs: 30_000,
    maxModelCalls: 200,
    maxTokens: 400_000,
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
