import type { LoadedSpec, Registries, ResolvedConfig } from "@harness/core"
import { resolveInputPrecedence, resolveInputs, SpecLoader, validateReferences } from "@harness/core"
import { Console, Effect, FileSystem, Option, Path } from "effect"
import { UsageError } from "../errors.js"
import { loadProject } from "../project.js"
import { selectSpecs } from "../select.js"
import type { SelectFlags } from "./types.js"

/** No setup has run, so these are placeholders — `validate` never touches a browser or a model. */
const placeholderRun = { id: "r_aaaaaaaaaaaaa" }
const placeholderAttempt = { id: "a1" }

export interface SpecReport {
  readonly specPath: string
  readonly scenarioId: string
  readonly criteria: number
  readonly problems: ReadonlyArray<string>
}

/**
 * Check everything that can be checked before anything runs: the frontmatter (already done by the
 * loader), the input declarations and precedence, every `{{ … }}` reference, and the fixture/check
 * names against the project registry.
 *
 * `{{ fixture.* }}` is ACCEPTED here: no setup has run yet, so those values cannot exist. `run`
 * rejects an unresolved fixture reference after setup.
 */
export const validateSpec = (options: {
  readonly spec: LoadedSpec
  readonly specPath: string
  readonly config: ResolvedConfig
  readonly registries: Registries
  readonly source: string
}): Effect.Effect<SpecReport> =>
  Effect.gen(function*() {
    const { config, registries, spec } = options
    const problems: Array<string> = []
    const fail = (message: string) => problems.push(message)

    const declared = yield* resolveInputPrecedence({
      source: options.source,
      configInputs: config.inputs,
      specInputs: spec.frontmatter.inputs ?? {}
    }).pipe(Effect.result)
    if (declared._tag === "Failure") fail(declared.failure.message)

    const inputs = declared._tag === "Success"
      ? yield* resolveInputs({
        declared: declared.success,
        source: spec.specPath,
        run: placeholderRun,
        attempt: placeholderAttempt,
        anchors: spec.fieldLines
      }).pipe(Effect.result)
      : undefined
    if (inputs !== undefined && inputs._tag === "Failure") fail(inputs.failure.message)

    const scope = {
      run: placeholderRun,
      attempt: placeholderAttempt,
      inputs: inputs !== undefined && inputs._tag === "Success" ? inputs.success : {}
    }

    const body = yield* validateReferences({
      text: spec.body,
      source: spec.specPath,
      field: "body",
      anchor: { line: spec.bodyLine, column: 1 },
      scope
    }).pipe(Effect.result)
    if (body._tag === "Failure") fail(body.failure.message)

    for (const criterion of spec.criteria) {
      const checked = yield* validateReferences({
        text: criterion.sourceText,
        source: spec.specPath,
        field: criterion.id,
        anchor: { line: criterion.line, column: criterion.column },
        scope
      }).pipe(Effect.result)
      if (checked._tag === "Failure") fail(checked.failure.message)

      if (criterion.checkName !== undefined && !registries.checks.has(criterion.checkName)) {
        const lookup = yield* registries.checks.lookup(criterion.checkName).pipe(Effect.result)
        if (lookup._tag === "Failure") fail(`${criterion.id}: ${lookup.failure.message}`)
      }
    }

    const fixtureName = spec.frontmatter.fixture
    if (fixtureName !== undefined && !registries.fixtures.has(fixtureName)) {
      const lookup = yield* registries.fixtures.lookup(fixtureName).pipe(Effect.result)
      if (lookup._tag === "Failure") fail(lookup.failure.message)
    }

    return {
      specPath: options.specPath,
      scenarioId: spec.frontmatter.id,
      criteria: spec.criteria.length,
      problems
    }
  })

export const validateHandler = (
  flags: SelectFlags
): Effect.Effect<void, UsageError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const cwd = process.cwd()
    const project = yield* loadProject({
      cwd,
      ...(Option.isSome(flags.config) ? { configPath: flags.config.value } : {})
    })
    const selection = yield* selectSpecs({
      cwd,
      root: project.location.root,
      config: project.config,
      patterns: flags.paths,
      tags: flags.tag,
      source: project.location.source
    }).pipe(Effect.provide(SpecLoader.layer))

    const reports = yield* Effect.forEach(
      selection.specs,
      (spec, index) =>
        validateSpec({
          spec,
          specPath: selection.relativePaths[index]!,
          config: project.config,
          registries: project.registries,
          source: project.location.source
        })
    )

    const invalid = reports.filter((r) => r.problems.length > 0)
    if (flags.json) {
      yield* Console.log(JSON.stringify({ schemaVersion: 1, valid: invalid.length === 0, scenarios: reports }, null, 2))
    } else {
      for (const report of reports) {
        if (report.problems.length === 0) {
          yield* Console.log(`OK    ${report.scenarioId}  ${report.criteria} criteria  ${report.specPath}`)
        } else {
          yield* Console.log(`BAD   ${report.scenarioId}  ${report.specPath}`)
          for (const problem of report.problems) yield* Console.log(`        - ${problem}`)
        }
      }
      yield* Console.log(
        `\n${reports.length - invalid.length}/${reports.length} scenario${reports.length === 1 ? "" : "s"} valid`
      )
    }

    if (invalid.length > 0) {
      return yield* Effect.fail(
        new UsageError({ message: `${invalid.length} scenario${invalid.length === 1 ? " is" : "s are"} invalid` })
      )
    }
  })
