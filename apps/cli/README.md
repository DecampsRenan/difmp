# `difmp` — the CLI package

This is the distributable: the binary, the layer assembly, the SSE server, the console reporter and
the exit codes. It runs from any consumer project once installed as a dev dependency — no clone of
this repository, no orchestration script, no global loader.

**Start with the [root README](../../README.md).** It is the user-facing document: how to install
difmp in a project, write scenarios, choose a provider, read results, and the full command and option
reference. This file covers what a packager, a CI author or a contributor needs and the root README
deliberately does not carry:

|                                                                     |                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [The scripted provider in detail](#the-scripted-provider-in-detail) | the script factory contract and the built-in generic walkthrough |
| [The dashboard's HTTP surface](#the-dashboards-http-surface)        | endpoints, the two SSE streams, the resume contract              |
| [Build and packaging](#build-and-packaging)                         | what is bundled, what stays external, and why                    |
| [The consumer matrix](#the-consumer-matrix)                         | npm / pnpm / Yarn × ESM / CJS, verified                          |
| [External system dependencies](#external-system-dependencies)       | what has to exist on the machine                                 |
| [CI](#ci)                                                           | what `.github/workflows/ci.yml` actually runs                    |

```text
difmp [file-or-dir-or-glob...]          alias of `difmp run`
difmp run [file-or-dir-or-glob...]
difmp list [--tag smoke] [--json]
difmp validate [file-or-dir-or-glob...] [--json]
difmp report <run-directory>
difmp --help
difmp --version
```

## Command notes

Only the parts that are not in the root README's [CLI
reference](../../README.md#cli-reference).

**`list` and `validate`** start neither a model nor a browser. `validate` checks the frontmatter, the
input declarations and precedence, every `{{ … }}` reference, and the fixture / check names against
the project registry. It **accepts** unresolved `{{ fixture.* }}`: no setup has run, so those values
cannot exist yet — `run` rejects an unresolved fixture reference _after_ setup. Both accept `--json`.

**`report <run-directory>`** rebuilds `report.html`, `result.json` and `junit.xml` from the persisted
run directory alone: no model call, no browser, no replay, no configuration re-resolution.
`manifest.json` is the sole source of "which adapter was used", so a scripted run can never be
re-presented as a model validation.

**Reporters.** `--reporter` chooses what reaches the terminal and accepts `console`, `json` and
`junit`. The config file's `reporters` array additionally accepts `"html"`, which announces the
report path. `report.html`, `result.json` and `junit.xml` are written into the run directory either
way — that is the layout `report` replays from.

- `console` — ASCII status labels, fixed width, no colour, no animation: identical on a TTY and in a
  CI log.
- `json` — **one** JSON document on stdout and nothing else. Every diagnostic, including the resolved
  configuration, moves to stderr.
- `junit` — announces `junit.xml` in the console output.

**JUnit mapping.** Product criterion failures become `<failure>`; technical errors, indeterminate
results and cancellations become `<error>`, with the real status preserved in the message and in
`result.json`. An indeterminate result is never turned into a green `skipped`.

**Cancellation.** SIGINT produces exit `130` _after_ the finalizers have run: the browser context is
closed, the trace is settled and the fixture cleanups have executed. A cancellation from the
dashboard is the same thing over HTTP, and the `202` from `POST /api/cancel` is only sent once that
teardown has completed — no late action or request can land afterwards. The one asymmetry: SIGINT
interrupts the CLI before the _file reporters_ run, so a Ctrl-C'd run directory has `result.json` but
no `junit.xml` or `report.html` until `difmp report <dir>` rebuilds them. The dashboard's Cancel
button writes them in the first place.

## `difmp.config.ts` loading

Loaded as **trusted project code**. Its path comes from `--config` or an upward lookup from the
working directory — **never** from a name inside a scenario. Bare `import()` first (Node ≥ 22.18
strips types natively), falling back to `tsx`'s `tsImport`, which covers non-erasable TypeScript
(`enum`, `namespace`, parameter properties) and CommonJS-typed consumers. `tsx` ships as a real
dependency; there is no global loader to install. `.ts`, `.mts`, `.mjs` and `.js` are all accepted.

The only basename discovered is `difmp.config`, in extension order `.ts`, `.mts`, `.mjs`, `.js`. The
pre-rename `harness.config.*` is **not** a fallback: a project that still has one gets the built-in
defaults, not its configuration. Rename the file.

The package re-exports `defineConfig` and the public types (`ResolvedConfig`, `Fixture`, `Check`,
`RunResult`, `HarnessEvent`, …) from `@difmp/core`, so a consumer needs no second dependency.

## The scripted provider in detail

`provider: "scripted"` is a deterministic, network-free test double. It answers with canned verdicts,
all labelled `evaluator.kind: "scripted-model"` so they can never be read as a model judgement.

**A real walkthrough comes from the `scripts` registry**, exactly the way fixtures and checks do — by
name, never by module path:

```ts
export default defineConfig({
  provider: "scripted",
  scripts: { healthy: myScriptFactory },
  providerOptions: { script: "healthy" },
});
```

An entry is a **factory**, not a finished script. It is called with `ScriptFactoryContext` — `runId`,
`attemptId`, `scenarioId`, `specPath`, `baseUrl`, the resolved `inputs` and the `criterionIds` of the
spec — once the run id is minted and the inputs are resolved, and **before the browser opens**,
because a deterministic script has to type the value the run will really use. It returns
`{ agent, verdicts?, defaultUsage? }` from `@difmp/agent-runtime`. See
[`examples/support/scripts/registry.ts`](../../examples/support/scripts/registry.ts) for a worked one.

Without `script`, a built-in generic walkthrough runs (observe → fill → submit → observe →
screenshot → ask for every criterion → finish), steered by the remaining options:

```ts
providerOptions: {
  scenario: "happy-path",                    // or "premature-finish"
  fills: [{ name: "Project name", value: "Demo" }],
  submit: "Create project",                  // accessible name of the submit control
  verdict: "passed"                          // default: "inconclusive" — evidence is never assumed
}
```

With **neither** a `script` nor a `verdict`, the double asserts nothing and the run correctly comes
back `inconclusive` with exit `1`.

## The dashboard's HTTP surface

`--ui` is an option of the runner, never a requirement: a run progresses with no dashboard attached
and CI runs with no UI server at all. Loopback only by default; `--ui-host` accepts something else and
says loudly that it is no longer loopback.

| endpoint                                 |                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /` and every other path             | the dashboard assets                                                                |
| `GET /api/ui/events`                     | SSE of **raw `HarnessEvent`s** for the run being followed — what `apps/ui` consumes |
| `GET /api/events`                        | SSE of the CLI's own stream: scenario lifecycle plus every harness event, wrapped   |
| `POST /api/cancel`                       | `{"reason": "…"}` → `202`, cancels the run cleanly                                  |
| `GET /api/contract`                      | the frozen `contract.json` of the run being followed (`404` until it is frozen)     |
| `GET /api/artifacts/<run-relative path>` | evidence files, as recorded in `artifactAvailable.path`                             |
| `GET /api/state`                         | a snapshot the dashboard can render before any event arrives                        |
| `GET /api/health`                        | `204`                                                                               |

The served `index.html` gets a
`<script id="difmp-ui-runtime">globalThis.__DIFMP_UI__ = { … }</script>` injected before the bundle —
the override documented by `apps/ui/src/runtime/config.ts` — so the UI points at the endpoints above
instead of its relative defaults.

Two streams because they answer different questions. `/api/ui/events` is the run's own journal: `id:`
is the harness event `seq`, each frame is named after the event type, and it resets at the start of
every scenario because the UI models exactly one run and closes itself on `runFinished`.
`/api/events` re-sequences everything onto one cursor that keeps counting across scenarios, which is
what a multi-scenario invocation needs. Both honour `Last-Event-ID` and `?lastEventId=`.

**Resume.** Every message carries a contiguous `id` starting at 1. A reconnect sends `Last-Event-ID`
(the browser's `EventSource` does this by itself) and the server replays the journal from there. A
reconnection neither loses nor duplicates a displayed event:

- the subscriber queue is registered **before** the replay snapshot is taken, so nothing published in
  between is missed;
- the overlap between the snapshot and the live queue is dropped by sequence number, not duplicated;
- each client's queue is **bounded and dropping**, so a slow reader can never make the runner wait —
  and when a message arrives out of sequence the server fills the gap from the journal before
  emitting it, so the client catches up without reconnecting at all.

The dashboard is served from `assets/ui` (the built `apps/ui`) when it is present, and from the
self-contained `assets/dashboard.html` otherwise. Both are resolved from the **installed** package via
`import.meta.url`, never from a workspace path, and the bytes are read and served from memory so the
CLI also works under Yarn PnP, where the resolved path lives inside a zip.

> **Known limitation.** The dashboard journal is fed from the run store's live fan-out, which is a
> _dropping_ pub-sub so the runner can never be blocked by a subscriber. If the fan-out ever dropped
> (the recorder would have to fall more than 1024 events behind, which only pushes into an array),
> those harness events would be missing from the dashboard journal. The SSE sequence stays contiguous
> either way, and `events.jsonl` on disk is always complete.

## Build and packaging

| script              |                                                             |
| ------------------- | ----------------------------------------------------------- |
| `pnpm build`        | `tsc -b` — the workspace build, used by project references  |
| `pnpm build:bundle` | `tsdown` — the shippable artifact; also what `prepack` runs |
| `pnpm test`         | `vitest run --config vitest.config.ts`                      |

`build:bundle` emits ESM with `.js` / `.d.ts` extensions, keeps the shebang, and sets the executable
bit. `effect`, `@effect/*`, `playwright`, `tsx`, `yaml` and `tinyglobby` stay **external** — bundling
`effect` would fight its module-instance-sensitive service identity and `playwright` cannot be bundled
at all — while the private `@difmp/*` workspace packages are bundled in.

The four `@difmp/*` workspace packages sit in **`devDependencies`**, not `dependencies`. That is
load-bearing rather than tidy: `pnpm pack` rewrites `workspace:*` to `0.1.0`, and a runtime dependency
on `@difmp/core@0.1.0` would send an installer looking for a version that exists on no registry. They
are bundled in, so the tarball needs none of them at runtime. The bare imports left in the bundle are
exactly `effect`, `effect/unstable/{ai,cli,http,encoding}`,
`@effect/platform-node/{NodeRuntime,NodeServices,NodeHttpServer}`, `@effect/ai-anthropic`,
`playwright`, `yaml`, `tinyglobby` and `node:*` — plus `tsx`, imported dynamically by the config
loader.

**The `@effect/platform-node` imports are deep subpaths, never the barrel.** The barrel re-exports
`NodeRedis`, which eagerly imports `redis` — a _non-optional_ peer dependency of that package. npm and
pnpm auto-install peers so the barrel appears to work there; Yarn does not, and an installed CLI died
with `ERR_MODULE_NOT_FOUND: Cannot find package 'redis'`.

> **`pnpm pack` replaces `dist`.** `prepack` → `build:bundle` runs tsdown with `clean: true`, so after
> packing, `apps/cli/dist` holds the bundle rather than the `tsc -b` layout. The bundle runs, but it
> has `@difmp/*` baked in and will not reflect an edit under `packages/` until it is rebuilt.
> `pnpm build` restores the `tsc -b` layout — it deletes `tsconfig.tsbuildinfo` first, without which
> `tsc` would consider itself up to date and silently leave the stale bundle in place.

## The consumer matrix

`apps/cli/scripts/consumer-smoke/run.sh [workdir] [npm|pnpm|yarn|yarn1...]` is the whole check, in one
command. It runs `pnpm pack`, refuses a tarball whose `dependencies` contain a `@difmp/*` entry, then
for each package manager scaffolds a throwaway consumer **outside this workspace** — its own trivial
static page, its own zero-dependency server, its own `difmp.config.ts` and scenario — and installs
only the tarball.

Per consumer it asserts 24 things: `--version`, `--help`, `list`, `validate`, `list --tag`, the
`"test:e2e": "difmp run"` package.json script, a passing run (exit 0), a failing one (exit 1), an
invalid spec named explicitly (exit 2), a selection that matches nothing (exit 2), a quoted glob, the
eight files of the run directory, a `report.html` with no remote asset reference, `difmp report <dir>`
rebuilding it, the dashboard served from the installed package, and that nothing in the installed
`dist` names the development workspace.

Verified on this machine, Node 24.19.0, 24/24 in every cell:

| consumer                                    | npm 11.17.0 | pnpm 10.29.3 | Yarn 4.13.0 (corepack) | Yarn 1.22.22 |
| ------------------------------------------- | ----------- | ------------ | ---------------------- | ------------ |
| `"type": "module"`, erasable config         | 24/24       | 24/24        | 24/24                  | 24/24        |
| `"type": "commonjs"`, config with an `enum` | 24/24       | 24/24        | 24/24                  | 24/24        |

The CommonJS row matters twice over: a CJS-typed package cannot load an `import` statement and Node
cannot strip an `enum`, so those cells pass only through the bundled `tsx` fallback. (They also pay
for it with a `Warning: Failed to load the ES module` on stderr per invocation — harmless, and the
reason the root README suggests `"type": "module"`.) The pnpm and Yarn cells matter because both build
a strict `node_modules`: a phantom dependency fails there and nowhere else. Yarn 4 was also run with
`nodeLinker: pnp` and passed every command, including serving the 254 KB dashboard bundle out of a
zip-backed virtual path. The `yarn1` lane exists because a Yarn 1 consumer is still common; it caches
a local tarball by name and version, so the script copies the tarball under a fresh name before
installing — otherwise a rebuild silently reinstalls the previous bytes.

**Install-script caveat.** The package pulls `esbuild` in transitively through `tsx`. pnpm ≥ 12 turns
an ignored dependency build into an error — `pnpm add -D <package>` ends with `ERR_PNPM_IGNORED_BUILDS
· Ignored build scripts: esbuild@0.28.2` and exit `1` — so install with `pnpm add -D
--allow-build=esbuild <package>`, or run `pnpm approve-builds` afterwards. Verified against pnpm
12.4.1 and 10.29.3; pnpm 10 only prints a warning and exits 0, which is why the matrix above is green
on this machine and the same step is **red on GitHub Actions**, where the consumer installs resolve
pnpm 12.4.1. npm 11 prints `npm warn allow-scripts` and exits 0. The installed tree is complete either
way, `tsx` fallback included.

The package is still not published to any registry; consumers install the tarball by path.

## External system dependencies

- **Chromium at the revision pinned by `playwright@1.63.0`**, plus its Linux shared libraries:
  `pnpm exec playwright install --with-deps chromium` (apt, so root). Consumers install `playwright`
  from the tarball's own dependencies and find the browsers in the shared `~/.cache/ms-playwright`;
  they never download one.
- **Corepack**, only for the Yarn cells of the matrix.
- **`xdg-utils`** if you want `xdg-open report.html` to work. It is _not_ present on a bare Linux box;
  `report.html` is a single offline file, so pointing a browser at the absolute path is equivalent.
- Nothing else. The scripted adapter makes no network call, and the demo app binds an ephemeral
  loopback port.

## CI

`.github/workflows/ci.yml` runs, on every push and pull request: `pnpm install --frozen-lockfile`,
`pnpm run typecheck`, `pnpm run test` (the Vitest suites of every package **and** of this one),
Chromium with its Linux deps, the consumer matrix above, and finally the example scenarios executed
through the **distributed** CLI — the binary from the tarball, installed outside the checkout — with
the scripted adapter against the demo app
(`apps/cli/scripts/ci/run-examples.sh [workdir] [variant...]`). Artifacts upload with `if: always()`.
There are **no scenario retries**.

The real-model smoke test is a separate job that runs only on a manual dispatch with
`real_model: true`, reads `ANTHROPIC_API_KEY` from the repository secrets and is `continue-on-error` —
its verdict is reported on its own and can never block a contributor who has no key.
