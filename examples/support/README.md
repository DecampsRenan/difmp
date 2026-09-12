# `@difmp/example-support` — demo config, fixture, TS check and scripted runs

This package is the *project side* of the demo: the things a real consumer of the harness would
write for themselves. It holds the `difmp.config.ts` the example scenarios run against, the
`authenticated-workspace` fixture, the optional `project-unique-in-storage` TS check, and the
deterministic adapter scripts used by the repository's tests.

The application under test is [`examples/fixture-app`](../fixture-app/README.md); the scenarios are
in [`examples/scenarios`](../scenarios).

```
examples/support/
  difmp.config.ts                     the configuration itself
  fixtures/authenticated-workspace.ts   seeds an isolated workspace + signed-in session
  fixtures/attempt-state.ts             private per-attempt channel between the fixture and the check
  checks/project-unique-in-storage.ts   authoritative, deterministic uniqueness verdict
  scripts/                              scripted-adapter runs for the deterministic tests
```

## 1. Running the examples

```bash
# build everything the examples need
pnpm --filter @difmp/fixture-app --filter @difmp/core --filter @difmp/agent-runtime build
pnpm --filter @difmp/example-support typecheck

# start the demo app on a fixed port, with a demo workspace and the seed token printed
node examples/fixture-app/dist/main.js --port 3000 --variant healthy --seed
```

The app prints its `x-seed-token`. Export it, because the fixture and the check both read it from
the environment:

```bash
export FIXTURE_APP_SEED_TOKEN=<the token printed above>
# optional; only needed when the app did NOT bind 127.0.0.1:3000
export DIFMP_BASE_URL=http://127.0.0.1:3000
```

`DIFMP_BASE_URL` and `DIFMP_SCRIPT` (§6) were called `HARNESS_BASE_URL` and `HARNESS_SCRIPT` before
the tool was renamed to `difmp`. They are read by **this demo configuration**, not by the CLI — the
CLI has no environment interface of its own — so they were renamed outright, with no fallback: the
only callers are this repository's own scripts, and they were all updated. If you kept a shell
snippet from before the rename, change the prefix.

Then, from anywhere (these use the built CLI directly; `difmp` works the same once the package is
installed):

```bash
node apps/cli/dist/bin/difmp.js run examples/scenarios/project-create.e2e.md          --config examples/support/difmp.config.ts
node apps/cli/dist/bin/difmp.js run examples/scenarios/project-create-checked.e2e.md  --config examples/support/difmp.config.ts
node apps/cli/dist/bin/difmp.js run examples/scenarios/project-create-no-fixture.e2e.md --config examples/support/difmp.config.ts
node apps/cli/dist/bin/difmp.js run --config examples/support/difmp.config.ts        # all three
```

With no path argument, discovery uses the configured `include` (`../scenarios/**/*.e2e.md`)
resolved against **this directory** — the one holding `difmp.config.ts` — so the selection does
not depend on where you invoke the CLI from. Paths you pass as arguments are resolved against the
invocation directory instead.

### The four variants

Restart the app with `--variant <name>` **and** export `FIXTURE_APP_VARIANT=<name>` for the harness
process: the app changes what it does, and the environment variable tells the `auto` script entry
(see §6) which walkthrough the deterministic adapter must use — `alt-layout` renames every control.

| variant | what `project-create` should do |
| --- | --- |
| `healthy` | pass |
| `create-500` | fail on the creation criterion, with the HTTP status in the UI and the network log |
| `false-success` | pass the creation criterion, fail the persistence one after the reload |
| `alt-layout` | pass — same capability, different shape (toggle + dialog, table instead of a list) |

### `project-create-no-fixture` needs a known account

That scenario signs in through the UI, so the account it names has to exist before the run. It is
synthetic demo data, not a secret — start the app with it:

```bash
node examples/fixture-app/dist/main.js --port 3000 --variant healthy \
  --seed --seed-email demo@example.test --seed-password demo-password
```

or create it afterwards through the guarded seed API:

```bash
curl -sS -X POST http://127.0.0.1:3000/__seed/workspace \
  -H "x-seed-token: $FIXTURE_APP_SEED_TOKEN" -H 'content-type: application/json' \
  -d '{"workspaceName":"Espace de démonstration","email":"demo@example.test","password":"demo-password"}'
```

## 2. `difmp.config.ts`

`defineConfig` is identity + types; the real validation happens in core's `resolveConfig`, which
rejects unknown top-level keys.

What it sets, and why:

- **`baseUrl` / `allowedOrigins`** — the fixture app, and nothing else. The origin allow-list is a
  *tool-level* check applied to `navigate`; it is not network isolation. A page can still load
  third-party subresources — see §5.
- **`inputs.projectName: "Projet {{ run.id }}"`** — a project-level default, the lowest-priority
  layer of `config < spec < --inputs-file < --input`. `{{ run.id }}` makes the name unique per run.
- **`fixtures` / `checks` / `scripts`** — the registries. A spec references a **name**; it can never
  name a module path, and a name that is not registered is a hard error listing what is. `scripts`
  is the scripted adapter's; `providerOptions.script` picks one (see §6).
- **`maxActions: 25`** — INDICATIVE. Crossing it emits one `actionGuidanceExceeded`, surfaces
  `"28 actions / 25 indicatives"` and injects one nudge. No tool is refused and no verdict changes:
  a run that passes in 40 actions is `passed`.
- **`budgets`** — the BLOCKING limits, and a different thing entirely. Exhausting one ends the loop
  with `inconclusive` (never `failed`) and lets no late action or request through.
  `verifierReserveTokens` is a pool for the final evaluation: it is withheld from the browsing loop
  (which is refused a new call at `maxTokens - verifierReserveTokens`) AND guaranteed to the
  verifier whatever the browsing loop consumed, so an oversized browsing turn cannot take the final
  evaluation's tokens away. When that happens, total spend can exceed `maxTokens` by the overshoot
  plus the reserve — that is the price of the guarantee, and it is deliberate.
- **`provider: "scripted"`** — the deterministic, network-free double, so the repository's tests need
  no API key. A scripted run tests the *harness*; it is never evidence that a model can navigate,
  and the report names the adapter that ran.

### Switching to the real model

```ts
provider: "anthropic",
model: "claude-sonnet-5",
providerOptions: { maxTokens: 2048, temperature: 0 }
```

with `ANTHROPIC_API_KEY` in the environment — or, without editing the file,
`difmp run --provider anthropic --model claude-sonnet-5`. `alt-layout` is the variant worth
pointing a real model at: it is functionally identical to `healthy` and differently shaped.

## 3. The `authenticated-workspace` fixture

Spec §4's fixture. It creates an isolated workspace, its user and an active session in one guarded
call to `POST /__seed/workspace`, and hands the harness two clearly separated things:

| | | |
| --- | --- | --- |
| `public` | `{ workspaceName }` | interpolated as `{{ fixture.workspaceName }}`, **visible to the model** |
| `storageState` | the `sid` session cookie | **private**: handed to the browser context only |

The session token is never in `public`, so it cannot reach a prompt, a report or an interpolated
criterion. The seed token is read with `ctx.secrets("FIXTURE_APP_SEED_TOKEN")` — from the
environment, never from an input — and is redacted out of any error message that quotes a response.

Every attempt gets its own workspace (`Espace <runId>-<attemptId>`) and its own user. A shared
tenant would not be isolation, because these scenarios write to the application.

**Cleanups are registered at acquisition time.** The moment the seed call returns, the fixture
registers both teardown steps — before it validates the session, which can still fail. A setup that
fails halfway is therefore still torn down. Cleanup runs after success, failure *and* cancellation,
bounded by `budgets.fixtureCleanupTimeoutMs`.

### What cleanup can and cannot do

The fixture app exposes exactly one destructive operation over HTTP (`GET /logout`), so cleanup
revokes the session and drops the attempt's private state. The workspace itself lives in a
per-process store and is abandoned when the server stops. This is honest rather than complete: a
real project would delete the tenant here. Nothing about the demo depends on the workspace being
removed, because every attempt uses a fresh one.

## 4. The `project-unique-in-storage` check

The optional TS check of spec §13, used only by `project-create-checked.e2e.md`:

```yaml
checks:
  c3: project-unique-in-storage
```

It answers a question the visible list **cannot**: how many projects with this name were actually
persisted. A list can be filtered or paginated, so "one row is visible" never establishes global
uniqueness — which is exactly why the plain `project-create` scenario words its third expectation as
a statement about the visible list.

The check reads `GET /__probe/projects?workspaceId=…&name=…`, the fixture app's **reserved probe**:

- it is guarded by the `x-seed-token` header (403 without it, 404 when the app runs with
  `seedEnabled: false`);
- it is never linked from, or mentioned in, any served HTML;
- **the browsing agent has no access to it**: the agent's entire vocabulary is the nine tools of the
  harness (`observe`, `navigate`, `click`, `fill`, `press`, `scroll`, `screenshot`, `check`,
  `finish`), it has no HTTP tool, and `navigate` is constrained by the origin allow-list.

Its result is `method: "code"` and authoritative for that criterion. The probe response is recorded
as evidence (`recordEvidence`) before the verdict is returned, so the verdict always points at
something. The evidence payload carries the probe coordinates and what the store answered — never
the token, the cookie or the session.

**Guards against a silent rebind.** Criterion ids are positional, so reordering the expectations
would hand this check a different sentence under the same id. It therefore refuses to answer unless
(1) `sha256(criterion.text)` equals the hash frozen in the contract, and (2) the text really is the
uniqueness statement about this attempt's project name. A failed guard is `inconclusive` with a
message saying which guard bit — never `passed`, and never a product failure.

**How it finds the workspace.** `fixtures/attempt-state.ts` is a module-level map keyed by
`runId/attemptId`: the fixture writes the workspace id there, the check reads it, and the cleanup
deletes it. It deliberately does not travel through `public`, because everything in `public` reaches
the model, and the workspace id is a probe coordinate.

## 5. Security notes

- Secrets come from the environment (`FIXTURE_APP_SEED_TOKEN`), never from `inputs`, never into a
  prompt, a criterion or a report. Demo *credentials* written in `project-create-no-fixture.e2e.md`
  are synthetic fixture data for a throwaway local app — a real secret would never be written in a
  spec.
- `allowedOrigins` is a tool-level check on `navigate`, not network isolation.
- Traces, videos and DOM snapshots are **not** anonymised. Use synthetic fixture data — which is
  what the demo app produces.

## 6. Scripted adapter runs (`scripts/`)

The script *format* and the app-agnostic patterns belong to `@difmp/agent-runtime`
(`src/scripted/script.ts`, `src/scripted/scenarios.ts`); that package already ships that location,
so nothing is re-implemented here. What lives in `scripts/` is the part that can only be written
against a concrete application.

- `scripts/journey.ts` — the real accessible names of the fixture app, per variant (`alt-layout`
  hides its form behind a "New project" toggle and renames the fields), plus the create-then-reload
  journey and the fixture-free login journey. A reload is expressed as a `navigate` back to the base
  URL; there is no `reload` tool.
- `scripts/risky.ts` — the harness-behaviour cases of spec §13: a premature `finish`, a run that
  deliberately crosses `maxActions` and still succeeds, a deliberately stale `observationId`, and a
  run that can only end on a blocking budget.
- `scripts/index.ts` — `fixtureAppScripts({ baseUrl, projectName, variant })` returns every case
  keyed by name, each as a `ScriptedProviderScript` (browsing script + canned verifier answers).
- `scripts/registry.ts` — the same cases as the `scripts` **registry** of `difmp.config.ts`. Each
  entry is a FACTORY, because a script has to type the value the run will really use
  (`Projet {{ run.id }}` is only a string once the run id exists) and to name the criteria of the
  spec being run; the harness calls it with `ScriptFactoryContext` after minting the run id,
  resolving the inputs and before opening the browser.

### Choosing a case

```bash
# the default: `auto` picks the journey from the scenario and from FIXTURE_APP_VARIANT
FIXTURE_APP_VARIANT=false-success node apps/cli/dist/bin/difmp.js run \
  examples/scenarios/project-create.e2e.md --config examples/support/difmp.config.ts

# any other case, by name
DIFMP_SCRIPT=stale-observation node apps/cli/dist/bin/difmp.js run \
  examples/scenarios/project-create.e2e.md --config examples/support/difmp.config.ts
```

| key | drives | expected harness behaviour |
| --- | --- | --- |
| `healthy` / `alt-layout` | `project-create` | `passed` |
| `create-500` | `project-create` | `failed` on creation and everything downstream |
| `false-success` | `project-create` | creation `passed`, persistence `failed` |
| `no-fixture` | `project-create-no-fixture` | `passed`, clean context, UI login |
| `auto` | any | picks by scenario id + `FIXTURE_APP_VARIANT`; the default |
| `premature-finish` | any | nothing is ever checked ⇒ every criterion `inconclusive` ⇒ run `inconclusive`; `finish` alone is never enough |
| `unevaluated-criterion` | `project-create` | c1 and c2 `passed`, c3 never requested ⇒ `inconclusive`: `passed` needs every criterion |
| `cancellable` | `project-create` | a long but legal run, used to test cancellation mid-flight |
| `exceed-actions` | `project-create` | one `actionGuidanceExceeded`, still `passed` |
| `stale-observation` | `project-create` | one typed `stale-observation` tool error, no fallback click, action still counted |
| `budget-exhausted` | any | `inconclusive` with reason `budget-exhausted`, no late actions |
| `invented-evidence` | any | verdicts citing artifacts that do not exist are forced to `inconclusive` |
| `needs-evidence` | `project-create` | the verifier asks for more evidence once, then concludes |

## 7. The deliberately invalid specs

`examples/scenarios/invalid/` holds four specs that MUST be rejected before a browser ever starts:
both expectation sources at once, an unknown frontmatter field, a duplicate YAML key, and a missing
`version`. They are excluded from discovery by `exclude: ["**/invalid/**"]`, so they are loader
fixtures, not runs — but naming one explicitly still reaches the loader, which is how the rejection
is demonstrated:

```bash
node apps/cli/dist/bin/difmp.js run examples/scenarios/invalid/missing-version.e2e.md \
  --config examples/support/difmp.config.ts     # exit 2, no browser started, no run directory
```
