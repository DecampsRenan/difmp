# difmp

> [!WARNING]
> **difmp is under active development, is not stable, and will change in breaking ways without
> notice.** Published on npm as `@stylishedcoyote/difmp`, but expect breaking changes between versions. The shape of
> `difmp.config.ts` and the layout of a `runs/<run-id>/` directory are both still moving, so a config
> and a run archive written today may not be readable by a later build. The verification behaviour —
> when a criterion is judged, and when difmp downgrades a verdict to `inconclusive` — is still being
> tuned, so verdicts can shift between versions on unchanged scenarios. Pin the version you tested and
> re-read this file before you upgrade.

**difmp** runs end-to-end scenarios that are written as prose instead of as selectors. You describe
a journey and what you expect at the end, in Markdown with a YAML header; a model drives the browser
and **difmp owns the tools, the budgets, the verification and the evidence**. Every run leaves a
directory you can read afterwards: a journal, the frozen expectations, screenshots, accessibility
snapshots, a Playwright trace, a JUnit file and a standalone HTML report.

It is for teams whose UI changes faster than their selectors, on journeys that are worth testing but
not worth re-writing every sprint. It is _not_ a replacement for deterministic assertions — see
[Honest limitations](#honest-limitations) before you adopt it.

A whole scenario:

```markdown
---
version: 1
id: project-create
inputs: { projectName: "Project {{ run.id }}" }
verification: |
  - The project {{ projectName }} appears in the project list after it is created.
  - The project {{ projectName }} is still present in the project list after a full page reload.
---

From the home page, create a project named {{ projectName }}, then reload the page.
```

What a run looks like:

```
PASS  project-create  3.3s  ../scenarios/project-create.e2e.md
      actions 8/25 suggested · model calls 14 · tokens 2240
      criteria: 3 · run r_zbh6pn2jmlag2 · report …/runs/r_zbh6pn2jmlag2/report.html

Summary  1 scenario  3.3s
         1 passed · 0 failed · 0 inconclusive · 0 error · 0 cancelled
```

---

## Contents

1. [Quick start — add difmp to your project](#quick-start--add-difmp-to-your-project)
2. [Writing scenarios](#writing-scenarios)
3. [Choosing a provider](#choosing-a-provider)
4. [Reading the results](#reading-the-results)
5. [Fixtures and TS checks](#fixtures-and-ts-checks)
6. [CLI reference](#cli-reference)
7. [Working on difmp itself](#working-on-difmp-itself)
8. [Honest limitations](#honest-limitations)

---

## Quick start — add difmp to your project

Nothing is cloned and no orchestration script is written. The package ships a compiled ESM
executable, its TypeScript declarations and the report/dashboard assets; it only ever _reads_ your
project's configuration.

### 0. Prerequisites

|         |                                                                               |
| ------- | ----------------------------------------------------------------------------- |
| Node.js | `>= 22.12.0`. Verified here on **v24.19.0**.                                  |
| Browser | Playwright **1.63.0** Chromium. Nothing else is launched.                     |
| OS      | Linux/macOS.                                                                  |
| API key | Only if you use the `anthropic` provider. The `scripted` provider needs none. |

### 1. Install it

```sh
npm  i -D @stylishedcoyote/difmp
pnpm add -D --allow-build=esbuild @stylishedcoyote/difmp
yarn add -D @stylishedcoyote/difmp
```

> **Want to test a build that is not published yet?** Install from a local tarball instead — see
> [Working on difmp itself](#working-on-difmp-itself) and [Verifying the distributed
> package](#verifying-the-distributed-package).

Two install-time notes, both about the same transitive dependency:

- **pnpm:** difmp pulls `esbuild` in through `tsx`, and pnpm does not run its build script by
  default. pnpm 10 prints `Ignored build scripts: esbuild@0.28.2` and **exits 0**; pnpm ≥ 12 turns
  that into `ERR_PNPM_IGNORED_BUILDS` and **exits 1**. `--allow-build=esbuild` (or `pnpm
approve-builds` afterwards) is the fix and is harmless on pnpm 10. The installed tree is complete
  either way — including the `tsx` fallback a CommonJS-typed config needs.
- **npm:** npm 11 prints `npm warn allow-scripts … esbuild@0.28.2` and exits 0. Nothing to do.

### 2. Install Chromium

```sh
npx --no-install playwright install chromium
```

Silent, exit 0. On a bare Linux box that has never run a browser, add `--with-deps` — it installs
`libnss3`, `libnspr4`, `libasound2` and friends through apt, so it needs root. `playwright` comes
from difmp's own dependencies and the browsers land in the shared `~/.cache/ms-playwright`.

### 3. Add the scripts

```jsonc
// package.json
{
  "type": "module",
  "scripts": {
    "test:e2e": "difmp run",
    "test:e2e:ui": "difmp run --ui",
  },
}
```

`"type": "module"` is worth setting even if nothing else in your project needs it. Without it, an ESM
`difmp.config.ts` sits in a package with no declared module type, and Node prints this on stderr on
**every** invocation:

```
(node:12345) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///…/difmp.config.ts is not
specified and it doesn't parse as CommonJS. Reparsing as ES module because module syntax was
detected. This incurs a performance overhead.
```

Nothing is broken — it is a performance warning, the config loads and the run proceeds normally. A
genuinely CommonJS project has two ways out: ignore the noise, or name the file `difmp.config.mts`,
whose extension declares the module type on its own. Both are verified.

### 4. Write `difmp.config.ts`

At the root of your project, beside `package.json`:

```ts
import { defineConfig } from "@stylishedcoyote/difmp";

export default defineConfig({
  baseUrl: process.env.APP_URL ?? "http://127.0.0.1:3000",
  include: ["tests/e2e/**/*.e2e.md"],
  provider: "scripted",
});
```

That is the whole minimum. Every other key has a default (`maxActions: 25`, `outputDir: "runs"`,
`reporters: ["console"]`, trace on, video off, screenshots at checkpoints). `defineConfig` is
identity plus types; the real validation happens at load time and **rejects unknown top-level keys**.
A project with no config file at all runs on the built-in defaults.

`.ts`, `.mts`, `.mjs` and `.js` are all accepted. The file is loaded as **trusted project code**, and
only from `--config` or an upward lookup from the working directory — never from a name inside a
scenario.

### 5. Write your first scenario

```sh
mkdir -p tests/e2e
```

```markdown
<!-- tests/e2e/home.e2e.md -->

---

version: 1
id: home
verification: |

- The home page renders without an error.

---

Open the home page and look at what is displayed.
```

Check it before you spend a browser on it — `validate` starts neither a model nor a browser:

```sh
npx --no-install difmp validate
```

```
OK    home  1 criteria  tests/e2e/home.e2e.md

1/1 scenario valid
```

`npx --no-install` is deliberate: it refuses to go and fetch an unverified package of the same name
from the public registry. `pnpm exec difmp …` and `yarn difmp …` are the equivalents.

### 6. Run it

Start your application on `baseUrl` first. It has to stay up for the whole run, and a dev server
holds the terminal, so start it in a second terminal or in the background. Then:

```sh
npm run test:e2e
```

difmp opens with a `Resolved configuration` block — about twenty lines echoing `baseUrl`, `provider`,
the budgets, the capture settings, `outputDir` and the scenarios it selected. That block is expected;
the result follows it:

```
INCO  home  994ms  tests/e2e/home.e2e.md
      actions 2/25 suggested · model calls 5 · tokens 800
      c1 inconclusive: The home page renders without an error.
         observed: (scripted test double)
         limitation: scripted test double — this is not a model judgement
      reason: insufficient-evidence — unresolved: c1 (inconclusive)
      criteria: 1 · run r_ovf7cxv5hmbx2 · report …/runs/r_ovf7cxv5hmbx2/report.html

Summary  1 scenario  994ms
         0 passed · 0 failed · 1 inconclusive · 0 error · 0 cancelled
```

Exit code `1`. **That is the correct answer, not a failure to set something up.** `provider:
"scripted"` with no registered walkthrough is a deterministic test double that asserts nothing, and
difmp never promotes "nothing was checked" to `passed`. You have a working installation the moment
you see this.

A run directory now exists under `runs/`:

```
runs/r_ovf7cxv5hmbx2/
  manifest.json  contract.json  spec.e2e.md  events.jsonl
  result.json    report.html    junit.xml    artifacts.json
  attempts/a1/{trace.zip, screenshots/, observations/, console.jsonl, network.jsonl}
```

Open `report.html` in any browser. It is standalone and offline, so the file path is all you need.

### 7. Make it assert something

Two ways, and you have to pick one:

|                                               | what it gives you                                           | what it costs                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `provider: "anthropic"` + `ANTHROPIC_API_KEY` | a model actually reads the evidence and judges the criteria | an API key, per-run token cost, and verdicts that are probabilistic                                      |
| `provider: "scripted"` + `providerOptions`    | fully deterministic, offline, free                          | you describe the walkthrough yourself; it proves your app is reachable, not that a model can navigate it |

For the model path — `--model` takes a provider model id, the one used throughout this README being
`claude-sonnet-5`:

```sh
export ANTHROPIC_API_KEY=<key>
npx --no-install difmp run --provider anthropic --model claude-sonnet-5
```

For the deterministic path, steer the built-in walkthrough from `providerOptions`. No extra file, and
it is the whole change:

```ts
export default defineConfig({
  provider: "scripted",
  providerOptions: { verdict: "passed" },
});
```

```
PASS  home  1.0s  tests/e2e/home.e2e.md
      actions 2/25 suggested · model calls 5 · tokens 800
      criteria: 1 · run r_7rw7hexufsjs2 · report …/runs/r_7rw7hexufsjs2/report.html

Summary  1 scenario  1.0s
         1 passed · 0 failed · 0 inconclusive · 0 error · 0 cancelled
```

Exit code `0`. The built-in walkthrough is observe → fill → submit → observe → screenshot → ask for
every criterion → finish. `fills`, `submit` and `scenario` shape what it does; `verdict` is what the
double answers with, and it defaults to `"inconclusive"` because evidence is never assumed — which is
exactly why step 7 came back `INCO`. The installed package's own README,
`node_modules/@stylishedcoyote/difmp/README.md`, lists every option.

For complete control, the installed package also exposes the `scripts: { … }` registry authoring
API at `@stylishedcoyote/difmp/scripted`. Its factory types, step builders, and a complete example under
`node_modules/@stylishedcoyote/difmp/examples/custom-scripted/` are all part of the tarball; no private workspace
package or repository checkout is required.

See [Choosing a provider](#choosing-a-provider). Next, add expectations worth judging: read
[Writing scenarios](#writing-scenarios).

---

## Writing scenarios

A scenario is one `*.e2e.md` file: YAML frontmatter, then a Markdown body that is the instruction
given to the agent. Discovery is `**/*.e2e.md` under `include`.

### Frontmatter

| field          |              |                                                                                |
| -------------- | ------------ | ------------------------------------------------------------------------------ |
| `version`      | **required** | `1`.                                                                           |
| `id`           | **required** | Unique across the selection; duplicates are rejected.                          |
| `tags`         | optional     | `string[]`, matched by `--tag`.                                                |
| `fixture`      | **optional** | A **name** registered in `fixtures`. Never a module path.                      |
| `timeout`      | optional     | `90s`, or `90 seconds`, or a number of milliseconds.                           |
| `maxActions`   | optional     | The indicative threshold for this scenario.                                    |
| `inputs`       | **optional** | `Record<string, string \| number \| boolean>`, declared here or in the config. |
| `checks`       | optional     | `Record<criterionId, checkName>` — binds `c3` to a TS check.                   |
| `verification` | see below    | The expectations, as text.                                                     |

Unknown fields are rejected, duplicate YAML keys are rejected, and every error names the file, the
field and the line. The YAML is parsed in strict data mode: core schema 1.2, no executable tags, no
merge keys, bounded aliases, a size cap.

### The two ways to express expectations

Either a `verification` frontmatter field **or** a `## Expected results` Markdown section —
**never both**, which is a hard error naming both lines.

```yaml
verification: |
  - The project {{ projectName }} appears in the project list after it is created.
  - The project {{ projectName }} is still present after a full page reload.
```

```markdown
## Expected results

- The home page renders without an error.
```

Splitting rule: a top-level Markdown list gives **one criterion per item** (`c1`, `c2`, … in source
order); no list means the whole block is one criterion. Criterion ids are positional, which matters
if you bind one to a TS check — reordering the list rebinds it.

### Interpolation

Data substitution only; there is no expression engine.

| variable              |                                                          |
| --------------------- | -------------------------------------------------------- |
| `{{ run.id }}`        | the run id — the usual way to make a name unique per run |
| `{{ attempt.id }}`    | the attempt id                                           |
| `{{ <inputKey> }}`    | any declared input                                       |
| `{{ fixture.<key> }}` | a public value the fixture returned                      |

Resolution order: inputs (reserved variables only) → fixture setup → body and criteria (resolved
inputs **and** fixture public values). Inputs may not reference fixture values or each other. An
unknown variable is an error naming file, field and line.

### `inputs` and `fixture` are genuinely optional

Neither is required. `examples/scenarios/project-create-no-fixture.e2e.md` declares neither: difmp
opens a clean browser context at `baseUrl` and the scenario signs in through the UI like a person
would. The standard journey uses textual expectations with no TypeScript at all — a TS check is the
advanced extension, not the norm.

> This repository is written in English throughout — scenarios included. Nothing in difmp requires
> that: the criteria are text handed to a model, so write scenarios in the language your product
> speaks. Only difmp's own labels are fixed.

---

## Choosing a provider

|                         | `scripted`                                | `anthropic`                                               |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------- |
| what it is              | a deterministic, network-free test double | the real adapter, on `@effect/ai-anthropic`               |
| needs a key             | no                                        | `ANTHROPIC_API_KEY`                                       |
| network                 | none                                      | yes                                                       |
| what a green run proves | that _difmp_ behaves as specified         | that _a model_ navigated your app and judged the evidence |
| verdict label           | `evaluator.kind: "scripted-model"`        | `evaluator.kind: "model"`                                 |

Pick `scripted` for difmp's own tests, for CI smoke lanes that must not cost money, and for pinning
a known journey. Pick `anthropic` for the thing difmp is actually for.

```ts
export default defineConfig({
  provider: "anthropic",
  model: "claude-sonnet-5",
  providerOptions: { maxTokens: 2048 },
});
```

`model` is never defaulted in code — set it in the config or pass `--model`. The API key is read as a
redacted configuration value that never reaches a prompt, `manifest.json` or a report. It is read
from the environment only; there is nowhere to write it into a config file.

Claude Sonnet 5 requires the sampling controls `temperature`, `topP` and `topK` to be omitted. difmp
rejects those options locally for `claude-sonnet-5` (including dated ids) before it opens a browser
or sends a model request. They remain available for model ids whose Anthropic API supports them.

**A `scripted` run with no registered script asserts nothing and correctly comes back
`inconclusive`** (exit `1`). The built-in double answers with canned, explicitly-labelled verdicts
and difmp refuses to call that evidence. The lightest way to make a `scripted` run mean something is
`providerOptions` — `verdict`, plus `fills`/`submit`/`scenario` to shape the built-in walkthrough —
which works from a plain tarball install. For full control, register a walkthrough by name. The
factory and all step builders are available from the installed package's public
`@stylishedcoyote/difmp/scripted` entry point:

```ts
import {
  observe,
  screenshot,
  type ScriptFactory,
  type ScriptedProviderScript,
} from "@stylishedcoyote/difmp/scripted";

const myScriptFactory: ScriptFactory<ScriptedProviderScript> = (ctx) => ({
  agent: {
    id: "healthy",
    description: "observe and capture the page",
    steps: [{ calls: [observe()] }, { calls: [screenshot(`final-${ctx.runId}`)] }],
  },
});

export default defineConfig({
  provider: "scripted",
  scripts: { healthy: myScriptFactory },
  providerOptions: { script: "healthy" },
});
```

An entry is a **factory**, not a finished script: it is called once the run id is minted and the
inputs are resolved, before the browser opens, so a deterministic script can type the value the run
will really use. The tarball ships a complete, typechecked example at `examples/custom-scripted/`;
[`apps/cli/README.md`](apps/cli/README.md) documents the factory context and the built-in generic
walkthrough.

### The real-model smoke test

```sh
node examples/fixture-app/dist/main.js --port 3000 --variant alt-layout \
     --seed --seed-email demo@example.test --seed-password demo-password &
export FIXTURE_APP_SEED_TOKEN=<the token it printed> ANTHROPIC_API_KEY=<key> DIFMP_PROVIDER=anthropic

node apps/cli/dist/bin/difmp.js run examples/scenarios/project-create.e2e.md \
     --config examples/support/difmp.config.ts \
     --provider anthropic --model <model id>
```

Set `DIFMP_PROVIDER=anthropic` for this repository example as well; its shared support config uses
that variable to select Anthropic options instead of the scripted walkthrough registry.

**The full browser command above has NOT been run in this repository.** Every browser result quoted
in this README comes from the scripted adapter, which
exercises the real prompt construction, tool dispatch, policy, budgets and real Playwright against
the demo app — it tests _difmp_. It is not evidence that a model can navigate. `alt-layout` is the
variant worth pointing a real model at: functionally identical to `healthy`, differently shaped, so a
walkthrough memorised from `healthy` does not transfer.

CI has a smaller provider-contract smoke: three tests check an accepted request plus tool use, a
native structured verdict, and cancellation after the HTTP transport starts. They run on the weekly
schedule, or on a manual dispatch with `real_model: true`, using `ANTHROPIC_API_KEY` from repository
secrets. Pushes, pull requests and ordinary local `pnpm test` runs never make a paid call.

---

## Reading the results

### Statuses

A run ends in exactly one of five:

| status         | console | meaning                                                                                                                                                                                |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`       | `PASS`  | every criterion was evaluated and held                                                                                                                                                 |
| `failed`       | `FAIL`  | a criterion was evaluated and contradicted — a product problem                                                                                                                         |
| `inconclusive` | `INCO`  | difmp refused to conclude: insufficient evidence, an unevaluated criterion, a verdict citing an artifact that does not exist, or a blocking budget exhausted before the answer existed |
| `error`        | `ERR `  | a technical failure — fixture setup, a store write, an invalid tool result                                                                                                             |
| `cancelled`    | `CANC`  | Ctrl-C, or the dashboard's cancel button                                                                                                                                               |

Criteria carry the same vocabulary plus `pending` (never reached — it survives a cancellation rather
than being invented into a verdict).

**`inconclusive` is the load-bearing one.** It is what difmp says instead of guessing, and it is why
the tool is worth trusting: a green run means something was checked.

### Exit codes

| code  | meaning                                                                                |
| ----- | -------------------------------------------------------------------------------------- |
| `0`   | every selected scenario passed                                                         |
| `1`   | any scenario `failed` or `inconclusive`                                                |
| `2`   | invalid configuration, unusable arguments, no scenario selected, or an execution error |
| `130` | user interrupt — Ctrl-C, or the dashboard's cancel command                             |

`130` is produced **after** the finalizers have run: the browser context is closed, the trace is
settled, the fixture cleanups have executed and `result.json` exists. An indeterminate result is
never turned into a green `skipped` in JUnit — product criterion failures become `<failure>`;
technical errors, indeterminate results and cancellations become `<error>`, with the real status
preserved in the message.

### What lands on disk

Run directories go to `outputDir` (default `runs`), **resolved against the directory holding
`difmp.config.ts`** — so the location does not depend on where you invoked the CLI from.

```
runs/<run-id>/
  manifest.json    resolved non-sensitive config, dependency versions, model identity, hashes, adapter id
  spec.e2e.md      verbatim copy of the source scenario
  contract.json    the frozen, interpolated criteria with their ids, hashes and positions
  events.jsonl     append-only journal, one JSON object per line, seq +1 per run
  result.json      the verdicts: per criterion and aggregated
  report.html      standalone, offline, no network
  junit.xml        for CI
  artifacts.json   inventory: every expected artifact with state present|missing|failed + reason
  attempts/a1/
    trace.zip          Playwright trace
    screenshots/       art_*.png
    observations/      art_*.txt — the accessibility snapshots the model actually saw
    console.jsonl      browser console
    network.jsonl      requests and responses
    video.webm         only with capture.video: "on"
    evidence/          art_*.json — payloads a TS check journalled through recordEvidence
```

Each file answers a different question. `manifest.json` is **the sole source of "which adapter
ran"**, so a scripted run can never be re-presented as a model validation. `contract.json` is what
the agent was held to and can never modify. `events.jsonl` is the ordered truth, written _before_
the live fan-out, so the dashboard can never show something the journal does not have.
`result.json` is the verdict, including every downgrade difmp imposed on the evaluator's answer.
`artifacts.json` records capture _failures_ too, so a missing screenshot is visible rather than
silently absent.

For `method: "model"`, every present screenshot is also sent to the dedicated evaluator as PNG
bytes in a native multimodal prompt part, explicitly paired with its `artifactId`. A screenshot
whose pixels are unavailable to the provider is removed from the evaluator's citable evidence set;
its label alone can never support a visual claim. The binary payload stays out of prompts rendered
as text, the journal and `artifacts.json` (the PNG on disk remains the reviewable source artifact).

`manifest.json` is written twice and carries a `stage`: `initial` before the fixture and the freeze
(so a run that dies in infrastructure setup is still attributable and still gets a JUnit file), then
`final` with the contract hashes once the freeze succeeded. `contract.json` is therefore optional,
and its absence _is_ the information.

`result.json`, `junit.xml` and `report.html` are written whichever reporters you selected — that is
the layout `difmp report` replays from. **Ctrl-C is not an exception:** the three files are written
from a region that survives the interrupt, so an interrupted run still reaches CI with a JUnit file
and a report, exactly like a cancellation from the dashboard. What Ctrl-C does cost is the console
block for the scenario it interrupted — the interrupt is re-raised as soon as those files are on
disk, so the process exits `130` before the console reporter prints anything for that run. Read the
status from `result.json`, or re-render from the directory with `difmp report <dir>`.

### The HTML report

`report.html` is a single self-contained file with no remote asset reference. Per criterion it shows
the expectation, what was observed, the `method` (`model` or `code`), the evaluator, and the
`art_*` ids it relies on. A complete, unedited run directory for a failing case is committed at
[`docs/example-run/`](docs/example-run/README.md).

```sh
xdg-open runs/<run-id>/report.html      # or: open … on macOS
```

`xdg-open` is part of `xdg-utils` and is **not installed on a bare Linux box** — `command -v
xdg-open` comes back empty on this machine. Without it, point a browser at the absolute path, or
copy the single file to a machine that has one. There is nothing to serve.

### The Playwright trace

```sh
npx --no-install playwright show-trace runs/<run-id>/attempts/a1/trace.zip
```

Note what the trace does **not** contain: difmp's own assertions. Playwright records the browser
actions; the verdicts, the budget decisions and the evidence integrity rules live in `events.jsonl`
and `result.json`.

### The live dashboard

```sh
npx --no-install difmp run --ui --ui-port 45123
```

```
Live dashboard  http://127.0.0.1:45123/
```

It streams the full suite over SSE, retains completed scenario timelines while later scenarios run,
and shows the criteria with their text and method from the moment each contract is frozen. Its
Cancel button cancels the suite cleanly (CLI exit `130`). On an interactive terminal the completed
dashboard stays available until you press **Close dashboard** or Ctrl-C; under non-TTY/CI it exits
without waiting and the generated standalone `report.html` is the durable view. Loopback only
unless you pass `--ui-host`, which says loudly that it is no longer loopback. `--ui` is an option of
the runner: a CI run starts no server at all. `--ui-port` defaults to `0`, an ephemeral port.

### The JSON reporter owns stdout

With `json` among the reporters, **stdout carries exactly one JSON document and every
human-readable diagnostic moves to stderr.** To read the console output of a config that enables
both, send stdout away:

```sh
node apps/cli/dist/bin/difmp.js run --config examples/support/difmp.config.ts > /dev/null
```

---

## Fixtures and TS checks

Both are optional. Skip this section entirely unless you need one.

A **fixture** puts the application into a known state before the browser opens — a seeded tenant, an
authenticated session — so the scenario tests the business journey rather than the login. A **TS
check** takes over the verdict for one criterion, in TypeScript, when an expectation must be exact
rather than judged from evidence.

Both are registered **by name** in the config. A scenario references the name; it can never name a
module path.

```ts
export default defineConfig({
  fixtures: { "authenticated-workspace": authenticatedWorkspace },
  checks: { "project-unique-in-storage": projectUniqueInStorage },
});
```

```yaml
# in the scenario
fixture: authenticated-workspace
checks:
  c3: project-unique-in-storage
```

### The worked example

`examples/support/` is the project side a real consumer would write, and its two files are the
reference:

**[`fixtures/authenticated-workspace.ts`](examples/support/fixtures/authenticated-workspace.ts)**
creates a per-attempt workspace, user and session through the demo app's guarded seed API, then
returns:

- `public` — the workspace name, exposed as `{{ fixture.workspaceName }}` and visible to the model;
- `storageState` — the session cookie, **private**, handed to the browser context only, never to a
  prompt.

It reads the seed token through `ctx.secrets("FIXTURE_APP_SEED_TOKEN")` rather than from an input.
That is the whole point of `ctx.secrets`: difmp learns the value and strips it from the journal, the
prompts, the events and the report. A secret your fixture obtains some other way cannot be redacted,
because difmp was never told about it.

Cleanups are registered at _acquisition_ time and run after success, failure **and** cancellation,
bounded by `budgets.fixtureCleanupTimeoutMs`.

**[`checks/project-unique-in-storage.ts`](examples/support/checks/project-unique-in-storage.ts)**
answers something the rendered list cannot: how many projects with this name were actually
_persisted_. It calls a reserved probe endpoint that is deliberately absent from the agent's toolset.
Its verdict is authoritative for the criterion it is bound to and is reported with `method: "code"`.

It also guards its own binding: criterion ids are positional, so the check verifies that the text it
was handed hashes to the value frozen in the contract and that the sentence really is the uniqueness
statement it was written for. Reordering the expectations then fails loudly instead of silently
rebinding. Copy that pattern.

Compare `project-create.e2e.md` (textual only) with `project-create-checked.e2e.md` (same journey,
`c3` bound to the check) to see exactly what the extension buys.

---

## CLI reference

```text
difmp [file-or-dir-or-glob...]          alias of `difmp run`
difmp run [file-or-dir-or-glob...]
difmp list [--tag smoke] [--json]
difmp validate [file-or-dir-or-glob...] [--json]
difmp report <run-directory>
difmp --help
difmp --version
```

`list` and `validate` start neither a model nor a browser. `validate` checks frontmatter, input
declarations and precedence, every `{{ … }}` reference and the fixture/check names against the
project registries; it **accepts** unresolved `{{ fixture.* }}`, because no setup has run. `report`
rebuilds `report.html`, `result.json` and `junit.xml` from the persisted run directory alone — no
model call, no browser, no replay, no config re-resolution.

Because the bare `difmp` is an alias of `difmp run`, a file literally named `run`, `list`,
`validate` or `report` in first position is read as the subcommand. Write `difmp ./run`.

### `difmp run` options

| option                               | meaning                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `--config, -c <path>`                | Path to `difmp.config.ts`. Default: the nearest one at or above the working directory. |
| `--tag <name>`                       | Repeatable. A scenario is selected if it carries **any** of the given tags.            |
| `--input, -i <key=value>`            | Repeatable scenario input. **Always a string.**                                        |
| `--inputs-file <file.json>`          | Scenario inputs with JSON types preserved (string / number / boolean).                 |
| `--reporter, -r <name>`              | Repeatable: `console`, `json`, `junit`. Default: `console`.                            |
| `--output, -o <dir>`                 | Where run directories are written. Default: `runs`.                                    |
| `--provider <scripted\|anthropic>`   | Model provider.                                                                        |
| `--model <id>`                       | Provider-specific model id. Never defaulted in code.                                   |
| `--base-url <url>`                   | The application under test.                                                            |
| `--max-actions <n>`                  | The **indicative** action threshold. Crossing it warns once and changes no verdict.    |
| `--ui`                               | Serve the live dashboard while the run progresses.                                     |
| `--ui-port <n>` / `--ui-host <host>` | Default `0` (ephemeral) and `127.0.0.1`.                                               |
| `--headed`                           | Run Chromium with a visible window.                                                    |

`--reporter` chooses what reaches your **terminal**, and accepts only those three names —
`--reporter html` is rejected with `unknown reporter (available: console, json, junit)`. The config
file's `reporters` array additionally accepts `"html"`, which announces the report path in the
console output. The files themselves are written either way.

### Precedence — two separate ladders

**Scenario data (inputs), lowest to highest:**

```
config.inputs  <  spec frontmatter `inputs`  <  --inputs-file  <  --input
```

A key that neither the config nor the spec **declares** is rejected, whichever side supplies it:

```sh
$ node apps/cli/dist/bin/difmp.js run examples/scenarios/project-create.e2e.md \
      -c examples/support/difmp.config.ts --input nope=1
ERROR
  ../scenarios/project-create.e2e.md: …/examples/support/difmp.config.ts: invalid configuration
  - --input declares "nope", which is not an input of the config or the spec
# exit 2
```

`--input k=v` always yields a string; `--inputs-file` keeps JSON types.

**Execution options, lowest to highest:**

```
built-in defaults  <  difmp.config.ts  <  CLI flags
```

Only flags you actually pass become overrides; an absent flag leaves the file's value alone. The
resolved, non-sensitive configuration is printed before launch, with every value parked under a
credential-looking key replaced by `[redacted]`.

### Scenario discovery

`**/*.e2e.md`, honouring `include`/`exclude`, always excluding `node_modules`, `dist` and `runs`.
`include`/`exclude` resolve against the **config's** directory; path arguments resolve against the
**invocation** directory and replace `include` for that invocation. The result is stably sorted, so
two identical invocations run the same scenarios in the same order.

Quote your globs — difmp does the matching, not the shell:

```sh
difmp run 'tests/e2e/**/*.e2e.md'    # bash only recurses on ** with `shopt -s globstar`
difmp run tests/e2e                  # a directory means tests/e2e/**/*.e2e.md
difmp run tests/e2e/login.e2e.md     # a literal path; naming one file bypasses `exclude`
```

Naming one file explicitly is an unambiguous instruction, so it bypasses `exclude` — that is what
lets a deliberately invalid spec reach the loader and be rejected. A glob or a directory is still
filtered, or `difmp run .` would walk `node_modules`.

**Selecting nothing is an explicit error, never a silent success:**

```sh
$ node apps/cli/dist/bin/difmp.js list --config examples/support/difmp.config.ts --tag nonexistent
ERROR
  no *.e2e.md scenario selected — include ["../scenarios/**/*.e2e.md"] under …/examples/support filtered by --tag nonexistent (3 discovered, none matched the tag filter)
# exit 2
```

### Config discovery

difmp looks for `difmp.config.{ts,mts,mjs,js}` — the path given by `--config`, otherwise the nearest
one at or above the working directory. `.ts` wins within a directory. With no config file anywhere,
the built-in defaults apply, which is enough for a text-only scenario.

> **Renamed from `harness`.** The package, the binary, the workspace scopes (`@difmp/*`) and the
> config filename were all called _harness_ until this repository was renamed. The rename is total:
> **a project that still has `harness.config.ts` must rename the file** — that basename is no longer
> discovered, and difmp will silently fall back to its defaults rather than read it. The demo's
> environment variables are `DIFMP_*`. Persisted run directories are untouched: `manifest.json`
> still carries `harnessVersion` and `junit.xml` still names its suite `harness`, so `difmp report`
> replays runs archived before the rename.

---

## Working on difmp itself

Everything below is about the repository, not about using the tool. `difmp` is the executable an
**installed** package puts on your PATH; this repository installs nothing globally and has no
`difmp` bin of its own, so in-repo invocations are written out in full as
`node apps/cli/dist/bin/difmp.js` (after `pnpm build`). If you would rather type `difmp`, alias it
once: `alias difmp="node $PWD/apps/cli/dist/bin/difmp.js"`.

**Everything in this repository is in English** — the spec, the example scenarios, the code, the
comments and this documentation. That is the only language rule.

### From a clean checkout

|         |                                                                                 |
| ------- | ------------------------------------------------------------------------------- |
| pnpm    | `10.29.3`, pinned in the root `packageManager`. Only needed to work _on_ difmp. |
| Node.js | `>= 22.12.0`, declared in every `engines.node`. Verified on **v24.19.0**.       |

```sh
pnpm install --frozen-lockfile
npx playwright install chromium          # add --with-deps on a bare Linux box (needs root)
pnpm build                               # packages/* and apps/* — tsc -b, plus vite build for the UI
pnpm --filter @difmp/fixture-app build   # the demo app; `pnpm build` does NOT cover examples/*
```

**Install a build that is not published yet.** From a clean checkout above, pack a tarball and install
it from your own project, with whatever package manager that project already uses:

```sh
cd apps/cli && pnpm pack --pack-destination /tmp
# -> /tmp/stylishedcoyote-difmp-0.0.1.tgz
```

`pnpm pack` runs `prepack`, which bundles the four private `@difmp/*` workspace packages into the
artifact, so the tarball depends on no unpublished package. In your project:

```sh
npm  i   -D /tmp/stylishedcoyote-difmp-0.0.1.tgz
pnpm add -D --allow-build=esbuild /tmp/stylishedcoyote-difmp-0.0.1.tgz
yarn add -D ./difmp-local.tgz            # Yarn 1: copy the tarball in first
```

> **If you re-pack, give the tarball a fresh name before installing it with Yarn 1.** Yarn 1 caches a
> local tarball by name and version, so `yarn add -D ./stylishedcoyote-difmp-0.0.1.tgz` after a
> rebuild silently reinstalls the previous bytes. `cp stylishedcoyote-difmp-0.0.1.tgz
stylishedcoyote-difmp-$(date +%s).tgz` first. npm, pnpm and
> Yarn 4 via corepack do not need this.

Then:

```sh
pnpm typecheck     # tsc -b tsconfig.build.json — the whole workspace, examples included
pnpm test          # vitest run
```

Observed in that order, Node v24.19.0, pnpm 10.29.3:

```
pnpm install --frozen-lockfile          ->  Lockfile is up to date, resolution step is skipped. exit 0
npx playwright install chromium         ->  exit 0 (silent when the browser is already in the cache)
pnpm build                              ->  exit 0
pnpm --filter @difmp/fixture-app build  ->  exit 0
pnpm typecheck                          ->  exit 0
pnpm test                               ->  Test Files 21 passed (21) · Tests 313 passed (313), exit 0
```

Treat the exit code as the contract, not the test count. A clone and a working copy report the same
figure — `vitest.config.ts` only globs tracked directories, deliberately, so the suite a contributor
runs is the suite CI runs.

> The **first** `pnpm install` in a clone prints two warnings:
> `WARN Failed to create bin at …/examples/support/node_modules/.bin/fixture-app. ENOENT …
examples/fixture-app/dist/main.js`. They are expected and harmless: that bin points at a build
> output that does not exist yet, and they are gone the next time you install, once
> `pnpm --filter @difmp/fixture-app build` has run. Nothing uses that bin — the demo calls
> `node examples/fixture-app/dist/main.js` directly.

`pnpm build` filters `./packages/*` and `./apps/*`; `examples/*` is not in that scope, which is why
the fixture app is built separately. `pnpm typecheck` does cover `examples/*` — it is the project
references build of `tsconfig.build.json`.

> `pnpm pack` in `apps/cli/` runs `prepack` → `build:bundle`: it first rebuilds/copies the UI, then
> runs tsdown (`clean: true`), which **replaces `apps/cli/dist` with the bundled artifact**. The
> bundle runs fine, but it has the
> `@difmp/*` packages baked in, so it will not pick up an edit under `packages/` until you rebuild.
> `pnpm --filter @stylishedcoyote/difmp build` restores the `tsc -b` layout; it deletes `tsconfig.tsbuildinfo` first,
> without which `tsc -b` would consider itself up to date and leave the stale bundle in place.

### Run the demo

The demonstration is a tiny "Projects" app ([`examples/fixture-app`](examples/fixture-app/README.md))
with four reproducible variants, three scenarios
([`examples/scenarios`](examples/scenarios/README.md)) and the project side a real consumer would
write ([`examples/support`](examples/support/README.md)).

**1. Start the app under test.** It binds `127.0.0.1` only and prints the guarded seed token. It
**runs in the foreground and does not return your prompt** — use a second terminal, or append `&`
and keep the job id, because you will need to stop it before restarting it on the same port:

```sh
node examples/fixture-app/dist/main.js --port 3000 --variant healthy \
     --seed --seed-email demo@example.test --seed-password demo-password &
```

```
fixture-app listening on http://127.0.0.1:3000 (variant: healthy)
x-seed-token: 2e5bdae3196082fd9c3309dbc478a72d
seeded login: demo@example.test / demo-password (sid=…, workspace=ws_…)
```

**2. Export the token.** The fixture and the TS check read it from the environment, never from an
input. Because the fixture reads it through `ctx.secrets`, difmp knows its value and strips it from
the journal, the prompts, the events and the report. Traces and videos are outside the redactor's
reach — see [`docs/architecture.md`](docs/architecture.md) §4:

```sh
export FIXTURE_APP_SEED_TOKEN=<the token printed above>
```

**3. Run**, from the repository root, with the built CLI:

```sh
node apps/cli/dist/bin/difmp.js run --config examples/support/difmp.config.ts > /dev/null
```

The demo config enables **all four reporters** (`reporters: ["console", "json", "junit", "html"]`),
so stdout carries the JSON document and everything readable is on stderr — hence the `> /dev/null`.
What you see, after the resolved-configuration block:

```
PASS  project-create-checked  3.5s  ../scenarios/project-create-checked.e2e.md
      actions 8/25 suggested · model calls 13 · tokens 2080
      criteria: 3 · run r_w2o2sch5fj5ka · report …/examples/support/runs/r_w2o2sch5fj5ka/report.html
PASS  project-create-no-fixture  4.5s  ../scenarios/project-create-no-fixture.e2e.md
      actions 14/35 suggested · model calls 20 · tokens 3200
      criteria: 3 · run r_aekqficot3os6 · report …/examples/support/runs/r_aekqficot3os6/report.html
PASS  project-create  3.2s  ../scenarios/project-create.e2e.md
      actions 8/25 suggested · model calls 14 · tokens 2240
      criteria: 3 · run r_5uqiun7h3prtc · report …/examples/support/runs/r_5uqiun7h3prtc/report.html

Summary  3 scenarios  11.1s
         3 passed · 0 failed · 0 inconclusive · 0 error · 0 cancelled
```

Exit code `0`. Run directories land in **`examples/support/runs/<run-id>/`**.

### The four variants

Restart the app with `--variant <name>` **and** export `FIXTURE_APP_VARIANT=<name>` for the difmp
process: the app changes what it does, and the variable tells the deterministic adapter which layout
it is about to meet (`alt-layout` renames every control). Because `--port 0` gives an ephemeral port,
export `DIFMP_BASE_URL` too when you do not pin the port.

**Stop the instance you already have before you start the next one.** Nothing frees port 3000 for
you, and the failure is indirect: the new app dies with `Error: listen EADDRINUSE: address already
in use 127.0.0.1:3000`, so it never prints a token, so the export below is empty, and the run ends
at `error at stage fixture-setup: fixture "authenticated-workspace" setup failed: …
FIXTURE_APP_SEED_TOKEN is not set` with exit `2` — which looks like a difmp bug and is not one.

```sh
kill %1                                  # or Ctrl-C in the terminal running the app
node examples/fixture-app/dist/main.js --port 3000 --variant false-success \
     --seed --seed-email demo@example.test --seed-password demo-password &
export FIXTURE_APP_SEED_TOKEN=<token> FIXTURE_APP_VARIANT=false-success
node apps/cli/dist/bin/difmp.js run examples/scenarios/project-create.e2e.md \
     --config examples/support/difmp.config.ts
```

Keep `--seed-email` / `--seed-password`: a bare `--seed` generates random credentials
(`user-4cc3d5cc@example.test / pw-cfd6f0b6-0f2`), which is fine for `project-create` — it
authenticates through the fixture and the seed token — but breaks `project-create-no-fixture`, whose
prose and scripted walkthrough both type `demo@example.test` / `demo-password` into the login form.

Observed, one app instance per variant, real Chromium each time:

| variant         | run      | exit | criteria                                                                         |
| --------------- | -------- | ---- | -------------------------------------------------------------------------------- |
| `healthy`       | `passed` | 0    | c1 c2 c3 passed                                                                  |
| `create-500`    | `failed` | 1    | c1 c2 c3 failed — the alert quotes `HTTP 500`, `network.jsonl` carries the `500` |
| `false-success` | `failed` | 1    | **c1 passed**, c2 c3 failed — the split is exactly at the reload                 |
| `alt-layout`    | `passed` | 0    | c1 c2 c3 passed, 10 actions instead of 8 (toggle + re-observe)                   |

`false-success` is the interesting one: the server answers `201 Created` and the page optimistically
renders the project, but nothing is persisted. The creation criterion legitimately passes and the
persistence criterion fails — which is the whole point of asking for evidence _after_ a reload.

### Repository layout

| path                                                                   |                                                                                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/core`](packages/core/README.md)                             | Schemas, spec loader, interpolation, config, registries, policy and budgets, events, `RunStore`, the runner. Depends on no React, no Playwright, no model SDK. |
| [`packages/browser-playwright`](packages/browser-playwright/README.md) | The `BrowserDriver` implementation: accessibility observations, actions, evidence capture.                                                                     |
| [`packages/agent-runtime`](packages/agent-runtime/README.md)           | The model seam: the Anthropic adapter, the scripted double, the agent prompt and the `Verifier`.                                                               |
| [`packages/reporting`](packages/reporting/README.md)                   | JSON, JUnit and standalone HTML reporters.                                                                                                                     |
| [`apps/cli`](apps/cli/README.md)                                       | Commands, layer assembly, the SSE server, the console reporter, exit codes, packaging.                                                                         |
| [`apps/ui`](apps/ui/README.md)                                         | The React live dashboard, built to static assets the CLI serves.                                                                                               |
| [`examples/fixture-app`](examples/fixture-app/README.md)               | The demo app and its four variants.                                                                                                                            |
| [`examples/scenarios`](examples/scenarios/README.md)                   | The demo scenarios, including four deliberately invalid ones.                                                                                                  |
| [`examples/support`](examples/support/README.md)                       | The project side of the demo: config, fixture, TS check, scripted walkthroughs.                                                                                |

### Verifying the distributed package

```sh
bash apps/cli/scripts/consumer-smoke/run.sh /tmp/consumer-smoke npm pnpm yarn yarn1
```

It packs the tarball, refuses one whose `dependencies` name a `@difmp/*` package, then builds a
throwaway consumer **outside this workspace** for each package manager and module format and puts
24 assertions through each. The CJS/ESM × npm/pnpm/Yarn matrix, the external system dependencies and
the SSE endpoints live in [`apps/cli/README.md`](apps/cli/README.md).

---

## Honest limitations

Read these before you adopt difmp, not afterwards. The full treatment, with the reasoning and the
open items, is in [`docs/architecture.md`](docs/architecture.md) §4.

- **Textual verification is probabilistic.** A `method: "model"` criterion is judged by a model
  reading the collected evidence. **It can produce false positives and false negatives, and it is not
  equivalent to a deterministic assertion.** Two runs over the same evidence may disagree. Vague
  wording in a scenario stays vague in the judgement — difmp deliberately never turns "quickly" into
  a numeric threshold. Where an expectation must be exact, bind it to a TS check and accept that this
  is the escape hatch, not the default path. What difmp does guarantee is what it _refuses_ to
  conclude: insufficient evidence stays `inconclusive`, a verdict citing an artifact that does not
  exist is forced to `inconclusive`, `finish` alone never declares success, and an unevaluated
  criterion makes the run `inconclusive`.
- **`allowedOrigins` is a tool-level check, not network isolation.** It is applied to the `navigate`
  tool. The page under test can still load third-party subresources, `fetch` anywhere and be
  redirected off-origin by the server; none of that passes through a difmp tool. There is no proxy,
  no container, no network namespace. Run scenarios in a controlled environment against an
  application you control.
- **Traces, videos and DOM snapshots can contain sensitive data.** There is no anonymisation. The
  redactor covers textual logs, prompts, events and the report; it does not reach inside `trace.zip`,
  `video.webm` or a screenshot, and it only knows the secrets it was told about through
  `ctx.secrets`. Use synthetic fixture data, and adopt a retention policy for run directories.
- **A scripted run tests difmp, not a model.** `provider: "scripted"` exercises the real prompt
  construction, tool dispatch, policy, budgets and real Playwright — so it proves _difmp_ behaves as
  specified. It is not evidence that a model can navigate an application. **No Anthropic API call has
  been made in this repository.**
- **Ctrl-C costs you the console block, not the files.** The run settles correctly and all three of
  `result.json`, `junit.xml` and `report.html` are written before the process exits `130`; the
  interrupt is re-raised the moment they are on disk, so the console reporter never prints the block
  for the scenario it interrupted. Read the status from `result.json`, or re-render the directory
  with `difmp report <dir>`.

Further reading: [`docs/architecture.md`](docs/architecture.md) for the seams, the decisions and the
limitations · [`docs/spec.md`](docs/spec.md) for the original product brief, translated from the
French original preserved in the git history ·
[`docs/internal/design-contracts.md`](docs/internal/design-contracts.md) for the authoritative names
and shapes · [`docs/internal/api-*.md`](docs/internal) for verified API cheat-sheets of the exact
dependency versions installed.
