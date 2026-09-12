import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const isTs = (path: string): boolean => /\.(m|c)?ts$/.test(path);

/**
 * A `.ts` file inherits the nearest package's explicit module type. Stop at the first
 * `package.json`: a package without `type` does not inherit one from an outer package.
 */
const isExplicitCommonJs = (path: string): boolean => {
  if (extname(path) === ".cts") return true;
  if (extname(path) !== ".ts") return false;

  const root = parse(resolve(path)).root;
  let directory = dirname(resolve(path));
  for (;;) {
    const packageJson = join(directory, "package.json");
    if (existsSync(packageJson)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJson, "utf8")) as { readonly type?: unknown };
        return pkg.type === "commonjs";
      } catch {
        // Let Node/tsx report malformed package metadata while loading the module.
        return false;
      }
    }
    if (directory === root) return false;
    directory = dirname(directory);
  }
};

/**
 * tsx transpiles ESM->CJS when the consumer package is CJS, producing
 * `{ default: { default: cfg, __esModule: true } }`. Unwrap exactly that shape.
 */
const pickDefault = (mod: Record<string, unknown>): unknown => {
  const value = mod["default"];
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { __esModule?: unknown })["__esModule"] === true
  ) {
    return (value as { default?: unknown })["default"];
  }
  return value;
};

/**
 * Load the consumer's config module as TRUSTED project code. Bare `import()` is the fast path on
 * recent Node versions. TypeScript that needs transpilation goes through tsx; an explicitly
 * CommonJS package uses tsx's CJS API because its scoped ESM loader appends a namespace query to
 * ESM dependencies on Node 22 (for example `difmp/dist/index.js?namespace=...`), which the native
 * synchronous ESM bridge then mistakes for part of the file name.
 */
export const importConfigModule = async (absPath: string): Promise<unknown> => {
  const url = pathToFileURL(absPath).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    if (!isTs(absPath)) throw error;

    if (isExplicitCommonJs(absPath)) {
      const { require: tsxRequire } = await import("tsx/cjs/api");
      mod = tsxRequire(absPath, import.meta.url) as Record<string, unknown>;
    } else {
      const { tsImport } = await import("tsx/esm/api");
      mod = (await tsImport(url, import.meta.url)) as Record<string, unknown>;
    }
  }

  const config = pickDefault(mod);
  if (config === undefined) {
    throw new Error(
      `${absPath}: no default export — a difmp config must \`export default defineConfig({...})\``,
    );
  }
  return config;
};
