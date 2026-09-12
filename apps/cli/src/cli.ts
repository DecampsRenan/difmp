import { Cause, Console, Effect, Exit, Runtime } from "effect";
import { Argument, CliError, Command } from "effect/unstable/cli";
import { listHandler } from "./commands/list.js";
import { reportHandler } from "./commands/report.js";
import { runHandler } from "./commands/run.js";
import { validateHandler } from "./commands/validate.js";
import { UsageError } from "./errors.js";
import { runConfig, selectConfig } from "./flags.js";
import { harnessVersion } from "./version.js";

/**
 * The root command declares the SAME config as `run`, which is what makes `difmp <globs>` an
 * alias of `difmp run <globs>`: the parser only treats the first positional as a subcommand when
 * it matches a subcommand name, and otherwise collects it as a positional for the root's own
 * handler (api-effect-cli.md §4). There is no `withDefaultSubcommand` in Effect v4.
 *
 * Consequence to document: a file literally named `run`, `list`, `validate` or `report` in first
 * position is read as the subcommand — write `difmp ./run` or `difmp -- run`.
 */
export const difmp = Command.make("difmp", runConfig, runHandler).pipe(
  Command.withDescription(
    "Agent-driven end-to-end test harness. `difmp [paths...]` is an alias of `difmp run [paths...]`.",
  ),
  Command.withExamples([
    { command: "difmp run", description: "Run every **/*.e2e.md the configuration selects" },
    {
      command: "difmp run 'tests/e2e/**/*.e2e.md'",
      description: "Run a quoted glob (the shell must not expand it)",
    },
    {
      command: "difmp run --tag smoke --reporter json",
      description: "Smoke scenarios, machine-readable stdout",
    },
    {
      command: "difmp run --input projectName=Demo -i seed=7",
      description: "Scenario inputs (always strings)",
    },
    { command: "difmp run --ui", description: "Run with the live dashboard on loopback" },
  ]),
);

export const run = Command.make("run", runConfig, runHandler).pipe(
  Command.withDescription("Discover, execute once and report. This is what `difmp` alone does."),
);

export const list = Command.make("list", selectConfig, listHandler).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List the selected scenarios. Starts neither a model nor a browser."),
);

export const validate = Command.make("validate", selectConfig, validateHandler).pipe(
  Command.withDescription(
    "Check specs, inputs and variable references without running anything. Unresolved {{ fixture.* }} is accepted here.",
  ),
);

export const report = Command.make(
  "report",
  {
    directory: Argument.Directory("run-directory", { mustExist: true }).pipe(
      Argument.withDescription("A runs/<run-id> directory produced by a previous run"),
    ),
  },
  (cfg) => reportHandler({ directory: cfg.directory }),
).pipe(
  Command.withDescription("Rebuild the HTML report from persisted data. No model call, no replay."),
);

export const cli = difmp.pipe(Command.withSubcommands([run, list, validate, report]));

/**
 * Our own errors carry `Runtime.errorReported = false` so the runtime does not dump a cause on top
 * of the console reporter's output — which means WE have to say what went wrong. `CliError`s are
 * already rendered by the runner, and `ScenariosNotPassing` is just the exit code for a summary
 * the reporter has already printed.
 */
export const reportFailures = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.tapError(effect, (error) => {
    if (CliError.isCliError(error)) return Effect.void;
    if (error instanceof UsageError && error.reported === true) return Effect.void;
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { _tag?: unknown })._tag === "ScenariosNotPassing"
    ) {
      return Effect.void;
    }
    const message = error instanceof Error ? error.message : String(error);
    return Console.error(`\nERROR\n  ${message}`);
  });

export const cliVersion: string = harnessVersion;

/**
 * Exit codes: `0` all passed · `1` any failed or inconclusive · `2` invalid configuration,
 * unusable arguments or execution error · `130` user interrupt.
 *
 * Out of the box every `CliError` is wrapped in `ShowHelp`, which exits `1`; the spec wants `2` for
 * a bad invocation, so the mapping is done here (api-effect-cli.md §6). The interrupt branch must
 * be reimplemented in any custom teardown or SIGINT stops producing 130.
 */
export const exitCodeOf = (exit: Exit.Exit<unknown, unknown>): number => {
  if (Exit.isSuccess(exit)) return 0;
  if (Cause.hasInterruptsOnly(exit.cause)) return 130;
  const error = Cause.squash(exit.cause);
  if (CliError.isCliError(error)) {
    // Every parse failure is wrapped in ShowHelp, which would otherwise exit 1.
    if (error._tag === "ShowHelp") return error.errors.length > 0 ? 2 : 0;
    if (error._tag !== "UserError") return 2;
  }
  return Runtime.getErrorExitCode(error) ?? 1;
};

export const teardown: Runtime.Teardown = (exit, onExit) => onExit(exitCodeOf(exit));
