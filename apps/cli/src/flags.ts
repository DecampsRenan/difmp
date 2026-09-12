import { Schema } from "effect"
import { Argument, Flag } from "effect/unstable/cli"

const InputValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
const InputsFile = Schema.Record(Schema.String, InputValue)

/**
 * Files, directories or globs. A quoted glob (`difmp run '**\/*.e2e.md'`) arrives here
 * unexpanded — bash only recurses on `**` with `shopt -s globstar`, and `cmd` expands nothing —
 * so the harness always does the matching itself.
 */
export const pathsArgument = Argument.String("paths").pipe(
  Argument.withDescription("Scenario files, directories or globs (quote globs so the shell leaves them alone)"),
  Argument.variadic()
)

export const configFlag = Flag.String("config").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Path to difmp.config.ts (default: nearest one above the working directory)"),
  Flag.optional
)

export const tagFlag = Flag.String("tag").pipe(
  Flag.withDescription("Only scenarios carrying this tag. Repeatable; a scenario matches any of them."),
  Flag.atLeast(0)
)

/** `--input k=v` repeats merge into one record and ALWAYS yield strings. */
export const inputFlag = Flag.KeyValuePair("input").pipe(
  Flag.withAlias("i"),
  Flag.withDescription("Scenario input, repeatable: --input key=value (always a string)"),
  Flag.withDefault({} as Record<string, string>)
)

/** `--inputs-file` is read AND decoded by the flag itself, so JSON types survive. */
export const inputsFileFlag = Flag.FileSchema("inputs-file", InputsFile, { format: "json" }).pipe(
  Flag.withDescription("JSON file of scenario inputs (string/number/boolean types preserved)"),
  Flag.optional
)

export const reporterFlag = Flag.String("reporter").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Reporter, repeatable: console | json | junit (default: console)"),
  Flag.atLeast(0)
)

export const outputFlag = Flag.String("output").pipe(
  Flag.withAlias("o"),
  Flag.withDescription("Directory the run directories are written to (default: runs)"),
  Flag.optional
)

export const providerFlag = Flag.Literals("provider", ["scripted", "anthropic"]).pipe(
  Flag.withDescription("Model provider (overrides difmp.config.ts)"),
  Flag.optional
)

export const modelFlag = Flag.String("model").pipe(
  Flag.withDescription("Provider-specific model id (overrides difmp.config.ts)"),
  Flag.optional
)

export const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.withDescription("Application under test (overrides difmp.config.ts)"),
  Flag.optional
)

export const maxActionsFlag = Flag.Int("max-actions").pipe(
  Flag.withDescription("Indicative action threshold. Crossing it is surfaced, never a refusal."),
  Flag.optional
)

export const uiFlag = Flag.Boolean("ui").pipe(
  Flag.withDescription("Serve the live dashboard while the run progresses (loopback only)"),
  Flag.withDefault(false)
)

export const uiPortFlag = Flag.Int("ui-port").pipe(
  Flag.withDescription("Port for --ui (default: 0, an ephemeral port)"),
  Flag.withDefault(0)
)

export const uiHostFlag = Flag.String("ui-host").pipe(
  Flag.withDescription("Host for --ui (default: 127.0.0.1; anything else is not loopback)"),
  Flag.withDefault("127.0.0.1")
)

export const headedFlag = Flag.Boolean("headed").pipe(
  Flag.withDescription("Run the browser with a visible window"),
  Flag.withDefault(false)
)

export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Machine-readable output on stdout"),
  Flag.withDefault(false)
)

/** The shape shared by `difmp run` and the bare `difmp` alias. */
export const runConfig = {
  paths: pathsArgument,
  config: configFlag,
  tag: tagFlag,
  input: inputFlag,
  inputsFile: inputsFileFlag,
  reporter: reporterFlag,
  output: outputFlag,
  provider: providerFlag,
  model: modelFlag,
  baseUrl: baseUrlFlag,
  maxActions: maxActionsFlag,
  ui: uiFlag,
  uiPort: uiPortFlag,
  uiHost: uiHostFlag,
  headed: headedFlag
}

export const selectConfig = {
  paths: pathsArgument,
  config: configFlag,
  tag: tagFlag,
  json: jsonFlag
}
