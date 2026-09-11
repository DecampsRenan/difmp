import type { ConfigOverrides, ProviderName, ReporterName, ResolvedConfig } from "@harness/core"
import { Effect, Option } from "effect"
import { UsageError } from "./errors.js"
import { reporterNames } from "./project.js"

export interface OverrideFlags {
  readonly output: Option.Option<string>
  readonly provider: Option.Option<ProviderName>
  readonly model: Option.Option<string>
  readonly baseUrl: Option.Option<string>
  readonly maxActions: Option.Option<number>
  readonly reporter: ReadonlyArray<string>
}

const validateReporters = (values: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<ReporterName>, UsageError> => {
  const unknown = values.filter((value) => !reporterNames.includes(value as ReporterName))
  if (unknown.length > 0) {
    return Effect.fail(
      new UsageError({
        message: `--reporter ${unknown.join(", ")}: unknown reporter (available: ${reporterNames.join(", ")})`
      })
    )
  }
  return Effect.succeed([...new Set(values)] as ReadonlyArray<ReporterName>)
}

/**
 * CLI execution options override `harness.config.ts`. Only the flags actually supplied become
 * overrides — an absent flag leaves the file's value (or the built-in default) alone.
 */
export const toOverrides = (flags: OverrideFlags): Effect.Effect<ConfigOverrides, UsageError> =>
  Effect.gen(function*() {
    const reporters = yield* validateReporters(flags.reporter)
    return {
      ...(Option.isSome(flags.output) ? { outputDir: flags.output.value } : {}),
      ...(Option.isSome(flags.provider) ? { provider: flags.provider.value } : {}),
      ...(Option.isSome(flags.model) ? { model: flags.model.value } : {}),
      ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value } : {}),
      ...(Option.isSome(flags.maxActions) ? { maxActions: flags.maxActions.value } : {}),
      ...(reporters.length === 0 ? {} : { reporters })
    }
  })

const secretish = /(key|token|secret|password|credential|auth)/i

/** Never print a value that looks like a credential, whatever the project put in `providerOptions`. */
export const redactProviderOptions = (
  options: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    out[key] = secretish.test(key) ? "«redacted»" : value
  }
  return out
}

/**
 * The resolved, non-sensitive configuration, printed before launch (spec §8). Secrets live in
 * environment variables and never appear here — `apiKeyEnvVar` names a variable, not a value.
 */
export const describeConfig = (options: {
  readonly config: ResolvedConfig
  readonly source: string
  readonly outputDir: string
  readonly specs: ReadonlyArray<string>
}): ReadonlyArray<string> => {
  const { config } = options
  const lines: Array<string> = ["Resolved configuration"]
  const row = (label: string, value: string) => lines.push(`  ${label.padEnd(16)}${value}`)
  row("config", options.source)
  row("baseUrl", config.baseUrl)
  row("allowedOrigins", config.allowedOrigins.join(", "))
  row("provider", config.provider)
  row("model", config.model ?? "(provider default — none set)")
  row("providerOptions", JSON.stringify(redactProviderOptions(config.providerOptions)))
  row("maxActions", `${config.maxActions} (indicative only)`)
  row("budgets", JSON.stringify(config.budgets))
  row("capture", JSON.stringify(config.capture))
  row("outputDir", options.outputDir)
  row("reporters", config.reporters.join(", "))
  row("inputs", JSON.stringify(config.inputs))
  row("include", JSON.stringify(config.include))
  row("exclude", JSON.stringify(config.exclude))
  row("scenarios", `${options.specs.length}`)
  for (const spec of options.specs) lines.push(`                  ${spec}`)
  return lines
}
