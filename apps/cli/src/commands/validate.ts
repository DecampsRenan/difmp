import type { LoadedSpec, Registries, ResolvedConfig } from "@difmp/core";
import { checkRun, SpecLoader } from "@difmp/core";
import { Console, Effect, FileSystem, Option, Path } from "effect";
import { UsageError } from "../errors.js";
import { loadProject } from "../project.js";
import { validateProviderConfig } from "../providers.js";
import { selectSpecs } from "../select.js";
import type { SelectFlags } from "./types.js";

export interface SpecReport {
  readonly specPath: string;
  readonly scenarioId: string;
  readonly criteria: number;
  readonly problems: ReadonlyArray<string>;
}

export interface ValidationDocument {
  readonly schemaVersion: 1;
  readonly valid: boolean;
  /** Invocation-wide failures: config, provider prerequisites, discovery or spec loading. */
  readonly problems: ReadonlyArray<string>;
  readonly scenarios: ReadonlyArray<SpecReport>;
}

const document = (
  problems: ReadonlyArray<string>,
  scenarios: ReadonlyArray<SpecReport>,
): ValidationDocument => ({
  schemaVersion: 1,
  valid: problems.length === 0 && scenarios.every((scenario) => scenario.problems.length === 0),
  problems,
  scenarios,
});

const writeDocument = (report: ValidationDocument, json: boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (json) {
      yield* Console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (report.problems.length > 0) {
      yield* Console.log("BAD   validation");
      for (const problem of report.problems) yield* Console.log(`        - ${problem}`);
    }
    for (const scenario of report.scenarios) {
      if (scenario.problems.length === 0) {
        yield* Console.log(
          `OK    ${scenario.scenarioId}  ${scenario.criteria} criteria  ${scenario.specPath}`,
        );
      } else {
        yield* Console.log(`BAD   ${scenario.scenarioId}  ${scenario.specPath}`);
        for (const problem of scenario.problems) yield* Console.log(`        - ${problem}`);
      }
    }
    const valid = report.scenarios.filter((scenario) => scenario.problems.length === 0).length;
    yield* Console.log(
      `\n${valid}/${report.scenarios.length} scenario${report.scenarios.length === 1 ? "" : "s"} valid`,
    );
  });

/**
 * Check everything that can be checked before anything runs: the frontmatter (already done by the
 * loader), the input declarations and precedence, every `{{ … }}` reference, and the fixture/check
 * names against the project registry.
 *
 * `{{ fixture.* }}` is ACCEPTED here: no setup has run yet, so those values cannot exist. `run`
 * rejects an unresolved fixture reference after setup.
 */
export const validateSpec = (options: {
  readonly spec: LoadedSpec;
  readonly specPath: string;
  readonly config: ResolvedConfig;
  readonly registries: Registries;
  readonly source: string;
}): Effect.Effect<SpecReport> =>
  Effect.map(
    checkRun({
      spec: options.spec,
      specPath: options.specPath,
      config: options.config,
      registries: options.registries,
      source: options.source,
    }),
    (problems) => ({
      specPath: options.specPath,
      scenarioId: options.spec.frontmatter.id,
      criteria: options.spec.criteria.length,
      problems,
    }),
  );

export const validateHandler = (
  flags: SelectFlags,
): Effect.Effect<void, UsageError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const cwd = process.cwd();
    const built = yield* Effect.gen(function* () {
      const project = yield* loadProject({
        cwd,
        ...(Option.isSome(flags.config) ? { configPath: flags.config.value } : {}),
      });
      const provider = yield* validateProviderConfig(project.config, project.registries).pipe(
        Effect.result,
      );
      const problems =
        provider._tag === "Failure" ? [provider.failure.message] : ([] as Array<string>);

      const selection = yield* selectSpecs({
        cwd,
        root: project.location.root,
        config: project.config,
        patterns: flags.paths,
        tags: flags.tag,
        source: project.location.source,
      }).pipe(Effect.provide(SpecLoader.layer), Effect.result);
      if (selection._tag === "Failure") {
        return document([...problems, selection.failure.message], []);
      }

      const reports = yield* Effect.forEach(selection.success.specs, (spec, index) =>
        validateSpec({
          spec,
          specPath: selection.success.relativePaths[index]!,
          config: project.config,
          registries: project.registries,
          source: project.location.source,
        }),
      );
      return document(problems, reports);
    }).pipe(Effect.result);

    if (built._tag === "Failure") {
      if (!flags.json) return yield* Effect.fail(built.failure);
      yield* writeDocument(document([built.failure.message], []), true);
      return yield* Effect.fail(new UsageError({ message: built.failure.message, reported: true }));
    }

    const report = built.success;
    yield* writeDocument(report, flags.json);
    if (!report.valid) {
      const scenarioProblems = report.scenarios.filter(
        (scenario) => scenario.problems.length > 0,
      ).length;
      const totalProblems = report.problems.length + scenarioProblems;
      return yield* Effect.fail(
        new UsageError({
          message: `${totalProblems} validation problem${totalProblems === 1 ? "" : "s"}`,
          ...(flags.json ? { reported: true } : {}),
        }),
      );
    }
  });
