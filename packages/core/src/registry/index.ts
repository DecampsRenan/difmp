import { Crypto, Effect } from "effect"
import { RegistryError } from "../domain/errors.js"
import { sha256Hex } from "../domain/hash.js"
import type { InputsRecord } from "../domain/spec.js"

/** Structural mirror of Playwright's storage state — core never imports Playwright types. */
export interface CookieLike {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly expires: number
  readonly httpOnly: boolean
  readonly secure: boolean
  readonly sameSite: "Strict" | "Lax" | "None"
}

export interface OriginStateLike {
  readonly origin: string
  readonly localStorage: ReadonlyArray<{ readonly name: string; readonly value: string }>
}

export interface StorageStateLike {
  readonly cookies?: ReadonlyArray<CookieLike>
  readonly origins?: ReadonlyArray<OriginStateLike>
}

export interface FixtureContext {
  readonly runId: string
  readonly attemptId: string
  readonly inputs: InputsRecord
  /** Env-backed. Secret values never reach prompts, logs or reports. */
  readonly secrets: (name: string) => string | undefined
  /** Register cleanup AT ACQUISITION time so a partially failed setup is still torn down. */
  readonly addCleanup: (fn: () => Promise<void> | void) => void
  readonly baseUrl: string
}

export interface FixtureResult {
  /** Exposed as `{{ fixture.<key> }}` and visible to the model. */
  readonly public?: InputsRecord
  /** PRIVATE — handed to the browser context only, never to the model. */
  readonly storageState?: StorageStateLike
  readonly cookies?: ReadonlyArray<CookieLike>
  readonly origins?: ReadonlyArray<OriginStateLike>
}

export type Fixture = (ctx: FixtureContext) => Promise<FixtureResult>

export interface CheckCriterion {
  readonly id: string
  readonly text: string
  /** Verified by the harness before the check runs. */
  readonly hash: string
}

export interface CheckContext {
  readonly runId: string
  readonly attemptId: string
  readonly criterion: CheckCriterion
  readonly inputs: InputsRecord
  readonly fixture: { readonly public: InputsRecord }
  readonly baseUrl: string
  /** Journalled as a harness operation; returns the minted artifactId. */
  readonly recordEvidence: (e: { readonly label: string; readonly data: unknown }) => Promise<string>
}

export interface CheckResult {
  readonly status: "passed" | "failed" | "inconclusive"
  readonly expected: string
  readonly observed: string
  readonly evidence: ReadonlyArray<string>
}

export type Check = (ctx: CheckContext) => Promise<CheckResult>

/**
 * What a scripted-adapter script factory is given. A deterministic script has to name real
 * accessible controls and real input values, and both are only known once the run id exists and
 * the inputs are resolved — so the registry holds FACTORIES, not finished scripts.
 *
 * Core stays free of any model SDK: the returned value is opaque here and is typed by the package
 * that owns the scripted adapter (`@harness/agent-runtime`).
 */
export interface ScriptFactoryContext {
  readonly runId: string
  readonly attemptId: string
  readonly scenarioId: string
  /** Relative to the config root, exactly as it appears in the contract. */
  readonly specPath: string
  readonly baseUrl: string
  /** Resolved inputs (config < spec < --inputs-file < --input), with `{{ run.id }}` substituted. */
  readonly inputs: InputsRecord
  /** Criterion ids in source order — a script asks for `check` by id. */
  readonly criterionIds: ReadonlyArray<string>
}

export type ScriptFactory<A = unknown> = (ctx: ScriptFactoryContext) => A

export type RegistryKind = "fixture" | "check" | "script"

export interface Registry<A> {
  readonly kind: RegistryKind
  readonly names: ReadonlyArray<string>
  readonly has: (name: string) => boolean
  readonly lookup: (name: string) => Effect.Effect<A, RegistryError>
}

/** Names are NEVER paths or code: a spec can only reference what the project registered. */
export const makeRegistry = <A>(
  kind: RegistryKind,
  entries: Readonly<Record<string, A>> = {}
): Registry<A> => {
  const names = Object.keys(entries).sort()
  return {
    kind,
    names,
    has: (name) => Object.prototype.hasOwnProperty.call(entries, name),
    lookup: (name) =>
      Object.prototype.hasOwnProperty.call(entries, name)
        ? Effect.succeed(entries[name]!)
        : Effect.fail(new RegistryError({ kind, name, reason: "is not registered in harness.config.ts", registered: names }))
  }
}

export interface Registries {
  readonly fixtures: Registry<Fixture>
  readonly checks: Registry<Check>
  /**
   * Optional: only a run using the deterministic (scripted) adapter resolves a name here. It is
   * declared in `harness.config.ts` next to `fixtures` and `checks` and, like them, a name is
   * never a module path.
   */
  readonly scripts?: Registry<ScriptFactory>
}

/** Reject a registry value that is not a function before a spec ever references it. */
export const validateRegistryShape = (
  kind: RegistryKind,
  entries: unknown
): Effect.Effect<Readonly<Record<string, unknown>>, RegistryError> => {
  if (entries === undefined) return Effect.succeed({})
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    return Effect.fail(
      new RegistryError({ kind, name: `${kind}s`, reason: "must be an object mapping names to functions", registered: [] })
    )
  }
  const record = entries as Record<string, unknown>
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== "function") {
      return Effect.fail(
        new RegistryError({ kind, name, reason: "must be a function", registered: Object.keys(record).sort() })
      )
    }
  }
  return Effect.succeed(record)
}

/**
 * A check bound to `c3` must be running against the criterion text the contract froze.
 * Recomputing the hash makes a silent rebind (someone reordered the expectations) a hard error.
 */
export const verifyCriterionBinding = (options: {
  readonly checkName: string
  readonly criterionId: string
  readonly text: string
  readonly contractHash: string
}): Effect.Effect<string, RegistryError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const actual = yield* sha256Hex(options.text).pipe(
      Effect.mapError((cause) =>
        new RegistryError({
          kind: "check",
          name: options.checkName,
          reason: `cannot hash criterion ${options.criterionId}: ${cause.message}`,
          registered: []
        })
      )
    )
    if (actual !== options.contractHash) {
      return yield* Effect.fail(
        new RegistryError({
          kind: "check",
          name: options.checkName,
          reason:
            `is bound to criterion ${options.criterionId} whose text no longer matches the frozen contract ` +
            `(contract ${options.contractHash.slice(0, 16)}, actual ${actual.slice(0, 16)}) — ` +
            "reordering or editing expectations must not silently rebind a check",
          registered: []
        })
      )
    }
    return actual
  })
