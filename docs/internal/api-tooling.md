# api-tooling — build / test / packaging cheat-sheet

Verified on this box: Node **v24.19.0**, pnpm **10.29.3**, npm **11.17.0**, corepack **0.35.0**,
yarn **4.13.0** (via corepack), typescript **5.9.3**, vitest **5.0.0**, @effect/vitest **4.0.0-rc.113**,
vite **7.3.6**, tinyglobby **0.2.17**, yaml **2.9.0**, tsx **4.23.13**, esbuild **0.28.2**,
tsdown **0.23.0** (installed into `.recon/tsdown-dep` for evaluation), playwright **1.63.0**.

Target: publishable ESM Node CLI, `engines.node >= 22.12.0`.

---

## 0. Executed vs reasoned

**Actually executed** (commands run, output observed):
vitest 5 `projects` + `it.effect`/`it.live`/`layer` (7 tests pass); pnpm peer-dedup bug + fix;
`tsc -b` on a real 2-package toy workspace with `customConditions`; `node --conditions` src
resolution; `npm pack` + install into ESM/CJS consumers outside the workspace with npm, pnpm,
yarn(node-modules) and yarn(PnP); the 2x2 config-loading matrix; esbuild + tsdown bundling;
tinyglobby; yaml alias bomb + tag probes; vite `base:'./'` + `vite-plugin-singlefile` build and a
Playwright `file://` render check; `npm pack` vs `pnpm pack` `workspace:` rewriting.

**Reasoned about, not executed**: everything in §9 (GitHub Actions) — marked `UNVERIFIED:`.

Artifacts kept: `/home/ubuntu/apps/difmp/.recon/tooling/*`, `.recon/toy/` (2-pkg workspace),
`.recon/pkg/` (packable CLI), `.recon/vite-toy/`, `/home/ubuntu/consumer-*` (consumers outside the repo).

---

## 1. vitest 5 + @effect/vitest 4

### 1.1 The import surface

```ts
// @effect/vitest re-exports ALL of vitest (`export * from "vitest"`), so one import is enough.
import { describe, expect, it, layer, live, effect, prop, flakyTest } from "@effect/vitest";
// Effect-aware assertion helpers live in a SUBPATH, not the root:
import {
  assertTrue,
  deepStrictEqual,
  strictEqual,
  assertSome,
  assertExitSuccess,
} from "@effect/vitest/utils";
```

- Exports map is `{".": "./dist/index.js", "./*": "./dist/*.js"}` — no `types` condition, types come
  from the sibling `.d.ts`. `@effect/vitest/utils` is the only other public subpath.
- Peer deps: `vitest ">=5.0.0 <6.0.0"`, `effect "^4.0.0-rc.113"`.

### 1.2 **There is no `it.scoped`.** `it.effect` already provides `Scope`.

The v4 type is `readonly effect: Vitest.Tester<R | Scope.Scope>`. v3's `it.scoped` / `it.scopedLive`
are **gone**. Full `Vitest.Methods` surface:

```
it.effect  it.live  it.layer(layer, opts)  it.prop  it.flakyTest  + everything from vitest's TestAPI
it.effect.skip / .only / .skipIf / .runIf / .each / .fails / .prop
```

Test fn signature: `(name: string, self: (ctx: V.TestContext) => Effect<A, E, R>, timeout?: number | TestOptions) => void`.

### 1.3 Providing layers — VERIFIED, all 7 tests pass (`.recon/tooling/sample.test.ts`)

```ts
import { describe, expect, it, layer } from "@effect/vitest";
import { assertTrue, strictEqual } from "@effect/vitest/utils";
import { Context, Effect, Layer } from "effect";

// NOTE: effect@4 root export is `Context`, NOT `ServiceMap`.
class Greeter extends Context.Service<Greeter, { readonly hello: (n: string) => string }>()(
  "Greeter",
) {}
const GreeterLive = Layer.succeed(Greeter, { hello: (n: string) => `hello ${n}` });

describe("tooling recon", () => {
  it.effect("it.effect has Scope in R", () =>
    Effect.gen(function* () {
      const n = yield* Effect.succeed(41);
      expect(n + 1).toBe(42);
      strictEqual(n + 1, 42);
      return n;
    }),
  );

  it.effect("scope is available without it.scoped", () =>
    Effect.gen(function* () {
      let released = false;
      yield* Effect.acquireRelease(Effect.succeed("res"), () =>
        Effect.sync(() => {
          released = true;
        }),
      );
      assertTrue(!released);
    }),
  );

  it.live("it.live uses the real clock", () =>
    Effect.gen(function* () {
      const t0 = Date.now();
      yield* Effect.sleep("10 millis");
      assertTrue(Date.now() - t0 >= 5);
    }),
  );
});

// Shared layer for a group. Two call shapes: layer(L)(fn) or layer(L)("name", fn).
layer(GreeterLive)("with layer", (it) => {
  it.effect("service is provided", () =>
    Effect.gen(function* () {
      const g = yield* Greeter;
      strictEqual(g.hello("world"), "hello world");
    }),
  );
});
```

Options: `layer(L, { concurrent?, memoMap?, timeout?, excludeTestServices? })`. Inside a `layer(...)`
block you get `Vitest.MethodsNonLive` — **`it.live` is not available there**, and nested `it.layer`
only accepts `{ concurrent?, timeout? }`.

Unsatisfied `R` is a compile error (verified with `@ts-expect-error` in `.recon/tooling/typeerr.ts`):

```ts
// @ts-expect-error: R = Db not satisfied; it.effect only supplies Scope
it.effect("needs Db", () =>
  Effect.gen(function* () {
    yield* Db;
  }),
);

it.effect("ok", () =>
  Effect.gen(function* () {
    return (yield* Db).q();
  }).pipe(Effect.provideService(Db, { q: () => "x" })),
);
```

### 1.4 **`workspace` is gone in vitest 5 — the field is `test.projects`**

`vitest.config.ts` (VERIFIED: typechecks + `vitest run` passes; copy at `.recon/tooling/vitest.config.example.ts`):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true, // inherit root vite+test config
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["examples/*/test/**/*.e2e-test.ts"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          pool: "forks",
        },
      },
    ],
    passWithNoTests: true,
    reporters: process.env["CI"] ? ["default", "junit"] : ["default"],
    outputFile: { junit: "./reports/junit.xml" },
  },
});
```

- Type is `projects?: TestProjectConfiguration[]` where
  `TestProjectConfiguration = string | (UserWorkspaceConfig & { extends?: string | boolean }) | Promise<UserWorkspaceConfig> | UserProjectConfigFn`.
  A `string` entry is a glob of project dirs/config files. **Inline configurations cannot declare
  `projects` themselves** (only a referenced config file can, and then it becomes a container).
- Run one: `vitest run --project unit`. `--project` accepts the `test.name`.
- `vitest list` prints nothing useful for an empty project; don't rely on it.

### 1.5 GOTCHA THAT WILL BITE YOU: duplicate `vitest` instances under pnpm

Symptom (both seen here, same root cause):

```
TypeError: Cannot read properties of undefined (reading 'config')   // at describe(...)
Error: Vitest failed to find the current suite. ...                 // at it.effect(...)
```

Cause: `node_modules/@effect/vitest` was symlinked to the `.pnpm` peer variant resolved against
**vite@8.3.0**, while `node_modules/vitest` pointed at the variant resolved against **vite@7.3.6** —
two physically different `vitest` copies, so `@effect/vitest`'s `vitest` import and the runner's
are not the same module.

```bash
# Diagnose:
readlink -f node_modules/@effect/vitest
readlink -f node_modules/vitest
ls -d node_modules/.pnpm/vitest@*        # >1 entry => hazard
# Fix that worked here:
pnpm install                             # re-links to the dedup'd peer variant
```

If it recurs, pin the peer in `pnpm-workspace.yaml` / root `package.json`:
`"pnpm": { "overrides": { "vite": "7.3.6" } }` or `peerDependencyRules`.

---

## 2. TypeScript project setup

### 2.1 Recommended layout (VERIFIED end-to-end in `.recon/toy`, `tsc -b` exit 0, built output runs)

```
tsconfig.base.json      compilerOptions only, no files/include
tsconfig.json           { "files": [], "references": [ ...every package... ] }   <- the -b entry
packages/<p>/tsconfig.json   extends base; rootDir src; outDir dist; references to deps
apps/<a>/tsconfig.json       same
```

`tsconfig.base.json` (matches the one already in this repo, plus `customConditions`):

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "incremental": true,
    "customConditions": ["@difmp/source"], // see 2.3
  },
}
```

Per-package:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "tsBuildInfoFile": "./dist/.tsbuildinfo",
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../../packages/core" }],
}
```

`composite: true` requires `rootDir` be set or inferrable, and every referenced project must also be
composite + emit declarations.

### 2.2 package.json for a workspace package

```jsonc
{
  "name": "@difmp/core",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "@difmp/source": "./src/index.ts", // dev-only condition, MUST be first
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js",
    },
    "./package.json": "./package.json",
  },
  "types": "./dist/index.d.ts", // legacy fallback, keep it
  "files": ["dist"],
  "engines": { "node": ">=22.12.0" },
}
```

Condition order in `exports` is significant — first match wins, so the source condition must precede
`types`/`default`.

### 2.3 Dev (src) **and** built (dist) resolution — verified both ways

With `customConditions: ["@difmp/source"]`, `tsc --traceResolution` shows:

```
Module name '@toy/core' was successfully resolved to '.../packages/core/src/index.ts'
```

i.e. the compiler reads sibling **source**, no prebuild needed for typechecking, and the emitted
`.d.ts` still contains the **bare specifier** `import { type ToyConfig } from "@toy/core"` (it does
NOT inline the src path — verified).

At runtime the same condition is available to Node:

```bash
# VERIFIED: with packages/core/dist DELETED, this still works on Node 24
node --conditions=@difmp/source apps/cli/src/bin.ts
#   -> @difmp/core resolves to packages/core/src/index.ts, types stripped natively
```

Two hard constraints on that trick:

- **Node refuses to strip types under `node_modules`**:
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING: Stripping types is currently unsupported for files under node_modules`.
  It works in a pnpm workspace only because `apps/cli/node_modules/@difmp/core` is a **symlink**
  whose realpath (`packages/core/src/index.ts`) is outside `node_modules`. It breaks under
  `--preserve-symlinks` or `node-linker=hoisted` copies.
- For vitest/vite dev, mirror it with `resolve: { conditions: ["@difmp/source"] }`.
  UNVERIFIED: not exercised here.

Consumers never set the condition, so published installs fall through to `types`/`default` -> `dist`.
Optionally strip it at publish time with `publishConfig.exports`.

### 2.4 `tsc -b` gotchas hit here

- `import { run } from "./index.ts"` -> **`error TS5097: An import path can only end with a '.ts'
extension when 'allowImportingTsExtensions' is enabled.`** With `module: nodenext` + emit, write
  **`./index.js`** in source. (Alternative: `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`,
  TS >= 5.7 — UNVERIFIED here.)
- `tsc` **preserves a leading `#!/usr/bin/env node`** in emitted JS (verified) but does **not** set
  the exec bit. npm/pnpm/yarn set it at install time from the `bin` field, so that is fine.
- The root `package.json` currently has `"typecheck": "tsc -b tsconfig.build.json"` but
  **`tsconfig.build.json` does not exist** in this repo. Create it (or point at `tsconfig.json`).

---

## 3. Loading the consumer's `difmp.config.ts` — THE ANSWER

**Recommendation: try bare `import()` first, fall back to `tsx`'s `tsImport`.** Ship `tsx` as a real
`dependency` of the CLI package. VERIFIED against a packed tarball installed into consumer dirs
**outside** the workspace (`/home/ubuntu/consumer-*`).

### 3.1 The code (compiled ESM, `.recon/tooling/loader.ts`, typechecks clean)

```ts
import { pathToFileURL } from "node:url";

const isTs = (p: string): boolean => /\.(m|c)?ts$/.test(p);

/** tsx transpiles ESM->CJS when the consumer package is CJS, producing
 *  `{ default: { default: cfg, __esModule: true } }`. Unwrap exactly that shape. */
const pickDefault = (mod: Record<string, unknown>): unknown => {
  const d = mod["default"];
  if (
    d !== null &&
    typeof d === "object" &&
    (d as { __esModule?: unknown })["__esModule"] === true
  ) {
    return (d as { default?: unknown })["default"];
  }
  return d;
};

export const importConfigModule = async (absPath: string): Promise<unknown> => {
  const url = pathToFileURL(absPath).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>; // Node >=22.18 strips types natively
  } catch (err) {
    if (!isTs(absPath)) throw err;
    const { tsImport } = await import("tsx/esm/api"); // lazy: no cost on the happy path
    mod = (await tsImport(url, import.meta.url)) as Record<string, unknown>;
  }
  const cfg = pickDefault(mod);
  if (cfg === undefined) throw new Error(`${absPath}: no default export`);
  return cfg;
};
```

### 3.2 Verified matrix (packed tarball -> `npm i ./toy-harness-0.1.0.tgz` -> `npx toy-harness`)

| consumer `"type"` | config syntax         | bare `import()`                                                         | with tsx fallback |
| ----------------- | --------------------- | ----------------------------------------------------------------------- | ----------------- |
| `module`          | erasable (types only) | PASS                                                                    | PASS              |
| `module`          | `enum` (non-erasable) | FAIL `SyntaxError: TypeScript enum is not supported in strip-only mode` | **PASS**          |
| `commonjs`        | erasable              | FAIL `Cannot use import statement outside a module`                     | **PASS**          |
| `commonjs`        | `enum`                | FAIL                                                                    | **PASS**          |
| _(absent)_        | erasable              | PASS + `MODULE_TYPELESS_PACKAGE_JSON` warning                           | PASS              |

### 3.3 Why the other options lose

- **`node --experimental-strip-types` / Node native stripping.** Free and fastest, but: only
  **erasable** syntax (no `enum`, `namespace`, parameter properties, `import x = require()`); off by
  default on Node < 22.18 (our floor is 22.12); does nothing for a `"type": "commonjs"` consumer; and
  you cannot turn it on for an _already running_ process — you'd have to re-exec `node`.
  Use it as the fast path only.
- **`register()` from `tsx/esm/api`.** Works, but **do not cache-bust with a query string**:
  `import(url + "?t=" + Date.now())` blows up with
  `Error: Cannot find module '/…/difmp.config.ts?tsx=1789…'` in a CJS-typed consumer, because the
  file is routed through the **CJS** loader which does not accept URL queries. (Reproduced.)
  `tsImport(specifier, parentURL)` uses a namespaced loader internally and has no such problem.
- **jiti.** Not installed here; would be a second transpiler in the dependency tree next to tsx's
  esbuild. UNVERIFIED.

### 3.4 Other config-loading facts

- `tsImport`'s second arg is `string | { parentURL, onImport?, tsconfig? }`; passing
  `import.meta.url` (a string) is the short form.
- tsx pulls in `esbuild@0.28.2`. Both npm 11 (`allow-scripts`) and pnpm 10 **block esbuild's
  postinstall by default** — verified that tsx still works anyway (the platform binary arrives via
  `optionalDependencies`, the postinstall is only a fallback). Don't tell users to `approve-builds`.
- Resolve the config path with `path.resolve(process.cwd(), argv ?? "difmp.config.ts")` and pass an
  **absolute** path to `pathToFileURL`.
- Recommend `difmp.config.ts` but also accept `.mts` / `.js` / `.mjs`.

---

## 4. Bundling the CLI

### Recommendation

**Bundle with `tsdown` (rolldown), format ESM, `platform: node`, deps external, `dts: true`.**
Fallback if you want zero new deps: **`tsc` only** — it already emits correct ESM and preserves the
shebang; you just ship more files. Do **not** hand-roll esbuild + a shebang banner.

### 4.1 tsdown (VERIFIED: builds, runs, keeps `tsx/esm/api` external, emits d.ts, chmod +x)

```ts
// tsdown.config.ts — typechecks clean
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22.12",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  clean: true,
  shims: false,
  treeshake: true,
  // `dependencies` + `peerDependencies` are external by default; devDeps get bundled.
});
```

Observed output: `dist/bin.mjs` (mode **0755**, shebang intact), `dist/index.mjs`,
`dist/index.d.mts`, `dist/bin.d.mts`, maps. Log line: `ℹ Granting execute permission to dist/bin.mjs`.

**GOTCHA:** tsdown writes **`.mjs`/`.d.mts`** for the `esm` format even when `"type": "module"`.
Either point `bin`/`exports` at `.mjs`, or set `outExtensions: () => ({ js: ".js", dts: ".d.ts" })`
(UNVERIFIED: only the `.mjs` default was exercised).

### 4.2 esbuild (VERIFIED, if you prefer the already-installed tool)

```ts
import * as esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["src/bin.ts"],
  bundle: true,
  platform: "node",
  target: "node22.12",
  format: "esm",
  outdir: "dist",
  packages: "external",
  sourcemap: true,
});
```

- **Do NOT add `banner: { js: "#!/usr/bin/env node" }`** — esbuild already hoists the shebang from the
  entry source, and you get a **double shebang** (reproduced: two `#!/usr/bin/env node` lines).
- esbuild emits mode 0644; npm sets +x from `bin` on install, so it works, but `chmod 755` in
  `prepack` if you care.
- esbuild emits **no `.d.ts`** — run `tsc --emitDeclarationOnly` alongside.
- `packages: "external"` externalizes bare specifiers only; relative imports are bundled.

### 4.3 Deps bundled or external? -> **external**

Keep `effect`, `@effect/*`, `playwright`, `tsx`, `yaml` as real `dependencies`. Bundling `effect` v4
would fight its `Context`/service identity (module-instance sensitive), and bundling `playwright`
is impossible (native browser payloads). Only the harness's own `src/` gets bundled.

### 4.4 Shipping static assets (built React UI + report template)

```ts
// src/assets.ts — VERIFIED from an installed tarball under npm, pnpm, yarn node-modules AND yarn PnP
import { fileURLToPath } from "node:url";
const assetsRoot = fileURLToPath(new URL("../assets/", import.meta.url)); // dist/../assets/
```

- `new URL(..., import.meta.url)` survives esbuild and rolldown untouched (verified) — the path is
  computed at runtime, so keep the **published** `dist/` -> `assets/` relative depth stable.
- Put `"assets"` in `files` (the tarball listing confirmed `assets/template.html` shipped).
- **yarn PnP gotcha:** the resolved path is inside a zip, e.g.
  `/home/ubuntu/.yarn/berry/cache/toy-harness-file-….zip/node_modules/toy-harness/dist/index.js`.
  `fs.readFileSync` works (yarn patches `fs`) — verified. But that path is **not real**: you cannot
  hand it to a static file server that uses `sendfile`, to a child process, to `chromium
--load-extension`, or to `page.goto("file://…")`. If the harness serves the UI, **read the bytes and
  serve from memory**, or copy assets to a temp dir first.

### 4.5 package.json for the published CLI (verified shape)

```jsonc
{
  "name": "@stylishedcoyote/difmp",
  "version": "0.1.0",
  "type": "module",
  "bin": { "harness": "./dist/bin.js" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json",
  },
  "types": "./dist/index.d.ts",
  "files": ["dist", "assets", "README.md"],
  "engines": { "node": ">=22.12.0" },
  "dependencies": { "tsx": "^4.23.13" },
  "scripts": { "build": "tsdown", "prepack": "npm run build" },
}
```

---

## 5. `npm pack` -> install into a temp dir

All four VERIFIED with the toy package `toy-harness@0.1.0`:

```bash
# in the package dir
npm pack --pack-destination /tmp            # runs `prepack` (verified: dist/ was deleted, still shipped)
pnpm pack --pack-destination /tmp           # also runs prepack (verified)

# consumers, outside the workspace
mkdir /tmp/c && cd /tmp/c && npm init -y && npm pkg set type=module
npm  i /tmp/toy-harness-0.1.0.tgz  && npx toy-harness
pnpm add /tmp/toy-harness-0.1.0.tgz && pnpm exec toy-harness
# yarn 4 via corepack (yarn is NOT installed standalone on this box)
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack yarn --version   # 4.13.0
corepack yarn add ./toy-harness-0.1.0.tgz && corepack yarn toy-harness
```

Gotchas confirmed:

- **`npm pack` does NOT rewrite `workspace:*`.** Proven side by side on `@toy/cli`:
  ```
  npm  pack -> "dependencies": { "@toy/core": "workspace:*" }   <- BROKEN tarball
  pnpm pack -> "dependencies": { "@toy/core": "0.1.0" }         <- correct
  ```
  **Always `pnpm pack` / `pnpm publish` for workspace packages.**
- `files` is authoritative — `dist` and `assets` must both be listed or they silently vanish.
  `package.json`, `README`, `LICENSE` are always included.
- `prepack` runs for `npm pack`, `pnpm pack`, and `npm publish`. It does **not** run on
  `npm install` of a git URL in older npm — keep a `prepare` alias if you support git installs.
- **pnpm strictness:** in a pnpm consumer, `ls node_modules` showed only `toy-harness` — the CLI can
  only import what it declares. Any phantom dep (something you `import` but don't list in
  `dependencies`) fails only under pnpm/yarn-PnP, never under npm. Test with pnpm.
- **yarn defaults to PnP.** Without `nodeLinker: node-modules` in `.yarnrc.yml` you get zip-backed
  virtual paths (§4.4). Both linkers ran the CLI successfully here.
- npm 11 / pnpm 10 block postinstall scripts by default (`allow-scripts` / `approve-builds`) —
  harmless for tsx/esbuild (verified) but will bite anything needing a real postinstall.
- `npm i ./x.tgz` records `"toy-harness": "file:./x.tgz"` in the consumer's package.json.

---

## 6. Glob discovery of `**/*.e2e.md`

**Use `tinyglobby` (already a root devDep, 0.2.17).** `node:fs/promises` `glob` _does_ exist and
works on Node 24 (verified), but it is still flagged experimental and its `exclude` signature changed
across 22.x — on our 22.12 floor it is a liability. `fast-glob` is heavier and not installed.

```ts
// .recon/tooling/glob.ts — typechecks clean
import { resolve } from "node:path";
import { glob, isDynamicPattern } from "tinyglobby";

export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/coverage/**",
  "**/.difmp-tmp/**",
] as const;

export const discover = async (
  patterns: ReadonlyArray<string>,
  opts: { readonly cwd: string; readonly ignore?: ReadonlyArray<string> },
): Promise<ReadonlyArray<string>> => {
  const pats = patterns.length === 0 ? ["**/*.e2e.md"] : patterns;
  const files = await glob(pats, {
    cwd: opts.cwd,
    ignore: [...DEFAULT_IGNORE, ...(opts.ignore ?? [])],
    absolute: true,
    dot: false,
    onlyFiles: true,
    expandDirectories: false, // IMPORTANT: default is true; `foo` would become `foo/**/*`
    followSymbolicLinks: false,
  });
  return files.sort(); // tinyglobby does NOT guarantee order
};

export const isLiteralPath = (arg: string): boolean => !isDynamicPattern(arg);
export const toAbs = (cwd: string, arg: string): string => resolve(cwd, arg);
```

API (from `dist/index.d.mts`): `glob(patterns, opts) => Promise<string[]>`, `globSync`,
`isDynamicPattern`, `escapePath`, `convertPathToPattern`, type `GlobOptions`.
Key defaults: `absolute:false`, `dot:false`, `onlyFiles:true`, `expandDirectories:true`,
`braceExpansion:true`, `extglob:true`, `globstar:true`, `followSymbolicLinks:true`,
`caseSensitiveMatch:true`, `ignore:[]`. Also supports `signal: AbortSignal` and `deep: number`.

**Quoted-glob CLI args:** the shell must not expand them.

```bash
difmp run '**/*.e2e.md'                 # quote: bash without globstar expands ** as *
difmp run 'tests/**/*.e2e.md' --ignore '**/fixtures/**'
difmp run tests/login.e2e.md            # literal path -> isDynamicPattern() === false, skip crawling
```

Note bash's `**` only recurses with `shopt -s globstar`; unquoted it silently behaves like `*`.
Document the quotes, and on Windows `cmd` does no expansion at all — always accept raw patterns.

---

## 7. YAML in strict data mode (`yaml@2.9.0`, eemeli)

```ts
// .recon/tooling/yaml-probe.ts — typechecks clean, behaviour verified by .recon/tooling/yaml-run*.ts
import {
  parseDocument,
  type DocumentOptions,
  type ParseOptions,
  type SchemaOptions,
  type ToJSOptions,
} from "yaml";

export const SAFE: ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions = {
  schema: "core",
  version: "1.2",
  customTags: [],
  resolveKnownTags: false, // <-- THE important one, see below
  maxAliasCount: 100, // library default is already 100; lower to ~20 for untrusted input
  strict: true,
  uniqueKeys: true,
  merge: false,
  prettyErrors: true,
};

export const parseSafe = (src: string): unknown => {
  if (src.length > 1_000_000) throw new Error("yaml too large"); // no built-in size cap
  const doc = parseDocument(src, SAFE);
  if (doc.errors.length > 0) throw new Error(doc.errors[0]!.message);
  if (doc.warnings.length > 0) throw new Error(doc.warnings[0]!.message); // tags land HERE, not errors
  return doc.toJS({ maxAliasCount: 100 });
};
```

### The surprise: `schema: "core"` alone does **not** disable executable-ish tags

`Schema`'s constructor is `this.knownTags = resolveKnownTags ? coreKnownTags : {}`, and
`coreKnownTags` covers `!!binary`, `!!timestamp`, `!!omap`, `!!pairs`, `!!set`, `!!merge`.
So with `schema:"core"` **and defaults**:

```
!!timestamp 2001-12-15T02:59:43Z   -> [object Date]              (no error, no warning)
!!binary aGk=                      -> Node Buffer                (no error, no warning)
```

With `resolveKnownTags: false` both become `TAG_RESOLVE_FAILED` **warnings** and stay strings.
`doc.errors` alone is not enough — you must reject on `doc.warnings` too.

### Verified probe results

| input                                    | with `SAFE`                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| alias bomb (9^6 expansion)               | REJECTED `Excessive alias count indicates a resource exhaustion attack` — _also rejected by plain `parse()`; `maxAliasCount` defaults to 100_ |
| `!!python/object/apply:os.system ['id']` | REJECTED `Unresolved tag: tag:yaml.org,2002:python/object/apply:os.system` (warning `TAG_RESOLVE_FAILED`)                                     |
| `!Foo {a: 1}` (local tag)                | REJECTED `TAG_RESOLVE_FAILED`                                                                                                                 |
| `!!timestamp …` / `!!binary …`           | REJECTED (only because of `resolveKnownTags:false`)                                                                                           |
| `t: 2001-12-15` (plain scalar)           | OK -> string `"2001-12-15"`                                                                                                                   |
| `a: 1` + `a: 2`                          | REJECTED `Map keys must be unique` (`uniqueKeys: true`)                                                                                       |
| `<<: *a` with `merge:false`              | OK, key stays the literal string `"<<"` — no merge performed                                                                                  |
| `a: yes` / `b: 0o17` / `c: 012`          | OK -> `"yes"` (string), `15`, `12` — YAML 1.2 core, no 1.1 octal/bool coercion                                                                |
| `a: 1\n---\nb: 2`                        | REJECTED `MULTIPLE_DOCS` (error) — `parseDocument` only takes one doc; use `parseAllDocuments` if you want more                               |

There is **no built-in input-size or depth limit** — cap `src.length` yourself before parsing.

---

## 8. Vite + React: live UI and single-file offline report

### 8.1 `base: "./"` is necessary but not sufficient for `file://`

VERIFIED build output with `base: "./"`:

```html
<script type="module" crossorigin src="./assets/index-CHK4-ZWY.js"></script>
<link rel="stylesheet" crossorigin href="./assets/style-jjw9uzxu.css" />
```

Relative — good for serving from any subpath. **But under `file://` Chromium refuses it**:

```
Access to script at 'file:///…/a.js' from origin 'null' has been blocked by CORS policy
net::ERR_FAILED
```

So `base:'./'` fixes _hosted_ offline use; the standalone report must be **one inlined file**.

### 8.2 **Use `vite-plugin-singlefile` (2.3.3). Do not hand-roll the inliner.**

I wrote a hand-rolled `generateBundle` inliner first and it produced a **broken** page: the
non-global `String.replace` left 2 more `<script src="./a.js">` tags behind and the HTML parser then
choked (`SyntaxError: missing ) after argument list`, DOM full of `</u&&t[l]===e[l]` garbage).
The plugin gets it right.

```ts
// vite.config.ts — the `report` mode output is ONE index.html, verified rendering from file://
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig(({ mode }) => {
  const report = mode === "report";
  return {
    base: "./",
    plugins: report ? [react(), viteSingleFile({ removeViteModuleLoader: true })] : [react()],
    build: {
      outDir: report ? "dist-report" : "dist-ui",
      emptyOutDir: true,
      target: "es2022",
      cssCodeSplit: false,
      modulePreload: { polyfill: false },
    },
  };
});
```

```bash
vite build                 # -> dist-ui/    index.html + assets/*, relative URLs, serve over http
vite build --mode report   # -> dist-report/index.html   ONE file, 222 kB (69 kB gzip), 0 assets
```

Verified with Playwright (`.recon/tooling/report-check.mjs`): opening
`file:///…/dist-report/index.html` renders `<h1 class="t">OFFLINE OK</h1>`, no pageerrors, no failed
requests. The plugin logs `[plugin vite:singlefile] Inlining: index-….js / style-….css` and leaves
zero `src="./` / `href="./` in the output.

`vite-plugin-singlefile` is **not yet a dependency of this repo** — add it as a devDep of the UI app.

### 8.3 Injecting report data

Keep the report app reading from a global and inject at generation time:

```ts
const data = (globalThis as { __REPORT__?: ReportData }).__REPORT__ ?? EMPTY;
```

Generation = read the packaged `index.html`, string-replace a placeholder with
`<script>globalThis.__REPORT__=${json}</script>` **before** the inlined module script.
Escape the JSON for HTML context before embedding: replace every `<` with `\u003c`
(that alone neutralises `</script>` and `<!--`), and `\u2028`/`\u2029` for safety.
`JSON.stringify(data).replace(/</g, "\\u003c")` is enough. In this recon the data was injected via Playwright `addInitScript`, which
proved the read path but not the string-injection path (UNVERIFIED: the escaping helper).

---

## 9. GitHub Actions — UNVERIFIED (reasoned, not executed)

`corepack` + `packageManager` vs `pnpm/action-setup@v4`:

- This repo pins `"packageManager": "pnpm@10.29.3"`. Locally verified:
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --version` -> `10.29.3`, and corepack also
  produced `yarn 4.13.0`. Corepack is bundled with Node 24.19.0 here.
- UNVERIFIED but well-established: corepack is no longer shipped-and-enabled on GitHub runners
  reliably, so **`pnpm/action-setup@v4` is the lower-risk choice**; it reads `packageManager` from
  package.json when you omit its `version` input, giving the same pin.
- **Ordering matters:** `actions/setup-node@v4` with `cache: pnpm` needs `pnpm` on PATH _already_, so
  `pnpm/action-setup` must run **before** `setup-node`.

```yaml
# UNVERIFIED: not executed
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4 # reads packageManager from package.json
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile

      - name: Playwright browser cache
        id: pw
        uses: actions/cache@v4
        with:
          # locally confirmed: browsers land in ~/.cache/ms-playwright (chromium-1243,
          # chromium_headless_shell-1243, ffmpeg-1011 for playwright 1.63.0)
          path: ~/.cache/ms-playwright
          key: pw-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
      - if: steps.pw.outputs.cache-hit != 'true'
        run: pnpm exec playwright install --with-deps chromium
      - if: steps.pw.outputs.cache-hit == 'true'
        run: pnpm exec playwright install-deps chromium # OS libs are never cached

      - run: pnpm run build
      - run: pnpm run test

      - uses: actions/upload-artifact@v4
        if: always() # keep reports for FAILED runs too
        with:
          name: harness-report-${{ github.run_id }}
          path: |
            runs/**
            reports/**
          retention-days: 14
          if-no-files-found: ignore
```

Notes:

- Cache the **browsers** (`~/.cache/ms-playwright`), never the pnpm store manually — `setup-node`'s
  `cache: pnpm` already handles the store (it reads `pnpm store path`; locally
  `/home/ubuntu/.local/share/pnpm/store/v10`).
- The browser cache key **must include the playwright version** (via the lockfile hash) or you will
  restore browsers for the wrong revision.
- `install --with-deps` needs root; on a cache hit still run `install-deps` because apt libs are not
  in the cached dir.
- `upload-artifact@v4` refuses duplicate artifact names within a job — suffix with `run_id`/matrix
  values.

---

## 10. Quick gotcha index

1. **No `it.scoped`** in @effect/vitest 4 — `it.effect` supplies `Scope`.
2. `effect@4` root export is **`Context`**, not `ServiceMap`; `Layer.succeed(Tag, value)` is 2-arg.
3. Assertion helpers are at **`@effect/vitest/utils`**, not the root.
4. vitest 5 config field is **`test.projects`**; `workspace` no longer exists.
5. Two `vitest` copies in `.pnpm` -> `Cannot read properties of undefined (reading 'config')`. `pnpm install` re-links.
6. `module: nodenext` + emit -> relative imports must end **`.js`**, never `.ts` (TS5097).
7. `customConditions` + `node --conditions` gives build-free src resolution — but Node **won't strip
   types under `node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`); pnpm symlinks save you.
8. tsx: **never** append `?query` to the import URL; use `tsImport`.
9. tsx in a CJS consumer double-wraps the default export (`{default:{default:cfg,__esModule:true}}`).
10. esbuild + a shebang `banner` = **double shebang**; esbuild already keeps the source one.
11. tsdown writes `.mjs`/`.d.mts` by default even for `"type": "module"` packages.
12. **`npm pack` does not rewrite `workspace:*`** — use `pnpm pack`.
13. yarn PnP resolves assets to **paths inside a zip**; `fs` works, everything else does not.
14. `yaml`'s `schema:"core"` still resolves `!!timestamp`/`!!binary` — set **`resolveKnownTags: false`**,
    and reject on `doc.warnings`, not just `doc.errors`.
15. tinyglobby's `expandDirectories` defaults to **true** and results are **unsorted**.
16. `base:'./'` still leaves `crossorigin` on the script tag -> CORS failure under `file://`; only
    full inlining fixes the standalone report.

---

# APPENDIX (critic pass) — gaps no lane answered

Compiled + executed: `.recon/critic-yaml.ts`, `.recon/critic-yaml2.ts`, `.recon/critic-yamlpos.ts`,
`.recon/critic-inputsfile.ts`. Output below is real.

## §A-Y. `effect/unstable/encoding/Yaml` exists — and you should NOT use it for specs

Effect ships its own YAML parser (`Yaml.parse(input: string): unknown`, "based on `yaml` 2.9.0").
It is tempting (zero extra dependency) but it is a **configuration** parser, not a hardened one.
Executed comparison:

| input                         | `Yaml.parse` (effect)                                                 | `yaml` pkg with the §7 `SAFE` options       |
| ----------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| `a: 1` / `a: 2` duplicate key | **throws `Duplicate key 'a' at line 2`** ✅                           | throws `Map keys must be unique` ✅         |
| `!!timestamp …`               | returns the **string** `"!!timestamp 2001-…"` — silently wrong data ⚠ | rejected (`TAG_RESOLVE_FAILED`) ✅          |
| `!Foo {a: 1}`                 | returns the **string** `"!Foo {a: 1}"` ⚠                              | rejected ✅                                 |
| `a: 1\n---\nb: 2` (multi-doc) | silently **merges** → `{"a":1,"b":2}` ⚠                               | rejected (`MULTIPLE_DOCS`) ✅               |
| alias bomb (9⁵)               | **PARSED in 8 ms → 2.5 MB** — no alias limit at all ❌                | rejected `Excessive alias count…` ✅        |
| `a: yes` / `b: 012`           | `"yes"` / `"012"` (both strings)                                      | `"yes"` / `12` — **they disagree on `012`** |
| malformed                     | `SyntaxError: Unexpected indentation of 1 spaces at line 3`           | structured `doc.errors[]`                   |

**Verdict: keep the `yaml` package** with the §7 `SAFE` options — the spec explicitly demands
"des limites de taille et d'alias" and "sans tags exécutables", and `Yaml.parse` gives neither.
`Yaml.parse` is fine for a trusted internal file. Either way, **cap `src.length` yourself**; neither
has a size limit.

## §A-L. Frontmatter field → source LINE (the spec requires it, nothing documented it)

Spec §4: _"Les erreurs doivent désigner le fichier, le champ et, lorsque possible, la ligne
concernée."_ `yaml`'s `LineCounter` + node ranges give this, but you must **re-base** the offset
because the frontmatter starts partway into the `.e2e.md` file. Compiled + executed:

```ts
import { LineCounter, isMap, isScalar, parseDocument } from "yaml";

const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(file);
if (!m) throw new Error("no frontmatter");
const fmText = m[1]!;
const fmStartLine = file.slice(0, m.index).split("\n").length + 1; // 1-based line of fmText line 1

const lc = new LineCounter();
const doc = parseDocument(fmText, { lineCounter: lc, ...SAFE }); // SAFE from §7
if (doc.errors.length > 0 || doc.warnings.length > 0) {
  /* reject, see §7 */
}

/** absolute (1-based) line/col in the .e2e.md file for a frontmatter KEY */
const keyPos = (key: string): { line: number; col: number } | undefined => {
  const c = doc.contents;
  if (!isMap(c)) return undefined;
  for (const pair of c.items) {
    if (isScalar(pair.key) && pair.key.value === key && pair.key.range) {
      const p = lc.linePos(pair.key.range[0]);
      return { line: p.line + fmStartLine - 1, col: p.col };
    }
  }
  return undefined;
};

/** …and for its VALUE, for "bad value at line N" */
const valuePos = (key: string) => {
  const c = doc.contents;
  if (!isMap(c)) return undefined;
  for (const pair of c.items) {
    if (isScalar(pair.key) && pair.key.value === key) {
      const v = pair.value as { range?: [number, number, number] } | null;
      if (v?.range) {
        const p = lc.linePos(v.range[0]);
        return { line: p.line + fmStartLine - 1, col: p.col };
      }
    }
  }
  return undefined;
};
```

Executed against a real `.e2e.md`:

```
version        {"line":2,"col":1}       id  {"line":3,"col":1}
timeout        {"line":5,"col":1}       verification {"line":6,"col":1}
nope           undefined                value of timeout at: {"line":5,"col":10}
data: {"version":1,"id":"project-create","tags":["smoke","projects"],
       "timeout":"90s","verification":"- a\n- b\n"}
```

Notes:

- `lineCounter.linePos(offset)` returns **1-based** `{ line, col }`; `node.range` is
  `[start, valueEnd, nodeEnd]` character offsets into the string you parsed.
- `parseDocument` must receive the `lineCounter` **in its options**; calling `lc.addNewLine` yourself
  is not needed.
- Schema decode errors give you a **path** (`retry.max`, `steps.0.url` — api-effect-schema.md §11),
  not a line. Join the two: take the first path segment, look it up with `keyPos`, and you get
  `file:line:col` + the full path + the message, which is what the spec asks for.
- `timeout: 90s` parses to the **string** `"90s"` — see api-effect-core.md §A1: Effect cannot turn
  that into a `Duration`. Normalise it yourself.
- Regex note: the frontmatter split above requires the file to _start_ with `---`. Reject a spec
  whose first line is not `---` with a clear error rather than treating the whole file as body.

## §A-I. `--inputs-file <json>` with preserved JSON types — `Flag.FileSchema`

Spec §4 wants `--input key=value` (always string) _and_ `--inputs-file <json>` (typed).
Compiled **and run**:

```ts
import { Schema } from "effect";
import { Flag } from "effect/unstable/cli";

const InputValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
const InputsFile = Schema.Record(Schema.String, InputValue);

const inputsFile = Flag.FileSchema("inputs-file", InputsFile, { format: "json" }).pipe(
  Flag.withDescription("JSON file of scenario inputs (types preserved)"),
  Flag.optional, // -> Flag<Option<Record<string, string|number|boolean>>>
);
const inputKV = Flag.KeyValuePair("input").pipe(Flag.withDefault({} as Record<string, string>));
```

```
$ h --inputs-file /tmp/inputs.json --input a=1
{"file":{"_id":"Option","_tag":"Some","value":{"projectName":"P1","count":3,"flag":true}},"cli":{"a":"1"}}
```

- `{ format: "json" }` is required; the flag reads **and decodes** the file itself — no `fs` call
  and no second decode step in your handler.
- A schema violation (`{"x":{"nested":1}}`) and a missing file both surface as a CLI error →
  help is printed, exit `1` by default / `2` with the api-effect-cli.md §6 teardown. Good: the spec
  wants "configuration invalide" to be exit 2.
- This enforces "reject non-scalar inputs" at the CLI boundary for free. You still have to reject
  keys **not declared** in config-or-spec yourself (design-contracts §4).

## §A-T. Repo state re-checked

- `tsconfig.build.json` and `tsconfig.json` **still do not exist** at the root, so
  `pnpm typecheck` (`tsc -b tsconfig.build.json`) fails today. §2.1 tells you what to create.
- `vite-plugin-singlefile` and `tsdown` are **not installed**. §4 and §8.2 both depend on them —
  add them as devDeps (or fall back to `tsc`-only builds per §4).
- All package directories from design-contracts §1 exist but are empty:
  `packages/{core,browser-playwright,agent-runtime,reporting}`, `apps/{cli,ui}`,
  `examples/{fixture-app,scenarios,support}`.
- No markdown parser (`marked`/`remark`/`unified`/`micromark`) is installed — see
  api-effect-core.md §A6; hand-roll the body scanner so you keep per-criterion line numbers.
