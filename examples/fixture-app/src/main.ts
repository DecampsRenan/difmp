/**
 * CLI entry for manual poking:
 *   node dist/main.js --port 3000 --variant healthy
 *   node dist/main.js --variant alt-layout --persist-dir ./.tmp --seed
 */
import { startFixtureApp } from "./index.js";
import { isVariant, type FixtureAppOptions, type Variant } from "./types.js";

const parseArgs = (
  argv: readonly string[],
): FixtureAppOptions & { seedNow: boolean; seedEmail?: string; seedPassword?: string } => {
  let port: number | undefined;
  let variant: Variant | undefined;
  let persistDir: string | undefined;
  let seedEnabled = true;
  let seedNow = false;
  let seedEmail: string | undefined;
  let seedPassword: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${String(arg)} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--port":
        port = Number.parseInt(next(), 10);
        break;
      case "--variant": {
        const value = next();
        if (!isVariant(value)) throw new Error(`unknown variant: ${value}`);
        variant = value;
        break;
      }
      case "--persist-dir":
        persistDir = next();
        break;
      case "--no-seed-endpoints":
        seedEnabled = false;
        break;
      case "--seed":
        seedNow = true;
        break;
      // Fixed demo credentials, so a scenario that signs in through the UI (and therefore has to
      // write them in its own text) has something stable to type. Synthetic data, never secrets.
      case "--seed-email":
        seedEmail = next();
        seedNow = true;
        break;
      case "--seed-password":
        seedPassword = next();
        seedNow = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "usage: fixture-app [--port N] [--variant healthy|create-500|false-success|alt-layout]\n" +
            "                   [--persist-dir DIR] [--seed] [--seed-email E] [--seed-password P]\n" +
            "                   [--no-seed-endpoints]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${String(arg)}`);
    }
  }

  return {
    seedNow,
    seedEnabled,
    ...(port === undefined ? {} : { port }),
    ...(variant === undefined ? {} : { variant }),
    ...(persistDir === undefined ? {} : { persistDir }),
    ...(seedEmail === undefined ? {} : { seedEmail }),
    ...(seedPassword === undefined ? {} : { seedPassword }),
  };
};

const main = async (): Promise<void> => {
  const { seedNow, seedEmail, seedPassword, ...options } = parseArgs(process.argv.slice(2));
  const app = await startFixtureApp(
    seedNow
      ? {
          ...options,
          seed: {
            workspaceName: "Demo Workspace",
            ...(seedEmail === undefined ? {} : { email: seedEmail }),
            ...(seedPassword === undefined ? {} : { password: seedPassword }),
          },
        }
      : options,
  );

  console.log(`fixture-app listening on ${app.url} (variant: ${app.variant})`);
  console.log(`x-seed-token: ${app.seedToken}`);
  if (app.initialSeed !== undefined) {
    console.log(
      `seeded login: ${app.initialSeed.email} / ${app.initialSeed.password} ` +
        `(sid=${app.initialSeed.sessionToken}, workspace=${app.initialSeed.workspaceId})`,
    );
  }

  const stop = (): void => {
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
};

await main();
