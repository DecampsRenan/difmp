import type { ConfigOverrides, ProviderName, ReporterName, ResolvedProject } from "@difmp/core"
import { resolveConfig } from "@difmp/core"
import { Effect } from "effect"
import { UsageError } from "./errors.js"
import type { ConfigLocation } from "./loadConfig.js"
import { locateConfig, readConfigModule } from "./loadConfig.js"

export const providerNames: ReadonlyArray<ProviderName> = ["scripted", "anthropic"]
/** What `--reporter` accepts. `html` is not offered: the HTML report is always produced. */
export const reporterNames: ReadonlyArray<ReporterName> = ["console", "json", "junit"]

export interface LoadedProject extends ResolvedProject {
  readonly location: ConfigLocation
}

export interface LoadProjectOptions {
  readonly cwd: string
  readonly configPath?: string
  /** CLI execution options. They always win over the file — see README "Precedence". */
  readonly overrides?: ConfigOverrides
}

/**
 * Locate, load and validate the project configuration. The module is loaded as trusted project
 * code; `resolveConfig` is what rejects unknown keys and bad values.
 */
export const loadProject = (options: LoadProjectOptions): Effect.Effect<LoadedProject, UsageError> =>
  Effect.gen(function*() {
    const location = yield* locateConfig({
      cwd: options.cwd,
      ...(options.configPath === undefined ? {} : { explicit: options.configPath })
    })
    const raw = yield* readConfigModule(location)
    const resolved = yield* resolveConfig({
      source: location.source,
      config: raw,
      ...(options.overrides === undefined ? {} : { overrides: options.overrides })
    }).pipe(Effect.mapError((error) => new UsageError({ message: error.message })))
    return { ...resolved, location }
  })
