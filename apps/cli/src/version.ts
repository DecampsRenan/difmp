import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

/**
 * Resolved from the INSTALLED package, never from a workspace path: `import.meta.url` points at
 * `dist/` in a published install and at `src/` in development, and both sit one level under the
 * package root (api-tooling.md §4.4).
 */
export const packageRoot: string = fileURLToPath(new URL("../", import.meta.url));

const readOwnVersion = (): string => {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

export const harnessVersion: string = readOwnVersion();

const trackedDependencies = [
  "effect",
  "@effect/platform-node",
  "@effect/ai-anthropic",
  "playwright",
  "tsx",
  "yaml",
  "tinyglobby",
] as const;

const versionOf = (name: string): string => {
  try {
    const pkg = require_(`${name}/package.json`) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
};

/** Persisted into `manifest.json` so a report can say exactly what produced it. */
export const dependencyVersions = (): Readonly<Record<string, string>> => {
  const out: Record<string, string> = { node: process.version, difmp: harnessVersion };
  for (const name of trackedDependencies) out[name] = versionOf(name);
  return out;
};
