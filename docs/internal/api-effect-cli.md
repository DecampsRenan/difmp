# Effect v4 CLI cheat-sheet (`effect/unstable/cli`)

Verified against `effect@4.0.0-rc.113` / `@effect/platform-node@4.0.0-rc.113`.
Sources: `node_modules/effect/src/unstable/cli/*.ts`, `node_modules/effect/ai-docs/src/70_cli/`.
Every ```ts block below was compiled with
`npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck`
(files kept in `.recon/`). Runtime behaviour was additionally exercised with `tsx`.

> pnpm note: `effect` is not a root dependency in this workspace. To typecheck `.recon/*.ts` the
> recon agent symlinked `node_modules/effect`, `node_modules/@effect/platform-node`,
> `node_modules/@effect/platform-node-shared` into the pnpm store. Real packages must declare
> `effect` + `@effect/platform-node` in their own `package.json`.

## 0. Imports

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Effect, Exit, Layer, Option, Runtime, Schema, Stdio } from "effect"
import {
  Argument, CliConfig, CliError, CliOutput, Command, Completions,
  Flag, GlobalFlag, HelpDoc, Param, Primitive, Prompt
} from "effect/unstable/cli"
```

There is **no** `@effect/cli` package in v4. Everything lives under the `effect` package at
`effect/unstable/cli` (single entry point; `effect/unstable/cli/Command` is *not* an export path).

## 1. Command

```ts
interface Command<in out Name extends string, in Input, out ContextInput = {}, out E = never, out R = never>
  extends Effect.Effect<ContextInput, never, CommandContext<Name>> {}
```

A `Command` **is itself an Effect** that yields the *parent's* parsed input — that is how a
subcommand reads parent flags: `const root = yield* harness`.

| function | signature (curried form) |
|---|---|
| `Command.make` | `(name)` / `(name, config)` / `(name, config, handler)` |
| `Command.withHandler` | `<A,R,E>(handler: (value: A) => Effect<void,E,R>) => (self) => Command<Name,A,ContextInput,E,...>` |
| `Command.withSubcommands` | `<Subs extends ReadonlyArray<Command.SubcommandEntry>>(subs) => (self) => Command<Name, Simplify<Input \| ContextInput>, ContextInput, E \| SubE, R \| SubR>` |
| `Command.withSharedFlags` | `(flags: Command.FlagConfig) => (self) => Command<Name, Input & Infer<F>, ContextInput & Infer<F>, E, R>` |
| `Command.withGlobalFlags` | `(flags: ReadonlyArray<GlobalFlag.GlobalFlag<any>>)` |
| `Command.withDescription` / `withShortDescription` / `withAlias` / `withExamples` / `unlisted` / `annotate` / `annotateMerge` / `withMetavar`(params) | metadata |
| `Command.provide` / `provideSync` / `provideEffect` / `provideEffectDiscard` | give the *handler* services; `provideEffect(key, effect \| (input) => effect)` can depend on parsed input |
| `Command.run` | runner using `Stdio` args |
| `Command.runWith` | runner with an explicit `ReadonlyArray<string>` |
| `Command.wizard` | interactive wizard |
| `Command.isCommand` | guard |

`Command.Config` values may be a `Param`, a nested object, or an array of those. Inference helper:
`Command.Command.Config.Infer<typeof config>` (note the doubled `Command.Command` — `Command` is both
the module and the interface namespace).

**A command with no handler fails with `CliError.ShowHelp({errors: []})`**, which carries
`[Runtime.errorExitCode] = 0` — i.e. bare `mycli` prints help and exits 0.

## 2. Flag

Constructors (all `(name: string) => Flag<A>` unless noted):

```
Flag.String        -> Flag<string>
Flag.Boolean       -> Flag<boolean>          (supports --no-<name> negation)
Flag.Int           -> Flag<number>
Flag.Finite        -> Flag<number>
Flag.Date          -> Flag<Date>
Flag.Redacted      -> Flag<Redacted<string>>
Flag.Path(name, { pathType?: "file"|"directory"|"either", mustExist?: boolean, typeName?: string })
Flag.File(name, { mustExist?: boolean })                      -> Flag<string>
Flag.Directory(name, { mustExist?: boolean })                 -> Flag<string>
Flag.FileText      -> Flag<string>            (reads the file)
Flag.FileParse(name, options?: Primitive.FileParseOptions)                        -> Flag<unknown>
Flag.FileSchema(name, schema: Schema.ConstraintDecoder<A, Environment>, options?) -> Flag<A>
Flag.Literals(name, ["a","b"] as const)                       -> Flag<"a"|"b">
Flag.ChoiceWithValue(name, [["a", 1], ["b", 2]] as const)      -> Flag<1|2>
Flag.KeyValuePair(name)                                       -> Flag<Record<string,string>>
Flag.Never                                                     -> Flag<never>  (const, not a fn)
```

Combinators:

```
Flag.withAlias(alias)          leading dashes are STRIPPED: "-i", "--i", "i" all give alias "i"
                               help renders 1-char aliases as -x, longer as --xx
Flag.withDescription(text)
Flag.withMetavar(text)
Flag.withHidden               (parses, omitted from --help)
Flag.optional                 -> Flag<Option.Option<A>>
Flag.withDefault(a)           -> Flag<A>
Flag.withFallbackConfig(config)
Flag.withFallbackPrompt(prompt)
Flag.withSchema(schema)
Flag.map / mapEffect / mapTryCatch / filter / filterMap / orElse / orElseResult
Flag.atLeast(n) / Flag.atMost(n) / Flag.between(min,max)   -> Flag<ReadonlyArray<A>>
```

### Repeated (array) flags

**There is no `Flag.repeated` and no `Flag.variadic`.** Use `Flag.atLeast(0)`:

```ts
import { Flag } from "effect/unstable/cli"
// --reporter json --reporter html  ->  ReadonlyArray<string>
const reporters = Flag.String("reporter").pipe(
  Flag.withAlias("r"),
  Flag.atLeast(0)
)
```

`Param.variadic(param, { min?, max? })` is the underlying primitive and works for either kind, but
`Flag` does not re-export it; `Flag.between/atLeast/atMost` delegate to it.

### Repeated `key=value` flags

`Flag.KeyValuePair` is native and **merges repeats into one record** — exactly what
`--input k=v` needs. Both `--input a=1 --input b=2` and `--input=a=1 --input=b=2` work.

```ts
import { Flag } from "effect/unstable/cli"
const inputKV = Flag.KeyValuePair("input").pipe(
  Flag.withAlias("i"),
  Flag.withDescription("Scenario input, repeatable: --input key=value"),
  Flag.withDefault({} as Record<string, string>) // KeyValuePair requires >=1 pair otherwise
)
```

## 3. Argument (positionals)

Same constructor set as `Flag` **minus** `Boolean` and `KeyValuePair`, **plus** `Argument.Never`.
Combinators: `optional`, `withDefault`, `withDescription`, `withMetavar`, `withSchema`,
`withFallbackConfig`, `withFallbackPrompt`, `map`, `mapEffect`, `mapTryCatch`, `filter`,
`filterMap`, `orElse`, `orElseResult`, `atLeast`, `atMost`, `between`, `ChoiceWithValue`,
**`variadic`**.

### Variadic positionals — `harness run [paths...]`

`Argument.variadic` is `dual`, so **both** of these are valid (the ai-docs use both spellings):

```ts
import { Argument } from "effect/unstable/cli"
const anyPaths  = Argument.String("paths").pipe(Argument.variadic)        // no parens
const somePaths = Argument.String("paths").pipe(Argument.variadic())      // parens
const bounded   = Argument.String("paths").pipe(Argument.variadic({ min: 1, max: 3 }))
```

`min: 0` (the default) renders as `[<paths...>]` and is optional. Violations surface as
`CliError.MissingArgument` (too few) / `CliError.UnexpectedArgument` (too many).

`--` ends flag parsing: everything after it becomes positional (`harness run -- --not-a-flag b.yaml`
→ `paths === ["--not-a-flag", "b.yaml"]`). Verified at runtime.

## 4. Root command that is ALSO the default subcommand

**Supported, with a caveat.** `Command.withSubcommands` keeps the parent's own handler: the parser
only treats the first positional token as a subcommand if it matches a subcommand name/alias
(`internal/parser.ts: resolveFirstValue`); otherwise, **if the parent declares positional
arguments**, it is collected as a positional and the parent's own handler runs.

Recipe: give the root the *same* config as `run`, and reuse the handler.

```ts
const runConfig = { paths, input: inputKV, reporter: reporters /* ... */ }
const harness = Command.make("harness", runConfig).pipe(
  Command.withSharedFlags({ verbose }),
  Command.withHandler(runHandler)
)
const run = Command.make("run", runConfig, (cfg) => /* same handler */)
const cli = harness.pipe(Command.withSubcommands([run, list, validate, report]))
```

Verified: `harness 'e2e/**/*.yaml' a.yaml -i user=bob -r json` runs the root handler, exit 0;
`harness run ...` runs the subcommand; `harness list` runs the `list` subcommand.

**GOTCHAS**

- A typo'd subcommand is silently swallowed as a positional: `harness rnu` → `paths === ["rnu"]`,
  exit 0, **no "did you mean" suggestion**. `UnknownSubcommand` is only raised when the parent has
  *no* positional args (`toImpl(command).config.arguments.length > 0` gate). If you want typo
  detection you must validate the glob list yourself in the handler.
- A file literally named `run`/`list`/`validate`/`report` in argv position 1 is taken as the
  subcommand. Users must write `harness ./run` or `harness -- run`.
- Duplicating the config means duplicating flag definitions; that is fine (they are separate
  `Command`s), but a *shared* flag on the root that is also declared locally on a subcommand throws
  at construction time (`checkForDuplicateFlags`).
- There is **no** `Command.withDefaultSubcommand` / `defaultCommand` API. This recipe is the only
  supported way.

## 5. CliConfig, global flags, help, version

```ts
class CliConfig extends Context.Reference<CliConfig.Service>("effect/unstable/cli/CliConfig", ...)
interface CliConfig.Service { readonly builtIns: ReadonlyArray<GlobalFlag.BuiltIn> }
CliConfig.defaults           // { builtIns: GlobalFlag.BuiltIns }
CliConfig.make(partial?)     // value
CliConfig.layer(partial?)    // Layer.Layer<never>
```

`builtIns` is the **only** knob. Ordering matters: earlier Action flags win.

```
GlobalFlag.BuiltIns = [Help, Version, Wizard, Completions, LogLevel]
  Help        --help,   -h
  Version     --version, -v      prints "<name> v<version>", exit 0
  Wizard      --wizard
  Completions --completions <bash|zsh|fish|sh>
  LogLevel    --log-level <all|trace|debug|info|warn|warning|error|fatal|none>   (a Setting)
```

Drop the ones you do not want:

```ts
const configLayer = CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] })
```

Custom global flags:

```ts
const NoColor = GlobalFlag.Setting("no-color")({
  flag: Flag.Boolean("no-color").pipe(Flag.withDefault(false))
})   // readable in a handler with `yield* NoColor`
const PrintPath = GlobalFlag.Action({
  flag: Flag.Boolean("print-path").pipe(Flag.withDefault(false)),
  run: (_value, ctx) => Console.log(ctx.commandPath.join(" "))  // Action short-circuits, then exits
})
// attach with Command.withGlobalFlags([NoColor, PrintPath])
```

**GOTCHA — `-v` collision.** A local `Flag.withAlias("v")` on `--verbose` **shadows** the built-in
`--version, -v`. Verified: `harness -v` runs the command in verbose mode; `--version` still works.
Either drop the alias or drop `GlobalFlag.Version` from `builtIns`.

Help output shape (verified):

```
DESCRIPTION / USAGE / ARGUMENTS / FLAGS / GLOBAL FLAGS / SUBCOMMANDS / EXAMPLES
USAGE: harness <subcommand> [flags] [<paths...>]
```

`<subcommand>` only appears when at least one non-`unlisted` subcommand exists.
Help is printed with `Console.log`; errors with `Console.error`. Formatting is a swappable service:

```ts
CliOutput.Formatter                                  // Context.Reference<Formatter>
CliOutput.defaultFormatter({ colors: false })        // deterministic, ANSI-free
CliOutput.layer(formatter)                           // Layer.Layer<never>
```

## 6. Runner + exit codes

```ts
Command.run(config): <...>(command) => Effect<void, E | CliError, R | Command.Environment>
Command.run(command, config): Effect<void, E | CliError, R | Command.Environment>
Command.runWith(command, config): (argv: ReadonlyArray<string>) => Effect<void, ..., R | Environment>

config = { readonly version: string; readonly renderErrors?: boolean | undefined }
```

`Command.Environment = FileSystem | Path | Terminal | ChildProcessSpawner | Stdio`.
`NodeServices.layer` provides all of them (plus `Crypto`).

`renderErrors: false` suppresses only the `ERROR` block and `UserError` rendering — **help docs are
always printed**.

### Exit codes

`NodeRuntime.runMain(effect, { disableErrorReporting?, teardown? })` (dual: also
`.pipe(NodeRuntime.runMain(opts))`). `Runtime.defaultTeardown` rules:

| situation | code |
|---|---|
| success | `0` |
| `Cause.hasInterruptsOnly` (SIGINT / SIGTERM) | `130` |
| failure with `[Runtime.errorExitCode]` on the squashed error | that number |
| any other failure | `1` |

Control a code by putting the marker on your error class:

```ts
class UsageError extends Schema.TaggedError<UsageError>()("UsageError", { message: Schema.String }) {
  readonly [Runtime.errorExitCode] = 2
  readonly [Runtime.errorReported] = false   // suppress the automatic Effect.logError(cause)
}
```

Built-in CLI error codes: `ShowHelp` carries `[errorExitCode] = errors.length ? 1 : 0` and
`[errorReported] = false`. **Every other `CliError` (UnrecognizedOption, MissingOption, InvalidValue,
UnknownSubcommand, …) is wrapped in `ShowHelp`, so out of the box a bad invocation exits `1`, not
`2`.** To get `2`, supply a custom teardown:

```ts
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit)) return onExit(0)
  if (Cause.hasInterruptsOnly(exit.cause)) return onExit(130)
  const err = Cause.squash(exit.cause)
  if (CliError.isCliError(err)) {
    if (err._tag === "ShowHelp") return onExit(err.errors.length > 0 ? 2 : 0)
    if (err._tag !== "UserError") return onExit(2)
  }
  return onExit(Runtime.getErrorExitCode(err) ?? 1)
}
```

Verified exit codes with this teardown: `--help` 0, `--version` 0, good run 0, `--nope` 2,
missing required arg 2, `UsageError` 2, `FailedRun` 1.

### SIGINT -> 130

**Automatic, nothing to write.** `platform-node-shared/NodeRuntime.runMain` installs
`process.on("SIGINT" | "SIGTERM")` → `fiber.interruptUnsafe(fiber.id)`; the exit is
interrupts-only, so `defaultTeardown` yields `130`. Finalizers run first. Verified end-to-end:

```ts
const root = Command.make("sleeper", {}, Effect.fnUntraced(function*() {
  yield* Console.log("working")
  yield* Effect.sleep("30 seconds")
}, Effect.onInterrupt(() => Console.log("interrupted, cleaning up"))))
root.pipe(Command.run({ version: "1.0.0" }), Effect.provide(NodeServices.layer), NodeRuntime.runMain)
// $ kill -INT <pid>  ->  prints "interrupted, cleaning up", exit 130
```

A **custom** teardown must reimplement the interrupt branch (see above) or you lose 130.
`process.exit(code)` is only called when a signal was received **or** `code !== 0`; a clean success
lets Node exit naturally (pending handles can keep it alive).

## 7. CliError

```ts
type CliError =
  | UnrecognizedOption  { option: string; command?: ReadonlyArray<string>; suggestions: ReadonlyArray<string> }
  | DuplicateOption     { option: string; parentCommand: string; childCommand: string }
  | MissingOption       { option: string }
  | MissingArgument     { argument: string }
  | UnexpectedArgument  { arguments: ReadonlyArray<string> }   // NOTE: plural, an array
  | InvalidValue        { option: string; value: string; expected: string; kind: "flag" | "argument" }
  | UnknownSubcommand   { subcommand: string; parent?: ReadonlyArray<string>; suggestions: ReadonlyArray<string> }
  | ShowHelp            { commandPath: ReadonlyArray<string>; errors: ReadonlyArray<NonShowHelpErrors> }
  | UserError           { cause: unknown; userMessage?: string }
CliError.isCliError(u): u is CliError
CliError.NonShowHelpErrors   // Schema.Union of everything except ShowHelp
```

All are `Schema.TaggedError`s, so `_tag` narrowing works and they are `yield*`-able directly.
Parse failures never reach your code as the concrete error: they are collected into
`ShowHelp.errors`. Handler failures of type `UserError` are rendered by the runner and then
re-failed with `[errorReported] = false`.

## 8. Testing a CLI in-process (capture stdout/stderr + exit code)

```ts
const TestLayer = Layer.provideMerge(Stdio.layerTest({}), NodeServices.layer) // layerTest must be ON TOP
const exec = (argv: ReadonlyArray<string>) =>
  Effect.suspend(() => {
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    const testConsole: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...a: ReadonlyArray<unknown>) => stdout.push(a.join(" ")),
      error: (...a: ReadonlyArray<unknown>) => stderr.push(a.join(" "))
    })
    return Command.runWith(root, { version: "1.0.0" })(argv).pipe(
      Effect.provideService(Console.Console, testConsole),
      Effect.provide(CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))),
      Effect.exit,
      Effect.map((exit) => ({
        code: Exit.isSuccess(exit) ? 0
          : Cause.hasInterruptsOnly(exit.cause) ? 130
          : Runtime.getErrorExitCode(Cause.squash(exit.cause)) ?? 1,
        stdout, stderr
      })),
      Effect.provide(TestLayer)
    )
  })
```

Verified output: `{ code: 0, stdout: ['{"paths":["a.ts"],"reporter":["json"]}'] }`, and for
`["run","--zzz"]`: `code: 1`, `stderr: ['\nERROR\n  Unrecognized flag: --zzz in command harness run']`.
Help/errors go through `Console`, **not** through the `Stdio` sinks, so overriding `Console.Console`
is the capture point. `Stdio.layerTest({ args })` only feeds `Command.run`'s argv.

## 9. Full compiled worked example

`.recon/cli-harness.ts` — compiles clean and was run for every case below.

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Effect, Exit, Option, Runtime, Schema } from "effect"
import { Argument, CliConfig, CliError, Command, Flag } from "effect/unstable/cli"

// --- custom exit-code errors -------------------------------------------------
class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String
}) {
  readonly [Runtime.errorExitCode] = 2
  readonly [Runtime.errorReported] = false
}

class FailedRun extends Schema.TaggedError<FailedRun>()("FailedRun", {
  failed: Schema.Number
}) {
  readonly [Runtime.errorExitCode] = 1
  readonly [Runtime.errorReported] = false
}

// --- reusable params ---------------------------------------------------------
const inputKV = Flag.KeyValuePair("input").pipe(
  Flag.withAlias("i"),
  Flag.withDescription("Scenario input, repeatable: --input key=value"),
  Flag.withDefault({} as Record<string, string>)
)

const reporters = Flag.String("reporter").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Reporter, repeatable"),
  Flag.atLeast(0)
)

const paths = Argument.String("paths").pipe(
  Argument.withDescription("Scenario file globs"),
  Argument.variadic()
)

const runConfig = {
  paths,
  input: inputKV,
  reporter: reporters,
  headless: Flag.Boolean("headless").pipe(Flag.withDefault(true)),
  concurrency: Flag.Int("concurrency").pipe(Flag.withDefault(1)),
  outDir: Flag.Path("out-dir", { mustExist: false }).pipe(Flag.optional)
}

const verbose = Flag.Boolean("verbose").pipe(Flag.withAlias("v"), Flag.withDefault(false))

type RunInput = Command.Command.Config.Infer<typeof runConfig> & { readonly verbose: boolean }

const runHandler = Effect.fnUntraced(function*(cfg: RunInput) {
  if (cfg.verbose) yield* Console.log("verbose on")
  if (cfg.concurrency < 1) return yield* new UsageError({ message: "bad --concurrency" })
  yield* Console.log(JSON.stringify({
    paths: cfg.paths,
    input: cfg.input,
    reporter: cfg.reporter,
    headless: cfg.headless,
    outDir: Option.getOrNull(cfg.outDir)
  }))
  const failed = 0
  if (failed > 0) return yield* new FailedRun({ failed })
})

// --- root command: own config == `run` config, so bare `harness <globs>` works
const harness = Command.make("harness", runConfig).pipe(
  Command.withSharedFlags({ verbose }),
  Command.withDescription("Agentic E2E harness"),
  Command.withHandler(runHandler)
)

const run = Command.make("run", runConfig, (cfg) =>
  Effect.flatMap(harness, (root) => runHandler({ ...cfg, verbose: root.verbose }))).pipe(
    Command.withDescription("Run scenarios"),
    Command.withExamples([
      { command: "harness run 'e2e/**/*.yaml' -i user=bob -r json", description: "Run" }
    ])
  )

const list = Command.make("list", {
  paths,
  json: Flag.Boolean("json").pipe(Flag.withDefault(false))
}, Effect.fnUntraced(function*(cfg) {
  const root = yield* harness
  if (root.verbose) yield* Console.log("verbose on")
  yield* Console.log(cfg.json ? JSON.stringify(cfg.paths) : cfg.paths.join("\n"))
})).pipe(Command.withAlias("ls"), Command.withDescription("List scenarios"))

const validate = Command.make("validate", {
  paths,
  strict: Flag.Boolean("strict").pipe(Flag.withDefault(false))
}, Effect.fnUntraced(function*(cfg) {
  if (cfg.strict && cfg.paths.length === 0) {
    return yield* new UsageError({ message: "no scenarios matched" })
  }
  yield* Console.log("ok")
})).pipe(Command.withDescription("Validate scenario files"))

const report = Command.make("report", {
  from: Argument.Directory("from", { mustExist: true }),
  format: Flag.Literals("format", ["html", "json", "junit"]).pipe(Flag.withDefault("html"))
}, Effect.fnUntraced(function*(cfg) {
  yield* Console.log(`${cfg.format} <- ${cfg.from}`)
})).pipe(Command.withDescription("Render a report"))

const cli = harness.pipe(Command.withSubcommands([run, list, validate, report]))

// --- runner + exit codes -----------------------------------------------------
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit)) return onExit(0)
  if (Cause.hasInterruptsOnly(exit.cause)) return onExit(130)
  const err = Cause.squash(exit.cause)
  if (CliError.isCliError(err)) {
    if (err._tag === "ShowHelp") return onExit(err.errors.length > 0 ? 2 : 0)
    if (err._tag !== "UserError") return onExit(2)
  }
  return onExit(Runtime.getErrorExitCode(err) ?? 1)
}

cli.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
  Effect.provide(CliConfig.layer({})),
  NodeRuntime.runMain({ teardown })
)
```

Observed runs:

```
$ harness 'e2e/**/*.yaml' a.yaml -i user=bob -i env=ci -r json -r html --concurrency 4
{"paths":["e2e/**/*.yaml","a.yaml"],"input":{"user":"bob","env":"ci"},"reporter":["json","html"],"headless":true,"outDir":null}   exit 0
$ harness --no-headless a.yaml      -> headless:false                                   exit 0
$ harness run -- --not-a-flag b.yaml -> paths:["--not-a-flag","b.yaml"]                 exit 0
$ harness --input=a=1 --input=b=2 --reporter=json x  -> input:{a:"1",b:"2"}             exit 0
$ harness --help / --version / list                                                     exit 0
$ harness --nope        -> help + "ERROR Unrecognized flag: --nope in command harness"  exit 2
$ harness report        -> "Missing required argument: from"                            exit 2
$ harness run --concurrency 0 x.yaml                                                    exit 2
$ harness rnu           -> treated as a glob, paths:["rnu"]                             exit 0  (!)
$ <SIGINT>                                                                              exit 130
```

## 10. Things that do NOT exist / fallbacks

- **No `Command.withDefaultSubcommand`.** Fallback: §4 recipe (root declares the same config).
- **No `Flag.repeated` / `Flag.variadic` / `Flag.array`.** Fallback: `Flag.atLeast(0)`.
- **No `Argument.repeated`.** Use `Argument.variadic`.
- **No built-in exit-code-2-for-usage-errors.** Fallback: custom `Runtime.Teardown` (§6).
- **No way to raise a CLI error with a chosen exit code from the parser.** Parse errors are always
  wrapped in `ShowHelp`. Distinguish in the teardown, not in the handler.
- **No `CliConfig` knobs for case sensitivity, auto-correct distance, `--flag=value` handling, or
  `showTypes`** (those were Effect v3 `@effect/cli` options). `builtIns` is the only field.
- **No `Command.withFooter` / `withHeader`.** Only `withDescription`, `withShortDescription`,
  `withExamples`, `annotate`.
- UNVERIFIED: `Prompt.*` (interactive prompts), `Command.wizard`, and `Completions.*` beyond
  confirming `--completions bash` emits a static bash script. Not exercised for this harness.
- UNVERIFIED: `Flag.withFallbackConfig` / `Argument.withFallbackConfig` (env/`Config` fallback) —
  exists in the source but was not compiled or run here.
