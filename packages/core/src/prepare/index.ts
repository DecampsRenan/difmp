import { Crypto, Effect } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { Budgets } from "../domain/budgets.js";
import type { ResolvedConfig } from "../domain/config.js";
import type { ConfigInvalidError, InterpolationError, RegistryError } from "../domain/errors.js";
import { sha256Hex } from "../domain/hash.js";
import type {
  Criterion,
  InputsRecord,
  LoadedSpec,
  ParsedCriterion,
  ScenarioContract,
} from "../domain/spec.js";
import { resolveInputPrecedence } from "../config/index.js";
import type { InterpolationScope } from "../interpolate/index.js";
import { interpolate, resolveInputs, validateReferences } from "../interpolate/index.js";
import { validateSpecRegistries } from "../registry/index.js";
import type { Registries } from "../registry/index.js";
import { stableStringify } from "../runner/stableJson.js";
import type { Position } from "../spec/frontmatter.js";

/**
 * The preparation of a run: everything that turns a `*.e2e.md` into a frozen Contrat, before any
 * navigation. One chain — input precedence, phase-1 interpolation, registry names, then the
 * contract freeze with its hashes and the scenario-timeout rule — owned here and nowhere else.
 *
 * The chain has TWO attitudes over the same primitives and the same order:
 *
 * - `prepareRun` (strict, the run): stop at the first problem, reject unresolved `{{ fixture.* }}`
 *   at the freeze, and hand back a `PreparedRun` whose `contract(...)` verb can only be called
 *   after the inputs resolved — the type forbids freezing out of order.
 * - `checkRun` (tolerant, `difmp validate`): no setup will run, so fixture references stay as
 *   written, ids are placeholders, and EVERY problem is collected instead of stopping at one.
 *
 * The strict door runs the whole input stage before the registry stage; the CLI's scripted factory
 * needs the input stage ALONE (it is built before the run can fail) — `resolveRunInputs` is that
 * stage, the same code the strict door runs first. The preparation is pure and cheap — no browser,
 * no disk — so `runOne` and `runScenario` each run it for themselves rather than threading a half
 * result through the public request; memoizing it later would be a private change behind this
 * same interface (issue #42, decision 5).
 */

/** Anything the preparation can refuse before the run exists. */
export type PrepareError = ConfigInvalidError | InterpolationError | RegistryError;

export interface RunInputsRequest {
  readonly spec: LoadedSpec;
  /** Path recorded in the contract — relative to the config root. */
  readonly specPath: string;
  readonly config: ResolvedConfig;
  readonly runId: string;
  readonly attemptId: string;
  readonly configSource?: string;
  readonly fileInputs?: InputsRecord;
  readonly cliInputs?: Readonly<Record<string, string>>;
}

/**
 * The input stage: config < spec < `--inputs-file` < `--input`, then phase-1 interpolation of the
 * declared values (`{{ run.id }}`, `{{ attempt.id }}` only — inputs may not reference the fixture
 * or each other). `prepareRun` runs exactly this before the registry stage; the scripted factory
 * of the CLI stops here.
 */
export const resolveRunInputs = (
  request: RunInputsRequest,
): Effect.Effect<InputsRecord, PrepareError> =>
  resolveInputPrecedence({
    source: request.configSource ?? request.spec.specPath,
    configInputs: request.config.inputs,
    specInputs: request.spec.frontmatter.inputs ?? {},
    ...(request.fileInputs === undefined ? {} : { fileInputs: request.fileInputs }),
    ...(request.cliInputs === undefined ? {} : { cliInputs: request.cliInputs }),
  }).pipe(
    Effect.flatMap((declared) =>
      resolveInputs({
        declared,
        source: request.spec.specPath,
        run: { id: request.runId },
        attempt: { id: request.attemptId },
        anchors: request.spec.fieldLines,
      }),
    ),
  );

export interface PrepareRunRequest extends RunInputsRequest {
  readonly registries: Registries;
}

export interface PrepareContractOptions {
  /** Public fixture values, once setup ran. Without them, `{{ fixture.* }}` is a strict failure. */
  readonly fixturePublic?: InputsRecord;
}

/** Everything resolved before the freeze: citable inputs and the frozen contract verb. */
export interface PreparedRun {
  readonly inputs: InputsRecord;
  /**
   * Step 3 of the execution loop: interpolate body and criteria STRICTLY, hash them, apply the
   * scenario budget override (`timeoutMs` in the frontmatter replaces `attemptTimeoutMs` — the
   * only budget a scenario is allowed to replace, and it is decided here, once). After the freeze
   * the criterion texts and hashes are immutable for the whole attempt.
   */
  readonly contract: (
    options?: PrepareContractOptions,
  ) => Effect.Effect<ScenarioContract, InterpolationError | PlatformError, Crypto.Crypto>;
}

/**
 * The source positions to interpolate, in the one order that decides error precedence: the body
 * first, then every criterion in source order. `fieldOf` names them in messages — the strict
 * freeze calls a criterion `criteria.c3`, `difmp validate` calls it `c3`.
 */
const textStages = (
  spec: LoadedSpec,
  fieldOf: (criterion: ParsedCriterion) => string,
): ReadonlyArray<{
  readonly field: string;
  readonly text: string;
  readonly anchor: Position;
  readonly criterion: ParsedCriterion | undefined;
}> => [
  {
    field: "body",
    text: spec.body,
    anchor: { line: spec.bodyLine, column: 1 },
    criterion: undefined,
  },
  ...spec.criteria.map((criterion) => ({
    field: fieldOf(criterion),
    text: criterion.sourceText,
    anchor: { line: criterion.line, column: criterion.column },
    criterion,
  })),
];

export const prepareRun = (request: PrepareRunRequest): Effect.Effect<PreparedRun, PrepareError> =>
  Effect.gen(function* () {
    const inputs = yield* resolveRunInputs(request);
    // Registries are validated HERE, not at verification time: a `checks: { c3: not-registered }`
    // mapping must be refused before a browser is opened, not discovered as a criterion `error`
    // once the whole walkthrough has already run.
    yield* validateSpecRegistries({ spec: request.spec, registries: request.registries });

    const contract = (options: PrepareContractOptions = {}) =>
      Effect.gen(function* () {
        const { config, spec } = request;
        const scope: InterpolationScope = {
          run: { id: request.runId },
          attempt: { id: request.attemptId },
          inputs,
          ...(options.fixturePublic === undefined ? {} : { fixture: options.fixturePublic }),
        };

        const texts = yield* Effect.forEach(
          textStages(spec, (criterion) => `criteria.${criterion.id}`),
          (stage) =>
            interpolate({
              text: stage.text,
              source: spec.specPath,
              field: stage.field,
              anchor: stage.anchor,
              scope,
              mode: "strict",
            }),
        );
        const body = texts[0]!;
        const criteria: Array<Criterion> = spec.criteria.map((parsed, index) => ({
          id: parsed.id,
          text: texts[index + 1]!,
          sourceText: parsed.sourceText,
          line: parsed.line,
          column: parsed.column,
          method: parsed.method,
          ...(parsed.checkName === undefined ? {} : { checkName: parsed.checkName }),
        }));

        // The one place a scenario may replace a budget: `timeoutMs` overrides `attemptTimeoutMs`
        // and nothing else. (Was `contract.ts:74–77`, a rule with no owner.)
        const budgets: Budgets =
          spec.timeoutMs === undefined
            ? config.budgets
            : { ...config.budgets, attemptTimeoutMs: spec.timeoutMs };

        const criterionHashes: Record<string, string> = {};
        for (const criterion of criteria) {
          criterionHashes[criterion.id] = yield* sha256Hex(criterion.text);
        }
        const specHash = yield* sha256Hex(spec.source);

        const withoutHashes = {
          schemaVersion: 1 as const,
          specPath: request.specPath,
          id: spec.frontmatter.id,
          tags: spec.frontmatter.tags ?? [],
          ...(spec.frontmatter.fixture === undefined
            ? {}
            : { fixtureName: spec.frontmatter.fixture }),
          body,
          criteria,
          inputs,
          maxActions: spec.frontmatter.maxActions ?? config.maxActions,
          budgets,
        };
        const contractHash = yield* sha256Hex(stableStringify(withoutHashes));

        return {
          ...withoutHashes,
          hashes: {
            spec: specHash,
            contract: contractHash,
            criteria: criterionHashes,
            prompts: {},
          },
        } satisfies ScenarioContract;
      });

    return { inputs, contract };
  });

/**
 * `difmp validate` checks scenarios without a run: the ids are placeholders, nothing is persisted,
 * and every problem is reported at once instead of stopping at the first. Same primitives, same
 * order, tolerant attitude (ADR-0006).
 */
export interface CheckRunRequest {
  readonly spec: LoadedSpec;
  readonly specPath: string;
  readonly config: ResolvedConfig;
  readonly registries: Registries;
  /** Where the config came from — names the file in precedence problems. */
  readonly source: string;
}

/** No setup has run, so these are placeholders — `validate` never touches a browser or a model. */
const placeholderRun = { id: "r_aaaaaaaaaaaaa" };
const placeholderAttempt = { id: "a1" };

export const checkRun = (request: CheckRunRequest): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    const { config, registries, spec } = request;
    const problems: Array<string> = [];

    const declared = yield* resolveInputPrecedence({
      source: request.source,
      configInputs: config.inputs,
      specInputs: spec.frontmatter.inputs ?? {},
    }).pipe(Effect.result);
    let inputs: InputsRecord = {};
    if (declared._tag === "Failure") {
      problems.push(declared.failure.message);
    } else {
      const resolved = yield* resolveInputs({
        declared: declared.success,
        source: spec.specPath,
        run: placeholderRun,
        attempt: placeholderAttempt,
        anchors: spec.fieldLines,
      }).pipe(Effect.result);
      if (resolved._tag === "Failure") problems.push(resolved.failure.message);
      else inputs = resolved.success;
    }

    const scope: InterpolationScope = {
      run: placeholderRun,
      attempt: placeholderAttempt,
      inputs,
    };
    // The body and criteria are walked with `validate` semantics — unresolved `{{ fixture.* }}`
    // stays as written — in the same source order as the freeze, per criterion interleaving its
    // registry problem right after its references (the accumulation order `validate` has always
    // reported).
    for (const stage of textStages(spec, (criterion) => criterion.id)) {
      const checked = yield* validateReferences({
        text: stage.text,
        source: spec.specPath,
        field: stage.field,
        anchor: stage.anchor,
        scope,
      }).pipe(Effect.result);
      if (checked._tag === "Failure") problems.push(checked.failure.message);

      if (stage.criterion === undefined) continue;
      const { id, checkName } = stage.criterion;
      if (checkName === undefined || registries.checks.has(checkName)) continue;
      const lookup = yield* registries.checks.lookup(checkName).pipe(Effect.result);
      if (lookup._tag === "Failure") problems.push(`${id}: ${lookup.failure.message}`);
    }

    const fixtureName = spec.frontmatter.fixture;
    if (fixtureName !== undefined && !registries.fixtures.has(fixtureName)) {
      const lookup = yield* registries.fixtures.lookup(fixtureName).pipe(Effect.result);
      if (lookup._tag === "Failure") problems.push(lookup.failure.message);
    }

    return problems;
  });
