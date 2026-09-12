import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { interpolate, resolveInputs, serializeScalar } from "../src/index.js"
import { expectFailure, expectSuccess } from "./helpers.js"

const scope = {
  run: { id: "r_abcdefghijklm" },
  attempt: { id: "a1" },
  inputs: { projectName: "Project X", count: 3, flag: true },
  fixture: { workspaceName: "Demo workspace" }
}

describe("interpolation", () => {
  it.effect("substitutes reserved variables, inputs and fixture public values", () =>
    Effect.gen(function*() {
      const out = yield* expectSuccess(interpolate({
        text: "run={{ run.id }} attempt={{ attempt.id }} p={{ projectName }} w={{ fixture.workspaceName }}",
        source: "s.e2e.md",
        field: "body",
        anchor: { line: 1, column: 1 },
        scope
      }))
      expect(out).toBe("run=r_abcdefghijklm attempt=a1 p=Project X w=Demo workspace")
    }))

  it.effect("serialises scalars deterministically", () =>
    Effect.gen(function*() {
      const out = yield* expectSuccess(interpolate({
        text: "{{ count }}/{{ flag }}",
        source: "s.e2e.md",
        field: "body",
        anchor: { line: 1, column: 1 },
        scope
      }))
      expect(out).toBe("3/true")
      expect(serializeScalar(-0)).toBe("0")
      expect(serializeScalar(false)).toBe("false")
    }))

  it.effect("rejects an unknown variable, naming it and its source position", () =>
    Effect.gen(function*() {
      const error = yield* expectFailure(interpolate({
        text: "line one\nvalue {{ unknown }} here",
        source: "s.e2e.md",
        field: "criteria.c1",
        anchor: { line: 10, column: 3 },
        scope
      }))
      expect(error.variable).toBe("unknown")
      expect(error.field).toBe("criteria.c1")
      expect(error.line).toBe(11)
      expect(error.column).toBe(7)
      expect(error.message).toContain("s.e2e.md:11:7")
      expect(error.message).toContain("declared inputs: count, flag, projectName")
    }))

  it.effect("rejects expressions — there is no expression engine", () =>
    Effect.gen(function*() {
      const error = yield* expectFailure(interpolate({
        text: "{{ projectName | upper }}",
        source: "s.e2e.md",
        field: "body",
        anchor: { line: 1, column: 1 },
        scope
      }))
      expect(error.reason).toContain("expressions are not supported")
    }))

  it.effect("rejects a fixture key the fixture does not expose", () =>
    Effect.gen(function*() {
      const error = yield* expectFailure(interpolate({
        text: "{{ fixture.absent }}",
        source: "s.e2e.md",
        field: "body",
        anchor: { line: 1, column: 1 },
        scope
      }))
      expect(error.reason).toContain("does not expose a public value named \"absent\"")
    }))

  it.effect("validate mode keeps unresolved fixture references intact", () =>
    Effect.gen(function*() {
      const out = yield* expectSuccess(interpolate({
        text: "w={{ fixture.workspaceName }} p={{ projectName }}",
        source: "s.e2e.md",
        field: "body",
        anchor: { line: 1, column: 1 },
        scope: { run: scope.run, attempt: scope.attempt, inputs: scope.inputs },
        mode: "validate"
      }))
      expect(out).toBe("w={{ fixture.workspaceName }} p=Project X")
    }))
})

describe("input resolution (phase 1)", () => {
  it.effect("resolves reserved variables only", () =>
    Effect.gen(function*() {
      const resolved = yield* expectSuccess(resolveInputs({
        declared: { projectName: "Project {{ run.id }}", count: 2 },
        source: "s.e2e.md",
        run: { id: "r_abcdefghijklm" },
        attempt: { id: "a1" }
      }))
      expect(resolved).toEqual({ projectName: "Project r_abcdefghijklm", count: 2 })
    }))

  it.effect("rejects an input that references a fixture value", () =>
    Effect.gen(function*() {
      const error = yield* expectFailure(resolveInputs({
        declared: { projectName: "{{ fixture.workspaceName }}" },
        source: "s.e2e.md",
        run: { id: "r_abcdefghijklm" },
        attempt: { id: "a1" }
      }))
      expect(error.field).toBe("inputs.projectName")
      expect(error.reason).toContain("before the fixture runs")
    }))

  it.effect("rejects an input that references another input", () =>
    Effect.gen(function*() {
      const error = yield* expectFailure(resolveInputs({
        declared: { a: "x", b: "{{ a }}" },
        source: "s.e2e.md",
        run: { id: "r_abcdefghijklm" },
        attempt: { id: "a1" }
      }))
      expect(error.reason).toContain("may not reference other inputs")
    }))
})
