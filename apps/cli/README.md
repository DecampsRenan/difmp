# `harness` — the CLI

The primary interface of the agent-driven E2E harness. It runs from any consumer project once
installed as a dev dependency: no clone of this repository, no orchestration script, no global
loader. The dashboard is an option of the runner, never a requirement.

```text
harness [file-or-dir-or-glob...]          alias of `harness run`
harness run [file-or-dir-or-glob...]
harness list [--tag smoke]
harness validate [file-or-dir-or-glob...]
harness report <run-directory>
harness --help
harness --version
```

## Install and run from a consumer project

```jsonc
// package.json
{
  "scripts": {
    "test:e2e": "harness run",
    "test:e2e:ui": "harness run --ui"
  }
}
```

The distributed package is **`@harness/cli`** and its `bin` is **`harness`**. It is not published
to any registry, so a consumer installs the local tarball produced by `pnpm pack` (below); replace
the path with `@harness/cli` once it is published.

| package manager | install | run |
| --- | --- | --- |
| npm | `npm i -D ./harness-cli-0.1.0.tgz` | `npm run test:e2e` · `npm run test:e2e -- --tag smoke` · `npx --no-install harness run tests/e2e` |
| pnpm | `pnpm add -D ./harness-cli-0.1.0.tgz` | `pnpm test:e2e` · `pnpm exec harness run tests/e2e` |
| Yarn | `yarn add -D ./harness-cli-0.1.0.tgz` | `yarn test:e2e` · `yarn run harness run tests/e2e` |

`npx --no-install` is deliberate: it refuses to fetch an unverified package of the same name from
the public registry.

The published package is **ESM**. A CommonJS consumer does not have to convert: the CLI is a
compiled executable and only ever *reads* your project's `harness.config.ts`.

## `harness run`

| option | meaning |
| --- | --- |
| `--config, -c <path>` | Path to `harness.config.ts`. Default: the nearest one at or above the working directory. |
| `--tag <name>` | Repeatable. A scenario is selected if it carries **any** of the tags. |
| `--input, -i <key=value>` | Repeatable. Scenario input. **Always a string.** |
| `--inputs-file <file.json>` | Scenario inputs with JSON types preserved (string / number / boolean). |
| `--reporter, -r <name>` | Repeatable: `console`, `json`, `junit`. Default: `console`. |
| `--output, -o <dir>` | Where run directories are written. Default: `runs`. |
| `--provider <scripted\|anthropic>` | Model provider. |
| `--model <id>` | Provider-specific model id. Never defaulted in code. |
| `--base-url <url>` | The application under test. |
| `--max-actions <n>` | The **indicative** action threshold. |
| `--ui` | Serve the live dashboard while the run progresses (loopback only). |
| `--ui-port <n>` / `--ui-host <host>` | Default `0` (ephemeral) and `127.0.0.1`. |
| `--headed` | Run the browser with a visible window. |

### Precedence

Two separate ladders, both highest-wins.

**Scenario data (inputs)** — `config.inputs` < spec frontmatter `inputs` < `--inputs-file` <
`--input`. A key that neither the config nor the spec *declares* is **rejected**, whichever side
supplies it. `--input k=v` always produces a string; `--inputs-file` keeps JSON types.

**Execution options** — built-in defaults < `harness.config.ts` < CLI flags. Only flags you
actually pass become overrides; an absent flag leaves the file's value alone. The resolved,
non-sensitive configuration is printed before launch (values whose key looks like a credential are
replaced with `«redacted»`; secrets live in environment variables and are never printed, logged or
put in a prompt).

### Discovery

`**/*.e2e.md`, honouring `include` / `exclude`, and always excluding `node_modules`, `dist` and
`runs`. `include` / `exclude` are resolved against the directory holding `harness.config.ts`, so the
selection does not depend on where you invoke the CLI from — and they keep working when `include`
points outside that directory (`../scenarios/**`). Arguments may be files, directories or globs,
they are resolved against the **invocation** directory, and they replace `include` for that
invocation. The result is **stably sorted**, so two identical invocations run the same scenarios in
the same order.

**A literal `*.e2e.md` file named on the command line bypasses `exclude`.** Naming one file is an
unambiguous instruction; a glob or a directory is still filtered, or `harness run .` would walk
`node_modules`.

Quote your globs — the harness does the matching, not the shell:

```sh
harness run 'tests/e2e/**/*.e2e.md'   # bash only recurses on ** with `shopt -s globstar`
harness run tests/e2e                  # a directory means tests/e2e/**/*.e2e.md
harness run tests/e2e/login.e2e.md     # a literal path, no crawling
```

**Selecting nothing is an explicit error (exit 2), never a silent success** — including when a
glob or a `--tag` filter matched nothing.

Because `harness` alone is an alias of `harness run`, a file literally named `run`, `list`,
`validate` or `report` in first position is read as the subcommand. Write `harness ./run` or
`harness -- run`.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | every selected scenario passed |
| `1` | any scenario `failed` or `inconclusive` |
| `2` | invalid configuration, unusable arguments, no scenario selected, or an execution error |
| `130` | user interrupt — Ctrl-C, or the dashboard's cancel command |

SIGINT produces `130` **after** the finalizers have run: the browser context is closed, the trace is
settled and the fixture cleanups have executed. A cancellation from the dashboard is the same thing
over HTTP, and the `202` from `POST /api/cancel` is only sent once that teardown has completed — no
late action or request can land afterwards.

JUnit mapping: product criterion failures become `<failure>`; technical errors, indeterminate
results and cancellations become `<error>` with the real status preserved in the message and in
`result.json`. An indeterminate result is never turned into a green `skipped`.

### Reporters

`report.html`, `result.json` and `junit.xml` are **always** written into the run directory — that is
the layout `harness report` replays from. `--reporter` chooses what reaches your terminal:

* `console` — scenario names, statuses, durations, indicative-threshold crossings, the criteria that
  explain a non-passing verdict, a global summary and the report path. ASCII status labels, fixed
  width, no colour, no animation: identical on a TTY and in a CI log.
* `json` — **one** JSON document on stdout and nothing else. Every diagnostic, including the
  resolved configuration, moves to stderr.
* `junit` — announces `junit.xml` in the console output.

## `harness list` and `harness validate`

Neither starts a model or a browser.

`validate` checks the frontmatter, the input declarations and precedence, every `{{ … }}`
reference, and the fixture / check names against the project registry. It **accepts** unresolved
`{{ fixture.* }}`: no setup has run, so those values cannot exist yet. `run` rejects an unresolved
fixture reference *after* setup. Both commands accept `--json`.

## `harness report <run-directory>`

Rebuilds `report.html` (and `result.json` / `junit.xml`) from the persisted run directory alone:
no model call, no browser, no replay, and no configuration re-resolution. `manifest.json` is the
sole source of "which adapter was used", so a scripted run can never be re-presented as a model
validation.

## The live dashboard (`--ui`)

Loopback only by default. `--ui-host` accepts something else and says loudly that it is no longer
loopback.

| endpoint | |
| --- | --- |
| `GET /` and every other path | the dashboard assets |
| `GET /api/ui/events` | SSE of **raw `HarnessEvent`s** for the run being followed — what `apps/ui` consumes |
| `GET /api/events` | SSE of the CLI's own stream: scenario lifecycle plus every harness event, wrapped |
| `POST /api/cancel` | `{"reason": "…"}` → `202`, cancels the run cleanly |
| `GET /api/contract` | the frozen `contract.json` of the run being followed (`404` until it is frozen) |
| `GET /api/artifacts/<run-relative path>` | evidence files, as recorded in `artifactAvailable.path` |
| `GET /api/state` | a snapshot the dashboard can render before any event arrives |
| `GET /api/health` | `204` |

The served `index.html` gets a
`<script id="harness-ui-runtime">globalThis.__HARNESS_UI__ = { … }</script>` injected before the
bundle — the override documented by `apps/ui/src/runtime/config.ts` — so the UI points at the
endpoints above instead of its relative defaults.

Two streams because they answer different questions. `/api/ui/events` is the run's own journal:
`id:` is the harness event `seq`, each frame is named after the event type, and it resets at the
start of every scenario because the UI models exactly one run and closes itself on `runFinished`.
`/api/events` re-sequences everything onto one cursor that keeps counting across scenarios, which is
what a multi-scenario invocation needs. Both honour `Last-Event-ID` and `?lastEventId=`.

**Resume.** Every message carries a contiguous `id` starting at 1. A reconnect sends
`Last-Event-ID` (the browser's `EventSource` does this by itself) and the server replays the
journal from there. A reconnection neither loses nor duplicates a displayed event:

* the subscriber queue is registered **before** the replay snapshot is taken, so nothing published
  in between is missed;
* the overlap between the snapshot and the live queue is dropped by sequence number, not duplicated;
* each client's queue is **bounded and dropping**, so a slow reader can never make the runner wait —
  and when a message arrives out of sequence the server fills the gap from the journal before
  emitting it, so the client catches up without reconnecting at all.

A run progresses with no dashboard attached, and CI runs with no UI server at all.

The dashboard is served from `assets/ui` (the built `apps/ui`) when it is present, and from the
self-contained `assets/dashboard.html` otherwise. Both are resolved from the **installed** package
via `import.meta.url`, never from a workspace path, and the bytes are read and served from memory
so the CLI also works under yarn PnP, where the resolved path lives inside a zip.

Known limitation: the dashboard journal is fed from the run store's live fan-out, which is a
*dropping* pub-sub so the runner can never be blocked by a subscriber. If the fan-out ever dropped
(the recorder would have to fall more than 1024 events behind, which only pushes into an array),
those harness events would be missing from the dashboard journal. The SSE sequence stays contiguous
either way, and `events.jsonl` on disk is always complete.

## `harness.config.ts`

Loaded as **trusted project code**. Its path comes from `--config` or an upward lookup from the
working directory — **never** from a name inside a spec. Bare `import()` first (Node ≥ 22.18 strips
types natively), falling back to `tsx`'s `tsImport`, which covers non-erasable TypeScript (`enum`,
`namespace`, parameter properties) and CommonJS-typed consumers. `tsx` ships as a real dependency;
no global loader to install. `.ts`, `.mts`, `.mjs` and `.js` are all accepted.

A project with no config file runs on the built-in defaults — a text-only scenario needs no support
registry at all.

```ts
import { defineConfig } from "@harness/cli"

export default defineConfig({
  baseUrl: "http://127.0.0.1:3000",
  provider: "anthropic",
  model: "claude-sonnet-5",
  providerOptions: { maxTokens: 2048, temperature: 0 }
})
```

The package also re-exports the public types (`ResolvedConfig`, `Fixture`, `Check`, `RunResult`,
`HarnessEvent`, …) from `@harness/core`.

### The scripted provider

`provider: "scripted"` is a deterministic, network-free test double. It answers with canned
verdicts, all labelled `scripted-model` so they can never be read as a model judgement.

**A real walkthrough comes from the `scripts` registry**, exactly the way fixtures and checks do —
by name, never by module path:

```ts
export default defineConfig({
  provider: "scripted",
  scripts: { healthy: myScriptFactory },
  providerOptions: { script: "healthy" }
})
```

An entry is a **factory**, not a finished script: it is called with `ScriptFactoryContext`
(`runId`, `attemptId`, `scenarioId`, `specPath`, `baseUrl`, the resolved `inputs` and the
`criterionIds` of the spec) once the run id is minted and the inputs are resolved, and before the
browser opens — because a deterministic script has to type the value the run will really use.
It returns `{ agent, verdicts?, defaultUsage? }` from `@harness/agent-runtime`. See
`examples/support/scripts/registry.ts` for a worked one.

Without `script`, a built-in generic walkthrough runs (observe → fill → submit → observe →
screenshot → ask for every criterion → finish), steered by the remaining options:

```ts
providerOptions: {
  scenario: "happy-path",                    // or "premature-finish"
  fills: [{ name: "Nom du projet", value: "Démo" }],
  submit: "Créer",                           // accessible name of the submit control
  verdict: "passed"                          // default: "inconclusive" — evidence is never assumed
}
```

## Build and packaging

| script | |
| --- | --- |
| `pnpm build` | `tsc -b` — the workspace build, used by project references |
| `pnpm build:bundle` | `tsdown` — the shippable artifact; also what `prepack` runs |
| `pnpm test` | `vitest run --config vitest.config.ts` |

`build:bundle` emits ESM with `.js` / `.d.ts` extensions, keeps the shebang, and sets the executable
bit. `effect`, `@effect/*`, `playwright`, `tsx`, `yaml` and `tinyglobby` stay **external** —
bundling `effect` would fight its module-instance-sensitive service identity and `playwright` cannot
be bundled at all — while the private `@harness/*` workspace packages are bundled in.

The four `@harness/*` workspace packages sit in **`devDependencies`**, not `dependencies`. That is
load-bearing rather than tidy: `pnpm pack` rewrites `workspace:*` to `0.1.0`, and a runtime
dependency on `@harness/core@0.1.0` would send an installer looking for a version that exists on no
registry. They are bundled in, so the tarball needs none of them at runtime. The bare imports left in
the bundle are exactly `effect`, `effect/unstable/{ai,cli,http,encoding}`,
`@effect/platform-node/{NodeRuntime,NodeServices,NodeHttpServer}`, `@effect/ai-anthropic`,
`playwright`, `yaml`, `tinyglobby` and `node:*` — plus `tsx`, imported dynamically by the config
loader.

**The `@effect/platform-node` imports are deep subpaths, never the barrel.** The barrel re-exports
`NodeRedis`, which eagerly imports `redis` — a *non-optional* peer dependency of that package. npm
and pnpm auto-install peers so the barrel appears to work there; Yarn does not, and an installed CLI
died with `ERR_MODULE_NOT_FOUND: Cannot find package 'redis'`.

### The consumer matrix (spec §13, last bullet)

`apps/cli/scripts/consumer-smoke/run.sh [workdir] [npm|pnpm|yarn...]` is the whole check, in one
command. It runs `pnpm pack`, refuses a tarball whose `dependencies` contain a `@harness/*` entry,
then for each package manager scaffolds a throwaway consumer **outside this workspace** — its own
trivial static page, its own zero-dependency server, its own `harness.config.ts` and scenario — and
installs only the tarball. Per consumer it asserts 24 things: `--version`, `--help`, `list`,
`validate`, `list --tag`, the `"test:e2e": "harness run"` package.json script, a passing run
(exit 0), a failing one (exit 1), an invalid spec named explicitly (exit 2), a selection that
matches nothing (exit 2), a quoted glob, the eight files of the run directory, a `report.html` with
no remote asset reference, `harness report <dir>` rebuilding it, the dashboard served from the
installed package, and that nothing in the installed `dist` names the development workspace.

Verified on this machine, Node 24.19.0, 24/24 in every cell:

| consumer | npm 11.17.0 | pnpm 10.29.3 | Yarn 4.13.0 (corepack) | Yarn 1.22.22 |
| --- | --- | --- | --- | --- |
| `"type": "module"`, erasable config | 24/24 | 24/24 | 24/24 | 24/24 |
| `"type": "commonjs"`, config with an `enum` | 24/24 | 24/24 | 24/24 | 24/24 |

The CommonJS row matters twice over: a CJS-typed package cannot load an `import` statement and Node
cannot strip an `enum`, so those cells pass only through the bundled `tsx` fallback. The pnpm and
Yarn cells matter because both build a strict `node_modules` — a phantom dependency fails there and
nowhere else. Yarn 4 was also run with `nodeLinker: pnp`: the CLI passed every command, including
serving the 254 KB dashboard bundle out of a zip-backed virtual path. The `yarn1` lane exists
because a Yarn 1 consumer is still common; it caches a local tarball by name and version, so the
script copies the tarball under a fresh name before installing — otherwise a rebuild silently
reinstalls the previous bytes.

The package is still not published to any registry; the consumers install the tarball by path.

### External system dependencies

* **Chromium at the revision pinned by `playwright@1.63.0`**, plus its Linux shared libraries:
  `pnpm exec playwright install --with-deps chromium` (apt, so root). Consumers install
  `playwright` from the tarball's own dependencies and find the browsers in the shared
  `~/.cache/ms-playwright`; they never download one.
* **Corepack**, only for the Yarn cell of the matrix.
* Nothing else. The scripted adapter makes no network call, and the demo app binds an ephemeral
  loopback port.

### CI

`.github/workflows/ci.yml` runs, on every push and pull request: `pnpm install --frozen-lockfile`,
`pnpm run typecheck`, `pnpm run test` (the Vitest suites of every package **and** of this one),
Chromium with its Linux deps, the consumer matrix above, and finally the example scenarios executed
through the **distributed** CLI — the binary from the tarball, installed outside the checkout —
with the scripted adapter against the demo app
(`apps/cli/scripts/ci/run-examples.sh [workdir] [variant...]`). Artifacts upload with
`if: always()`. There are **no scenario retries**.

The real-model smoke test is a separate job that runs only on a manual dispatch with
`real_model: true`, reads `ANTHROPIC_API_KEY` from the repository secrets and is
`continue-on-error` — its verdict is reported on its own and can never block a contributor who has
no key.
