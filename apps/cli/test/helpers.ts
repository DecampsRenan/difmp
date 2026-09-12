import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Fiber, Layer, Stdio } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, exitCodeOf, reportFailures } from "../src/index.js";

export const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (...segments: ReadonlyArray<string>): string =>
  resolve(here, "fixtures", ...segments);

export interface ExecResult {
  readonly code: number;
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
}

// `Stdio.layerTest` must sit ON TOP of the platform services (api-effect-cli.md §8).
const TestLayer = Layer.provideMerge(Stdio.layerTest({}), NodeServices.layer);

/**
 * Run the real command tree in-process and capture what a user would see, plus the exit code the
 * teardown WOULD produce — `exitCodeOf` is the very function `teardown` calls, so this asserts the
 * shipped mapping rather than a copy of it.
 *
 * The handlers read `process.cwd()`, so `cwd` is applied with `process.chdir` and restored.
 */
export const exec = async (
  argv: ReadonlyArray<string>,
  options: { readonly cwd?: string } = {},
): Promise<ExecResult> => {
  const previous = process.cwd();
  if (options.cwd !== undefined) process.chdir(options.cwd);
  try {
    return await Effect.runPromise(
      Effect.suspend(() => {
        const stdout: Array<string> = [];
        const stderr: Array<string> = [];
        return command(argv, stdout, stderr).pipe(
          Effect.exit,
          Effect.map((exit): ExecResult => ({ code: exitCodeOf(exit), stdout, stderr })),
          Effect.provide(TestLayer),
        );
      }),
    );
  } finally {
    process.chdir(previous);
  }
};

/** The command tree with its console and CLI output captured — shared by `exec` and `execInterrupted`. */
const command = (argv: ReadonlyArray<string>, stdout: Array<string>, stderr: Array<string>) => {
  const testConsole: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...args: ReadonlyArray<unknown>) => stdout.push(args.join(" ")),
    error: (...args: ReadonlyArray<unknown>) => stderr.push(args.join(" ")),
  });
  return Command.runWith(cli, { version: "0.1.0-test" })(argv).pipe(
    reportFailures,
    Effect.provideService(Console.Console, testConsole),
    Effect.provide(CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))),
  );
};

/**
 * Ctrl-C, faithfully: `NodeRuntime.runMain` answers SIGINT by INTERRUPTING the main fiber, so the
 * command runs on a fiber here and is interrupted once `ready` says the run has really started.
 * The exit code goes through the shipped `exitCodeOf`, the same function `teardown` calls.
 */
export const execInterrupted = async (
  argv: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly ready: () => boolean; readonly waitMs?: number },
): Promise<ExecResult> => {
  const previous = process.cwd();
  if (options.cwd !== undefined) process.chdir(options.cwd);
  try {
    return await Effect.runPromise(
      Effect.suspend(() => {
        const stdout: Array<string> = [];
        const stderr: Array<string> = [];
        const deadline = Date.now() + (options.waitMs ?? 45_000);
        const waitForStart: Effect.Effect<void> = Effect.suspend(() =>
          options.ready() || Date.now() > deadline
            ? Effect.void
            : Effect.flatMap(Effect.sleep("50 millis"), () => waitForStart),
        );
        return Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(command(argv, stdout, stderr));
          yield* waitForStart;
          yield* Fiber.interrupt(fiber);
          const exit = yield* Effect.exit(Fiber.join(fiber));
          return { code: exitCodeOf(exit), stdout, stderr } satisfies ExecResult;
        }).pipe(Effect.provide(TestLayer));
      }),
    );
  } finally {
    process.chdir(previous);
  }
};

export const allOutput = (result: ExecResult): string =>
  [...result.stdout, ...result.stderr].join("\n");

/** A trivial page for the browser to land on. The scenarios never assert against its contents. */
export const startPage = async (): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> => {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body><h1>Accueil</h1><p>Bonjour</p></body></html>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
};
