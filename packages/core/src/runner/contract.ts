import { Crypto, Effect } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { Budgets } from "../domain/budgets.js";
import type { ResolvedConfig } from "../domain/config.js";
import type { InterpolationError } from "../domain/errors.js";
import { sha256Hex } from "../domain/hash.js";
import type { Criterion, InputsRecord, LoadedSpec, ScenarioContract } from "../domain/spec.js";
import type { InterpolationScope, ReferenceMode } from "../interpolate/index.js";
import { interpolate } from "../interpolate/index.js";
import { stableStringify } from "./stableJson.js";

export interface FreezeContractOptions {
  readonly spec: LoadedSpec;
  /** Path recorded in the contract — relative to the config root. */
  readonly specPath: string;
  readonly config: ResolvedConfig;
  readonly runId: string;
  readonly attemptId: string;
  /** Already resolved through the input precedence rules and phase-1 interpolation. */
  readonly inputs: InputsRecord;
  readonly fixturePublic?: InputsRecord;
  readonly promptHashes?: Readonly<Record<string, string>>;
  /** `validate` tolerates unresolved `fixture.*`; `run` rejects them after setup. */
  readonly mode?: ReferenceMode;
}

/**
 * Step 3 of the execution loop: resolve and FREEZE the expectations, before navigation.
 * After this the criterion texts and their hashes are immutable for the whole attempt.
 */
export const freezeContract = (
  options: FreezeContractOptions,
): Effect.Effect<ScenarioContract, InterpolationError | PlatformError, Crypto.Crypto> =>
  Effect.gen(function* () {
    const { config, spec } = options;
    const scope: InterpolationScope = {
      run: { id: options.runId },
      attempt: { id: options.attemptId },
      inputs: options.inputs,
      ...(options.fixturePublic === undefined ? {} : { fixture: options.fixturePublic }),
    };
    const mode = options.mode ?? "strict";

    const body = yield* interpolate({
      text: spec.body,
      source: spec.specPath,
      field: "body",
      anchor: { line: spec.bodyLine, column: 1 },
      scope,
      mode,
    });

    const criteria: Array<Criterion> = [];
    for (const parsed of spec.criteria) {
      const text = yield* interpolate({
        text: parsed.sourceText,
        source: spec.specPath,
        field: `criteria.${parsed.id}`,
        anchor: { line: parsed.line, column: parsed.column },
        scope,
        mode,
      });
      criteria.push({
        id: parsed.id,
        text,
        sourceText: parsed.sourceText,
        line: parsed.line,
        column: parsed.column,
        method: parsed.method,
        ...(parsed.checkName === undefined ? {} : { checkName: parsed.checkName }),
      });
    }

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
      specPath: options.specPath,
      id: spec.frontmatter.id,
      tags: spec.frontmatter.tags ?? [],
      ...(spec.frontmatter.fixture === undefined ? {} : { fixtureName: spec.frontmatter.fixture }),
      body,
      criteria,
      inputs: options.inputs,
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
        prompts: options.promptHashes ?? {},
      },
    } satisfies ScenarioContract;
  });
