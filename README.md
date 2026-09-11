# Agentic E2E harness

A TypeScript/Effect harness that runs end-to-end scenarios written in Markdown with YAML
frontmatter. A model chooses the navigation; **the harness owns the tools, the budgets, the
verification and the evidence**. You get a run directory you can read afterwards: a journal, the
frozen contract, screenshots, aria snapshots, a Playwright trace, a JUnit file and a standalone HTML
report.

```markdown
---
version: 1
id: project-create
inputs: { projectName: "Projet {{ run.id }}" }
verification: |
  - Le projet {{ projectName }} apparaît dans la liste après sa création.
  - Le projet {{ projectName }} est toujours présent après un rechargement complet de la page.
---

Depuis l'accueil, créer un projet nommé {{ projectName }}, puis recharger la page.
```

```
$ harness run examples/scenarios/project-create.e2e.md --config examples/support/harness.config.ts
PASS  project-create  4.4s  ../scenarios/project-create.e2e.md
      actions 8/25 indicatives · model calls 14 · tokens 2240
      criteria: 3 · run r_xgqxoxsbcesee · report …/runs/r_xgqxoxsbcesee/report.html
```

`harness` is the executable an **installed** package puts on your PATH. This repository installs
nothing globally and has no `harness` bin of its own — inside the checkout, every invocation below
is written out in full as `node apps/cli/dist/bin/harness.js` (after `pnpm build`). If you would
rather type `harness`, alias it once: `alias harness="node $PWD/apps/cli/dist/bin/harness.js"`.

**The specs and the example scenarios are in French; the code, the comments and this documentation
are in English.** That split is deliberate and it is the only language rule in the repository.

Two documents sit next to this one and are worth reading before you change anything:
[`docs/architecture.md`](docs/architecture.md) (the seams, the decisions and the **honest
limitations**) and [`docs/spec.md`](docs/spec.md) (the product brief, in French).

---

## Prerequisites

| | |
| --- | --- |
| Node.js | `>= 22.12.0` (declared in every `engines.node`). Verified here on **v24.19.0**. |
| pnpm | `10.29.3`, pinned in the root `packageManager` field. Only needed to work *on* the harness — a consumer project uses npm, pnpm or Yarn. |
| Browser | Playwright **1.63.0** Chromium. Nothing else is launched. |
| OS | Linux/macOS. The demo app and the dashboard bind `127.0.0.1` only. |

No model API key is needed for anything in this repository: every reproducible test and the whole
demo run on the deterministic scripted adapter.

---

## From a clean checkout

```sh
pnpm install --frozen-lockfile
npx playwright install chromium        # add --with-deps on a bare Linux box (needs root)
pnpm build                             # packages/* and apps/* — tsc -b, plus vite build for the UI
pnpm --filter @harness/fixture-app build   # the demo app; `pnpm build` does NOT cover examples/*
```

Then:

```sh
pnpm typecheck     # tsc -b tsconfig.build.json — the whole workspace, examples included
pnpm test          # vitest run
```

Observed, in this order, on a **fresh `git clone`** of this repository (Node v24.19.0, pnpm
10.29.3):

```
pnpm install --frozen-lockfile   ->  Lockfile is up to date, resolution step is skipped. Done in 2.3s
                                     + 2 warnings, see below
npx playwright install chromium  ->  exit 0 (silent when the browser is already in the cache)
pnpm build                       ->  Scope: 6 of 9 workspace projects, exit 0
pnpm --filter @harness/fixture-app build  ->  exit 0
pnpm typecheck                   ->  exit 0
pnpm test                        ->  Test Files 21 passed (21) · Tests 312 passed (312), exit 0
```

The test count is what the suite reported at the time of writing; treat the exit code as the
contract, not the number. A clone and a working copy report the same figure — `vitest.config.ts`
only globs tracked directories, deliberately, so the suite a contributor runs is the suite CI runs.

> The **first** `pnpm install` in a clone prints two warnings:
> `WARN Failed to create bin at …/examples/support/node_modules/.bin/fixture-app. ENOENT … examples/fixture-app/dist/main.js`.
> They are expected and harmless: that bin points at a build output that does not exist yet. They
> are gone the next time you install, once `pnpm --filter @harness/fixture-app build` has run.
> Nothing below uses that bin — the demo calls `node examples/fixture-app/dist/main.js` directly.

`pnpm build` filters `./packages/*` and `./apps/*`; `examples/*` is not in that scope, which is why
the fixture app is built separately. `pnpm typecheck` does cover `examples/*` — it is the project
references build of `tsconfig.build.json`.

> `npx playwright install --with-deps chromium` installs the Linux system libraries as well
> (`libnss3`, `libnspr4`, `libasound2`, …) and needs root. On this machine those libraries were
> already present, so only `npx playwright install chromium` was run and verified.

---

## Run the demo

The demonstration is a tiny "Projects" app ([`examples/fixture-app`](examples/fixture-app/README.md)) with four
reproducible variants, three scenarios ([`examples/scenarios`](examples/scenarios/README.md)) and the project
side a real consumer would write ([`examples/support`](examples/support/README.md)).

**1. Start the app under test.** It binds `127.0.0.1` only and prints the guarded seed token. It
**runs in the foreground and does not return your prompt** — use a second terminal for the rest, or
append `&` and keep the job id, because you will need to stop it before restarting it on the same
port:

```sh
node examples/fixture-app/dist/main.js --port 3000 --variant healthy \
     --seed --seed-email demo@example.test --seed-password demo-password
```

```
fixture-app listening on http://127.0.0.1:3000 (variant: healthy)
x-seed-token: 77ce8a62700ff2171699927fd980a95e
seeded login: demo@example.test / demo-password (sid=…, workspace=ws_…)
```

**2. Export the token** — the fixture and the TS check read it from the environment, never from an
input. Because the fixture reads it through `ctx.secrets`, the harness knows its value and strips it
from the journal, the prompts, the events and the report (it does not appear anywhere in the run
directories produced above). Traces and videos are outside the redactor's reach — see
[`docs/architecture.md`](docs/architecture.md) §4:

```sh
export FIXTURE_APP_SEED_TOKEN=<the token printed above>
```

**3. Run.** From the repository root, with the built CLI:

```sh
node apps/cli/dist/bin/harness.js run --config examples/support/harness.config.ts
```

The demo config enables **all four reporters** (`reporters: ["console", "json", "junit", "html"]`),
and the rule from "The CLI contract" below applies: with `json` among them, **stdout carries one
JSON document — roughly 380 lines — and every human-readable diagnostic goes to stderr.** So what
you see is the resolved-configuration block, then this, interleaved with the JSON:

```
PASS  project-create-checked  4.8s  ../scenarios/project-create-checked.e2e.md
      actions 8/25 indicatives · model calls 13 · tokens 2080
      criteria: 3 · run r_nyqvz3sh4q4pa · report …/examples/support/runs/r_nyqvz3sh4q4pa/report.html
PASS  project-create-no-fixture  5.9s  ../scenarios/project-create-no-fixture.e2e.md
PASS  project-create  4.2s  ../scenarios/project-create.e2e.md

Summary  3 scenarios  14.9s
         3 passed · 0 failed · 0 inconclusive · 0 error · 0 cancelled
```

To read just that, send stdout away — the JSON reporter's document is the only thing on it:

```sh
node apps/cli/dist/bin/harness.js run --config examples/support/harness.config.ts > /dev/null
```

Exit code `0`. Run directories land in **`examples/support/runs/<run-id>/`** — `outputDir` is
`runs`, resolved against the directory holding `harness.config.ts`, so the location does not depend
on where you invoked the CLI from. `result.json`, `junit.xml` and `report.html` are written there
whichever reporters you selected.

Open the report with any browser; it is standalone and offline, so the file path is all you need:

```sh
xdg-open examples/support/runs/<run-id>/report.html      # or: open … on macOS
```

`xdg-open` is part of `xdg-utils` and is **not installed on a bare Linux box** (`command -v
xdg-open` comes back empty on this machine). Without it, copy the single file to a machine that has
a browser, or point the browser at the absolute path yourself — there is nothing to serve.

### The four variants

Restart the app with `--variant <name>` **and** export `FIXTURE_APP_VARIANT=<name>` for the harness
process: the app changes what it does, and the variable tells the deterministic adapter which layout
it is about to meet (`alt-layout` renames every control). Because `--port 0` gives an ephemeral port,
export `HARNESS_BASE_URL` too when you do not pin the port.

**Stop the instance you already have before you start the next one.** Nothing frees port 3000 for
you, and the failure is indirect: the new app dies with
`Error: listen EADDRINUSE: address already in use 127.0.0.1:3000`, so it never prints a token, so
the export below is empty, and the run ends at
`error at stage fixture-setup: fixture "authenticated-workspace" setup failed: … FIXTURE_APP_SEED_TOKEN is not set`
with exit `2` — which looks like a harness bug and is not one.

```sh
kill %1                                  # or Ctrl-C in the terminal running the app
node examples/fixture-app/dist/main.js --port 3000 --variant false-success \
     --seed --seed-email demo@example.test --seed-password demo-password &
export FIXTURE_APP_SEED_TOKEN=<token> FIXTURE_APP_VARIANT=false-success
node apps/cli/dist/bin/harness.js run examples/scenarios/project-create.e2e.md \
     --config examples/support/harness.config.ts
```

Keep `--seed-email` / `--seed-password`: a bare `--seed` generates random credentials
(`user-4cc3d5cc@example.test / pw-cfd6f0b6-0f2`), which is fine for `project-create` — it
authenticates through the fixture and the seed token — but breaks `project-create-no-fixture`, whose
prose and scripted walkthrough both type `demo@example.test` / `demo-password` into the login form.

Observed, one app instance per variant, real Chromium each time:

| variant | run | exit | criteria |
| --- | --- | --- | --- |
| `healthy` | `passed` | 0 | c1 c2 c3 passed |
| `create-500` | `failed` | 1 | c1 c2 c3 failed — the alert quotes `HTTP 500`, `network.jsonl` carries the `500` |
| `false-success` | `failed` | 1 | **c1 passed**, c2 c3 failed — the split is exactly at the reload |
| `alt-layout` | `passed` | 0 | c1 c2 c3 passed, 10 actions instead of 8 (toggle + re-observe) |

`false-success` is the interesting one: the server answers `201 Created` and the page optimistically
renders the project, but nothing is persisted. The creation criterion legitimately passes and the
persistence criterion fails — which is the whole point of asking for evidence *after* a reload.

A complete, unedited run directory for that case is committed at
[`docs/example-run/`](docs/example-run/README.md).

### The live dashboard

```sh
node apps/cli/dist/bin/harness.js run examples/scenarios/project-create.e2e.md \
     --config examples/support/harness.config.ts --ui --ui-port 45123
```

```
Live dashboard  http://127.0.0.1:45123/
```

It streams the run over SSE, shows the criteria with their text and `modèle`/`code` method from the
moment the contract is frozen, and its Cancel button cancels the run cleanly (CLI exit `130`).
Loopback only unless you pass `--ui-host`, which says loudly that it is no longer loopback. `--ui`
is an option of the runner: a CI run starts no server at all.

---

## The CLI contract

```text
harness [file-or-dir-or-glob...]          alias of `harness run`
harness run [file-or-dir-or-glob...]
harness list [--tag smoke] [--json]
harness validate [file-or-dir-or-glob...] [--json]
harness report <run-directory>
harness --help
harness --version
```

`list` and `validate` start neither a model nor a browser. `validate` checks frontmatter, input
declarations and precedence, every `{{ … }}` reference and the fixture/check names against the
project registries; it **accepts** unresolved `{{ fixture.* }}`, because no setup has run.
`report` rebuilds `report.html`, `result.json` and `junit.xml` from the persisted run directory
alone — no model call, no browser, no replay, no config re-resolution.

Because the bare `harness` is an alias of `harness run`, a file literally named `run`, `list`,
`validate` or `report` in first position is read as the subcommand. Write `harness ./run`.

### `harness run` options

| option | meaning |
| --- | --- |
| `--config, -c <path>` | Path to `harness.config.ts`. Default: the nearest one at or above the working directory. |
| `--tag <name>` | Repeatable. A scenario is selected if it carries **any** of the given tags. |
| `--input, -i <key=value>` | Repeatable scenario input. **Always a string.** |
| `--inputs-file <file.json>` | Scenario inputs with JSON types preserved (string / number / boolean). |
| `--reporter, -r <name>` | Repeatable: `console`, `json`, `junit`, `html`. Default: `console`. |
| `--output, -o <dir>` | Where run directories are written. Default: `runs`. |
| `--provider <scripted\|anthropic>` | Model provider. |
| `--model <id>` | Provider-specific model id. Never defaulted in code. |
| `--base-url <url>` | The application under test. |
| `--max-actions <n>` | The **indicative** action threshold. |
| `--ui` | Serve the live dashboard while the run progresses. |
| `--ui-port <n>` / `--ui-host <host>` | Default `0` (ephemeral) and `127.0.0.1`. |
| `--headed` | Run Chromium with a visible window. |

`--reporter` chooses what reaches your **terminal**. `result.json`, `junit.xml` and `report.html`
are *always* written into the run directory — that is the layout `harness report` replays from.
`json` puts exactly one JSON document on stdout and moves every diagnostic to stderr.

### Precedence — two separate ladders

**Scenario data (inputs), lowest to highest:**

```
config.inputs  <  spec frontmatter `inputs`  <  --inputs-file  <  --input
```

A key that neither the config nor the spec **declares** is rejected, whichever side supplies it:

```sh
$ node apps/cli/dist/bin/harness.js run examples/scenarios/project-create.e2e.md \
      -c examples/support/harness.config.ts --input nope=1
ERROR
  ../scenarios/project-create.e2e.md: …/examples/support/harness.config.ts: invalid configuration
  - --input declares "nope", which is not an input of the config or the spec
# exit 2
```

`--input k=v` always yields a string; `--inputs-file` keeps JSON types.

**Execution options, lowest to highest:**

```
built-in defaults  <  harness.config.ts  <  CLI flags
```

Only flags you actually pass become overrides; an absent flag leaves the file's value alone. The
resolved, non-sensitive configuration is printed before launch, with every value parked under a
credential-looking key replaced by `«redacted»`.

### Discovery

`**/*.e2e.md`, honouring `include`/`exclude`, always excluding `node_modules`, `dist` and `runs`.
`include`/`exclude` resolve against the **config's** directory; path arguments resolve against the
**invocation** directory and replace `include` for that invocation. The result is stably sorted.

Quote your globs — the harness does the matching, not the shell:

```sh
harness run 'tests/e2e/**/*.e2e.md'    # bash only recurses on ** with `shopt -s globstar`
harness run tests/e2e                   # a directory means tests/e2e/**/*.e2e.md
harness run tests/e2e/login.e2e.md      # a literal path; naming one file bypasses `exclude`
```

Naming one file explicitly is an unambiguous instruction, so it bypasses `exclude` — that is what
lets a deliberately invalid spec reach the loader and be rejected. A glob or a directory is still
filtered, or `harness run .` would walk `node_modules`.

**Selecting nothing is an explicit error, never a silent success:**

```sh
$ node apps/cli/dist/bin/harness.js list --config examples/support/harness.config.ts --tag nonexistent
ERROR
  no *.e2e.md scenario selected — include ["../scenarios/**/*.e2e.md"] under …/examples/support
  filtered by --tag nonexistent (3 discovered, none matched the tag filter)
# exit 2
```

### Exit codes

| code | meaning |
| --- | --- |
| `0` | every selected scenario passed |
| `1` | any scenario `failed` or `inconclusive` |
| `2` | invalid configuration, unusable arguments, no scenario selected, or an execution error |
| `130` | user interrupt — Ctrl-C, or the dashboard's cancel command |

`130` is produced **after** the finalizers have run: the browser context is closed, the trace is
settled, the fixture cleanups have executed and `result.json` exists. An indeterminate result is
never turned into a green `skipped` in JUnit — product criterion failures become `<failure>`,
technical errors, indeterminate results and cancellations become `<error>` with the real status
preserved in the message.

---

## Using it as a dependency in another project

Nothing is cloned and no orchestration script is written. The package ships a compiled ESM
executable, its TypeScript declarations and the UI/report assets, all resolved from the *installed*
package via `import.meta.url`.

> **Status: the package is not published to any registry.** Everything below was verified against a
> local tarball built with `pnpm pack` in `apps/cli/`. Substitute the published name once it is
> published; the invocations do not change.

```sh
cd apps/cli && pnpm pack --pack-destination /tmp    # -> /tmp/harness-cli-0.1.0.tgz
```

| package manager | install | run |
| --- | --- | --- |
| npm | `npm i -D /tmp/harness-cli-0.1.0.tgz` | `npm run test:e2e` · `npm run test:e2e -- --tag smoke` · `npx --no-install harness run tests/e2e` |
| pnpm | `pnpm add -D /tmp/harness-cli-0.1.0.tgz` | `pnpm test:e2e` · `pnpm exec harness run tests/e2e` |
| Yarn | `yarn add -D /tmp/harness-cli-0.1.0.tgz` | `yarn test:e2e` · `yarn harness run tests/e2e` |

`npx --no-install` is deliberate: it refuses to fetch an unverified package of the same name from
the public registry.

> **If you re-pack, give the tarball a fresh name.** Yarn 1 caches a local tarball by name and
> version, so `yarn add -D ./harness-cli-0.1.0.tgz` after a rebuild silently reinstalls the previous
> bytes. `cp harness-cli-0.1.0.tgz harness-cli-$(date +%s).tgz` before installing avoids it; Yarn 4
> via corepack, npm and pnpm do not need this.

```jsonc
// package.json
{
  "scripts": {
    "test:e2e": "harness run",
    "test:e2e:ui": "harness run --ui"
  }
}
```

```ts
// harness.config.ts
import { defineConfig } from "@harness/cli"

export default defineConfig({
  baseUrl: process.env.APP_URL ?? "http://127.0.0.1:3000",
  provider: "anthropic",
  model: "claude-sonnet-5",
  providerOptions: { maxTokens: 2048, temperature: 0 }
})
```

`defineConfig` is identity plus types; the real validation is core's `resolveConfig`, which rejects
unknown top-level keys. The package also re-exports the public types (`ResolvedConfig`, `Fixture`,
`Check`, `RunResult`, `HarnessEvent`, …). A project with no config file at all runs on the built-in
defaults — a text-only scenario needs no support registry.

`harness.config.ts` is loaded as **trusted project code**, and only from `--config` or an upward
lookup from the working directory — never from a name inside a spec. It is imported with a bare
`import()` first (Node ≥ 22.18 strips types natively), falling back to `tsx`'s `tsImport`, which
covers non-erasable TypeScript (`enum`, `namespace`, parameter properties) and CommonJS-typed
consumers. `tsx` ships as a real dependency; there is no global loader to install. `.ts`, `.mts`,
`.mjs` and `.js` are all accepted.

**Verified end to end**, and re-runnable with one command:

```sh
bash apps/cli/scripts/consumer-smoke/run.sh /tmp/consumer-smoke npm pnpm yarn yarn1
```

It packs the tarball, refuses one whose `dependencies` name a `@harness/*` package, then builds a
throwaway consumer **outside this workspace** for each package manager and module format and puts
24 assertions through it — the bin, discovery, the TypeScript config, the `test:e2e` script, the
run directory, the report assets, the dashboard and all four exit codes. On this machine, Node
24.19.0: **24/24 in all eight cells** — npm 11.17.0, pnpm 10.29.3, Yarn 4.13.0 via corepack and
Yarn 1.22.22, each with a `"type": "module"` consumer and a `"type": "commonjs"` one. (The four
package managers are the arguments: with `npm pnpm yarn` you get six cells, and `yarn1` — Yarn
classic — is the eighth-cell pair.) See [`apps/cli/README.md`](apps/cli/README.md) for the matrix
and the external system dependencies.

> **pnpm 12 refuses the install unless you approve one build script.** pnpm ≥ 12 turns an ignored
> dependency build into an error, and the package pulls `esbuild` in transitively through `tsx`:
> `pnpm add -D <package>` ends with
> `ERR_PNPM_IGNORED_BUILDS · Ignored build scripts: esbuild@0.28.2` and exit `1`. Install with
> `pnpm add -D --allow-build=esbuild <package>` (or run `pnpm approve-builds` afterwards), which
> exits 0 — verified against pnpm 12.4.1 and 10.29.3. The installed tree is complete either way:
> the CLI runs, including the `tsx` fallback a CommonJS consumer's config needs, with the build
> script skipped. pnpm 10.29.3 only prints a warning, which is why the matrix above is green on
> this machine and the same step is **red on GitHub Actions**, where the consumer installs resolve
> pnpm 12.4.1 — see [`docs/architecture.md`](docs/architecture.md) §4.

A consumer run only means something once the adapter does. With `provider: "scripted"` and no
`scripts` entry the built-in double asserts nothing, so such a run comes back `inconclusive` with
exit `1` — correct rather than a defect: evidence is never assumed. A meaningful run needs
`provider: "anthropic"` or a registered script.

The published package is **ESM**. A CommonJS consumer does not have to convert: the CLI is a compiled
executable and only ever *reads* your project's config.

---

## Writing a scenario

A scenario is one `*.e2e.md` file: YAML frontmatter, then a Markdown body that is the instruction
given to the agent.

### Frontmatter

| field | | |
| --- | --- | --- |
| `version` | **required** | `1`. |
| `id` | **required** | Unique across the selection; duplicates are rejected. |
| `tags` | optional | `string[]`, matched by `--tag`. |
| `fixture` | **optional** | A **name** registered in `fixtures`. Never a module path. |
| `timeout` | optional | `90s` or `90 seconds` or a number of milliseconds. |
| `maxActions` | optional | The indicative threshold for this scenario. |
| `inputs` | **optional** | `Record<string, string \| number \| boolean>`, declared here or in the config. |
| `verification` | see below | The expectations, as text. |
| `checks` | optional | `Record<criterionId, checkName>` — binds `c3` to a TS check. |

Unknown fields are rejected, duplicate YAML keys are rejected, and every error names the file, the
field and the line. The YAML is parsed in strict data mode: core schema 1.2, no executable tags, no
merge keys, bounded aliases, a size cap.

### The two ways to express expectations

Either a `verification` frontmatter field **or** a `## Résultats attendus` (also accepted:
`## Expected results`) Markdown section — **never both**, which is a hard error naming both lines.

```yaml
verification: |
  - Le projet {{ projectName }} apparaît dans la liste après sa création.
  - Le projet {{ projectName }} est toujours présent après un rechargement complet.
```

```markdown
## Résultats attendus

- La page d'accueil s'affiche sans erreur.
```

Splitting rule: a top-level Markdown list gives **one criterion per item** (`c1`, `c2`, … in source
order); no list means the whole block is one criterion.

### Interpolation

Data substitution only — there is no expression engine. Available: `{{ run.id }}`,
`{{ attempt.id }}`, every declared input key, and `{{ fixture.<key> }}` for the public values a
fixture returned. Resolution order is: inputs (reserved variables only) → fixture setup → body and
criteria (resolved inputs **and** fixture public values). Inputs may not reference fixture values or
each other. An unknown variable is an error naming file, field and line.

### `inputs` and `fixture` are genuinely optional

`examples/scenarios/project-create-no-fixture.e2e.md` declares neither: the harness opens a clean
browser context at `baseUrl` and the scenario signs in through the UI. The standard journey uses
textual expectations with no TypeScript profile at all — a TS check is the advanced extension, not
the norm.

---

## What ends up on disk

```
runs/<run-id>/
  manifest.json    resolved non-sensitive config, dependency versions, model identity, hashes, adapter id
  spec.e2e.md      verbatim copy of the source spec
  contract.json    the frozen, interpolated criteria with their ids, hashes and positions
  events.jsonl     append-only journal, one JSON object per line, seq +1 per run
  result.json      the verdicts: per criterion and aggregated
  report.html      standalone, offline, no network
  junit.xml        for CI
  artifacts.json   inventory: every expected artifact with state present|missing|failed + reason
  attempts/a1/
    trace.zip          Playwright trace
    screenshots/       art_*.png
    observations/      art_*.txt — the aria snapshots the model actually saw
    console.jsonl      browser console
    network.jsonl      requests and responses
    video.webm         only with capture.video: "on"
    evidence/          art_*.json — payloads a TS check journalled through recordEvidence
```

Each file answers a different question. `manifest.json` is **the sole source of "which adapter
ran"** — a scripted run can never be re-presented as a model validation. `contract.json` is what the
agent was held to and can never modify. `events.jsonl` is the ordered truth about what happened, and
it is written *before* the live fan-out, so the dashboard can never show something the journal does
not have. `result.json` is the verdict, including every downgrade the harness imposed on the
evaluator's answer. `artifacts.json` records capture *failures* too, so a missing screenshot is
visible rather than silently absent.

`manifest.json` is written twice and carries a `stage`: `initial` before the fixture and the freeze
(so a run that dies in infrastructure setup is still attributable and still gets a JUnit file), then
`final` with the contract hashes once the freeze succeeded. `contract.json` is therefore optional,
and its absence *is* the information.

Open the trace in the Playwright Trace Viewer:

```sh
npx playwright show-trace runs/<run-id>/attempts/a1/trace.zip
```

Note what the trace does **not** contain: the harness's own assertions. Playwright records the
browser actions; the verdicts, the budget decisions and the evidence integrity rules live in
`events.jsonl` and `result.json`.

---

## The real-model smoke test

Everything above uses the deterministic scripted adapter. The real adapter is
`provider: "anthropic"`, on `@effect/ai-anthropic`, reading `ANTHROPIC_API_KEY` as a redacted config
value that never reaches a prompt, the manifest or a report.

```sh
node examples/fixture-app/dist/main.js --port 3000 --variant alt-layout --seed &
export FIXTURE_APP_SEED_TOKEN=<token> ANTHROPIC_API_KEY=<key>

node apps/cli/dist/bin/harness.js run examples/scenarios/project-create.e2e.md \
     --config examples/support/harness.config.ts \
     --provider anthropic --model <model id>
```

**This has NOT been run in this repository. No Anthropic API call has been made, because no API key
is configured here.** Every result quoted in this README comes from the scripted adapter, which
exercises the real prompt construction, tool dispatch, policy, budgets and real Playwright against
the demo app — it tests *the harness*. It is not evidence that a model can navigate. `alt-layout` is
the variant worth pointing a real model at: functionally identical to `healthy`, differently shaped,
so a walkthrough memorised from `healthy` does not transfer.

---

## Repository layout

| path | |
| --- | --- |
| [`packages/core`](packages/core/README.md) | Schemas, spec loader, interpolation, config, registries, policy and budgets, events, `RunStore`, the runner. Depends on no React, no Playwright, no model SDK. |
| [`packages/browser-playwright`](packages/browser-playwright/README.md) | The `BrowserDriver` implementation: aria observations, actions, evidence capture. |
| [`packages/agent-runtime`](packages/agent-runtime/README.md) | The model seam: the Anthropic adapter, the scripted double, the agent prompt and the `Verifier`. |
| [`packages/reporting`](packages/reporting/README.md) | JSON, JUnit and standalone HTML reporters. |
| [`apps/cli`](apps/cli/README.md) | Commands, layer assembly, the SSE server, the console reporter, exit codes, packaging. |
| [`apps/ui`](apps/ui/README.md) | The React live dashboard, built to static assets the CLI serves. |
| [`examples/fixture-app`](examples/fixture-app/README.md) | The demo app and its four variants. |
| [`examples/scenarios`](examples/scenarios/README.md) | The demo specs, including four deliberately invalid ones. |
| [`examples/support`](examples/support/README.md) | The project side of the demo: config, fixture, TS check, scripted walkthroughs. |

Further reading: [`docs/architecture.md`](docs/architecture.md) for the seams, the decisions and the
limitations · [`docs/internal/design-contracts.md`](docs/internal/design-contracts.md) for the
authoritative names and shapes · [`docs/internal/api-*.md`](docs/internal) for verified API
cheat-sheets of the exact dependency versions installed.
