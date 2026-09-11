import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  alwaysExcluded,
  defaultBudgets,
  defineConfig,
  resolveConfig,
  resolveInputPrecedence
} from "../src/index.js"
import { expectFailure, expectSuccess } from "./helpers.js"

describe("config resolution", () => {
  it.effect("fills in a default for every documented field", () =>
    Effect.gen(function*() {
      const project = yield* expectSuccess(resolveConfig({ source: "harness.config.ts", config: {} }))
      const config = project.config
      expect(config.include).toEqual(["**/*.e2e.md"])
      expect(config.exclude).toEqual([...alwaysExcluded])
      expect(config.baseUrl).toBe("http://127.0.0.1:3000")
      expect(config.provider).toBe("scripted")
      expect(config.maxActions).toBe(25)
      expect(config.budgets).toEqual(defaultBudgets)
      expect(config.capture).toEqual({
        trace: "on",
        video: "off",
        screenshots: "checkpoints",
        retainTraceOn: "all"
      })
      expect(config.outputDir).toBe("runs")
      expect(config.reporters).toEqual(["console"])
      // The baseUrl origin is always allowed even when nothing is configured.
      expect(config.allowedOrigins).toEqual(["http://127.0.0.1:3000"])
    }))

  it.effect("rejects an unknown top-level key", () =>
    Effect.gen(function*() {
      const error = yield* expectFailure(
        resolveConfig({ source: "harness.config.ts", config: { retries: 3 } })
      )
      expect(error.problems.join("\n")).toContain("retries")
    }))

  it.effect("always merges the mandatory excludes and keeps the project's own", () =>
    Effect.gen(function*() {
      const project = yield* expectSuccess(resolveConfig({
        source: "harness.config.ts",
        config: defineConfig({ exclude: ["**/tmp/**"] })
      }))
      expect(project.config.exclude).toEqual([...alwaysExcluded, "**/tmp/**"])
    }))

  it.effect("lets CLI overrides win over the config file", () =>
    Effect.gen(function*() {
      const project = yield* expectSuccess(resolveConfig({
        source: "harness.config.ts",
        config: { provider: "scripted", outputDir: "runs" },
        overrides: { provider: "anthropic", outputDir: "out" }
      }))
      expect(project.config.provider).toBe("anthropic")
      expect(project.config.outputDir).toBe("out")
    }))

  it.effect("rejects a non-positive budget and names the field", () =>
    Effect.gen(function*() {
      const error = yield* expectFailure(resolveConfig({
        source: "harness.config.ts",
        config: { budgets: { maxModelCalls: 0 } }
      }))
      expect(error.problems.join("\n")).toContain("budgets.maxModelCalls")
    }))

  it.effect("rejects a verifier reserve that is not withheld from a smaller total", () =>
    Effect.gen(function*() {
      const error = yield* expectFailure(resolveConfig({
        source: "harness.config.ts",
        config: { budgets: { maxTokens: 1000, verifierReserveTokens: 1000 } }
      }))
      expect(error.problems.join("\n")).toContain("verifierReserveTokens")
    }))

  it.effect("rejects a registry entry that is not a function", () =>
    Effect.gen(function*() {
      const error = yield* expectFailure(resolveConfig({
        source: "harness.config.ts",
        config: { fixtures: { broken: "./fixtures/auth.ts" } }
      }))
      expect(error.problems.join("\n")).toContain("must be a function")
    }))

  it.effect("resolves fixtures by name and lists the registered names when one is missing", () =>
    Effect.gen(function*() {
      const project = yield* expectSuccess(resolveConfig({
        source: "harness.config.ts",
        config: defineConfig({
          fixtures: { "authenticated-workspace": async () => ({ public: { workspaceName: "W" } }) }
        })
      }))
      expect(project.registries.fixtures.names).toEqual(["authenticated-workspace"])
      const error = yield* expectFailure(project.registries.fixtures.lookup("absent"))
      expect(error.message).toContain("is not registered")
      expect(error.message).toContain("authenticated-workspace")
    }))
})

describe("input precedence", () => {
  const base = {
    source: "harness.config.ts",
    configInputs: { projectName: "config", shared: "config" },
    specInputs: { projectName: "spec" }
  }

  it.effect("applies config < spec < --inputs-file < --input", () =>
    Effect.gen(function*() {
      const onlySpec = yield* expectSuccess(resolveInputPrecedence(base))
      expect(onlySpec).toEqual({ projectName: "spec", shared: "config" })

      const withFile = yield* expectSuccess(
        resolveInputPrecedence({ ...base, fileInputs: { projectName: "file", shared: 7 } })
      )
      expect(withFile).toEqual({ projectName: "file", shared: 7 })

      const withCli = yield* expectSuccess(resolveInputPrecedence({
        ...base,
        fileInputs: { projectName: "file" },
        cliInputs: { projectName: "cli" }
      }))
      expect(withCli).toEqual({ projectName: "cli", shared: "config" })
    }))

  it.effect("rejects a --inputs-file key that neither the config nor the spec declares", () =>
    Effect.gen(function*() {
      const error = yield* expectFailure(
        resolveInputPrecedence({ ...base, fileInputs: { undeclared: 1 } })
      )
      expect(error.message).toContain("--inputs-file declares \"undeclared\"")
    }))

  it.effect("rejects an undeclared --input key", () =>
    Effect.gen(function*() {
      const error = yield* expectFailure(
        resolveInputPrecedence({ ...base, cliInputs: { nope: "1" } })
      )
      expect(error.message).toContain("--input declares \"nope\"")
    }))
})
