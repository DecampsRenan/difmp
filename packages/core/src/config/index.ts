import { Effect } from "effect";
import { alwaysExcluded, ProviderName, ReporterName, ResolvedConfig } from "../domain/config.js";
import { decodeStrict, schemaProblems } from "../domain/decode.js";
import { ConfigInvalidError } from "../domain/errors.js";
import type { InputsRecord, InputValue } from "../domain/spec.js";
import type { Check, Fixture, Registries, ScriptFactory } from "../registry/index.js";
import { makeRegistry, validateRegistryShape } from "../registry/index.js";

export type HarnessConfigData = (typeof ResolvedConfig)["Encoded"];

/** The type a consumer's `difmp.config.ts` is written against. */
export interface HarnessUserConfig extends HarnessConfigData {
  /** Names referenced by specs resolve HERE, never as import paths. */
  readonly fixtures?: Record<string, Fixture>;
  readonly checks?: Record<string, Check>;
  /**
   * Deterministic-adapter scripts, by name. Only `provider: "scripted"` resolves one, through
   * `providerOptions.script`. Like fixtures and checks these are functions, so they are stripped
   * before validation and never reach `manifest.json`.
   */
  readonly scripts?: Record<string, ScriptFactory<any>>;
}

/** Identity + types. The real validation happens in `resolveConfig`. */
export const defineConfig = (config: HarnessUserConfig): HarnessUserConfig => config;

export interface ConfigOverrides {
  readonly baseUrl?: string;
  readonly include?: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string>;
  readonly provider?: (typeof ProviderName)["Type"];
  readonly model?: string;
  readonly outputDir?: string;
  readonly reporters?: ReadonlyArray<(typeof ReporterName)["Type"]>;
  readonly maxActions?: number;
}

export interface ResolvedProject {
  readonly source: string;
  readonly config: ResolvedConfig;
  readonly registries: Registries;
}

const decodeConfig = decodeStrict(ResolvedConfig);

const unique = <A>(values: Iterable<A>): ReadonlyArray<A> => Array.from(new Set(values));

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

const defined = <A extends object>(value: A): A => {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v;
  }
  return out as A;
};

/**
 * Validate an already-loaded configuration object. Loading the TS module is the CLI's job:
 * core never resolves a module path, and never one named by a spec.
 */
export const resolveConfig = (options: {
  readonly source: string;
  readonly config: unknown;
  readonly overrides?: ConfigOverrides;
}): Effect.Effect<ResolvedProject, ConfigInvalidError> =>
  Effect.gen(function* () {
    const { config, source } = options;
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return yield* Effect.fail(
        new ConfigInvalidError({
          source,
          problems: ["the default export must be an object (use defineConfig)"],
        }),
      );
    }
    const {
      checks: rawChecks,
      fixtures: rawFixtures,
      scripts: rawScripts,
      ...data
    } = config as Record<string, unknown>;

    const toConfigError = (problems: ReadonlyArray<string>) =>
      new ConfigInvalidError({ source, problems });

    const fixtures = yield* validateRegistryShape("fixture", rawFixtures).pipe(
      Effect.mapError((e) => toConfigError([e.message])),
    );
    const checks = yield* validateRegistryShape("check", rawChecks).pipe(
      Effect.mapError((e) => toConfigError([e.message])),
    );
    const scripts = yield* validateRegistryShape("script", rawScripts).pipe(
      Effect.mapError((e) => toConfigError([e.message])),
    );

    const merged = { ...data, ...defined(options.overrides ?? {}) };

    const decoded = yield* decodeConfig(merged).pipe(
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(
          new ConfigInvalidError({
            source,
            problems: schemaProblems(error).map((p) =>
              p.path === "" ? p.message : `${p.path}: ${p.message}`,
            ),
          }),
        ),
      ),
    );

    const baseOrigin = originOf(decoded.baseUrl);
    if (baseOrigin === undefined) {
      return yield* Effect.fail(
        toConfigError([`baseUrl: ${JSON.stringify(decoded.baseUrl)} is not an absolute URL`]),
      );
    }
    const badOrigins = decoded.allowedOrigins.filter((origin) => originOf(origin) === undefined);
    if (badOrigins.length > 0) {
      return yield* Effect.fail(
        toConfigError(
          badOrigins.map((o) => `allowedOrigins: ${JSON.stringify(o)} is not an absolute origin`),
        ),
      );
    }

    const resolved: ResolvedConfig = {
      ...decoded,
      exclude: unique([...alwaysExcluded, ...decoded.exclude]),
      // The baseUrl origin is always allowed.
      allowedOrigins: unique([baseOrigin, ...decoded.allowedOrigins.map((o) => originOf(o)!)]),
    };

    return {
      source,
      config: resolved,
      registries: {
        fixtures: makeRegistry<Fixture>("fixture", fixtures as Record<string, Fixture>),
        checks: makeRegistry<Check>("check", checks as Record<string, Check>),
        scripts: makeRegistry<ScriptFactory>("script", scripts as Record<string, ScriptFactory>),
      },
    };
  });

export interface InputPrecedenceOptions {
  readonly source: string;
  /** Lowest priority. */
  readonly configInputs: InputsRecord;
  readonly specInputs: InputsRecord;
  /** `--inputs-file <json>` — JSON types preserved. */
  readonly fileInputs?: InputsRecord;
  /** `--input k=v` — always strings, highest priority. */
  readonly cliInputs?: Readonly<Record<string, string>>;
}

/**
 * Precedence: config < spec < --inputs-file < --input.
 * Keys that neither the config nor the spec declares are REJECTED, whichever side supplies them.
 */
export const resolveInputPrecedence = (
  options: InputPrecedenceOptions,
): Effect.Effect<InputsRecord, ConfigInvalidError> =>
  Effect.suspend(() => {
    const declared = new Set([
      ...Object.keys(options.configInputs),
      ...Object.keys(options.specInputs),
    ]);
    const undeclared: Array<string> = [];
    for (const key of Object.keys(options.fileInputs ?? {})) {
      if (!declared.has(key))
        undeclared.push(
          `--inputs-file declares "${key}", which is not an input of the config or the spec`,
        );
    }
    for (const key of Object.keys(options.cliInputs ?? {})) {
      if (!declared.has(key))
        undeclared.push(
          `--input declares "${key}", which is not an input of the config or the spec`,
        );
    }
    if (undeclared.length > 0) {
      return Effect.fail(new ConfigInvalidError({ source: options.source, problems: undeclared }));
    }
    const merged: Record<string, InputValue> = {
      ...options.configInputs,
      ...options.specInputs,
      ...options.fileInputs,
      ...options.cliInputs,
    };
    return Effect.succeed(merged);
  });
