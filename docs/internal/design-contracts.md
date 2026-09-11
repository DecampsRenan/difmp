# Canonical design contracts (authoritative for all implementation agents)

This file is the single source of truth for names, shapes and ownership. If your lane needs a
shape that is not here, ADD it here in the same commit and keep it consistent.
API facts live in the sibling `api-*.md` cheat-sheets — read the ones for your lane.

## 0. Vocabulary

- **spec** — a `*.e2e.md` file on disk (frontmatter + Markdown body).
- **contract** — the frozen, normalised, interpolated scenario: criteria with stable ids, hashes,
  resolved inputs. Written to `contract.json`. The browser agent can never modify it.
- **run** — one CLI invocation over one spec. **attempt** — one execution of that run (MVP: exactly 1).
- **criterion** — one expectation with a stable id `c1`, `c2`, … evaluated by `model` or `code`.
- **evidence / artifact** — a timestamped observation (screenshot, aria snapshot, network log slice,
  console slice, probe result) addressable by `artifactId` and owned by exactly one attempt.

## 1. Package ownership (do not write outside your lane)

| package | name | owns |
| --- | --- | --- |
| `packages/core` | `@harness/core` | schemas, spec loader, interpolation, config, registries, policy/budgets, events, RunStore, runner |
| `packages/browser-playwright` | `@harness/browser-playwright` | `BrowserDriver` impl, observation/aria refs, evidence capture |
| `packages/agent-runtime` | `@harness/agent-runtime` | `ModelProvider` iface, Anthropic adapter, scripted adapter, agent loop, `Verifier` impls |
| `packages/reporting` | `@harness/reporting` | JSON/JUnit/standalone-HTML reporters |
| `apps/cli` | `@harness/cli` | commands, layer assembly, SSE server, console reporter, exit codes, packaging |
| `apps/ui` | `@harness/ui` | React live UI (built to static assets consumed by the CLI) |
| `examples/fixture-app` | `@harness/fixture-app` | demo app + variants + probe endpoint |
| `examples/scenarios` | — | `*.e2e.md` demo specs |
| `examples/support` | `@harness/example-support` | demo `harness.config.ts`, fixtures, TS checks, scripted-adapter scripts |

`@harness/core` must NOT depend on React, Playwright, or any model SDK. Driver/provider/verifier
are `Context.Service` interfaces declared in core and implemented in the other packages.

Cross-package imports use workspace deps (`"@harness/core": "workspace:*"`) and the package's
public entrypoint only (`@harness/core`), never deep `src/` paths.

## 2. Identifiers

- `runId`: `r_<base32 of 8 random bytes>` — url-safe, lowercase, stable length. Also used inside
  `{{ run.id }}`, so it MUST be safe inside a project name and inside a file path.
- `attemptId`: `a1`, `a2`, … per run (MVP always `a1`).
- `actionId`: `act_<seq>` monotonically increasing per attempt.
- `observationId`: `obs_<seq>` per attempt.
- `artifactId`: `art_<seq>` per attempt.
- `criterionId`: `c1`, `c2`, … in source order.
- Element refs inside an observation: whatever the driver mints (see api-playwright.md); they are
  only valid together with their `observationId`.

## 3. `harness.config.ts`

```ts
import { defineConfig } from "@harness/core"   // re-exported by the CLI package too

export default defineConfig({
  // discovery
  include: ["**/*.e2e.md"],                 // default
  exclude: ["**/node_modules/**", "**/runs/**", "**/dist/**"],  // always merged in
  // target
  baseUrl: "http://127.0.0.1:3000",
  allowedOrigins: ["http://127.0.0.1:3000"],   // navigation policy; baseUrl origin always allowed
  // data
  inputs: { projectName: "Projet {{ run.id }}" },   // project-level defaults (lowest priority)
  // registries — names referenced by specs resolve HERE, never as import paths
  fixtures: { "authenticated-workspace": myFixture },
  checks:   { "project-unique-in-storage": myCheck },
  scripts:  { "healthy": myScriptFactory },   // scripted adapter only — see §11
  // model
  provider: "scripted" | "anthropic",
  model: "claude-sonnet-5",                   // provider-specific id, never hardcoded in core
  providerOptions: { maxTokens: 2048, temperature: 0,
                     script: "healthy" },     // scripted adapter: names an entry of `scripts`
  // guidance vs budgets  (SEPARATE — see §7)
  maxActions: 25,                             // INDICATIVE ONLY
  budgets: {
    attemptTimeoutMs: 120_000,
    operationTimeoutMs: 15_000,
    maxModelCalls: 40,
    maxTokens: 200_000,
    verifierReserveTokens: 20_000,            // held back so the final evaluation can always run
    fixtureCleanupTimeoutMs: 15_000,
  },
  capture: {
    trace: "on" | "off",                      // default "on"
    video: "on" | "off",                      // default "off"
    screenshots: "checkpoints" | "every-action" | "off",   // default "checkpoints"
    retainTraceOn: "all" | "failure",         // default "all"
  },
  outputDir: "runs",
  reporters: ["console"],
})
```

`fixtures`, `checks` and `scripts` hold FUNCTIONS: they are stripped before validation, never reach
`manifest.json` and are exposed as `Registries`. `defineConfig` is identity + types. The resolved
config is validated with Schema. Unknown top-level keys are REJECTED.

**Discovery base.** `include`/`exclude` are resolved against the config's own directory; paths and
globs given as CLI arguments are resolved against the invocation directory. Globbing runs from the
deepest directory containing every pattern, not from that base, so `exclude` (and the mandatory
`**/node_modules/**`, `**/runs/**`, `**/dist/**`) still applies when `include` reaches outside the
config directory — `ignore` entries match paths relative to the glob's cwd, and `**/…` never matches
a path beginning with `../`. **One literal `*.e2e.md` file named on the command line bypasses
`exclude`**: naming a file is unambiguous, and it is what lets an intentionally invalid spec reach
the loader and be rejected. `harness.config.ts` is loaded as trusted project code (see api-tooling.md for the
TS loader); its path comes from `--config` or upward lookup from cwd, NEVER from a spec.

## 4. Spec → contract

```ts
// frontmatter (Schema, unknown keys rejected, duplicate YAML keys rejected)
{ version: 1, id: string, tags?: string[], fixture?: string, timeout?: string|number,
  maxActions?: number, inputs?: Record<string, string|number|boolean>,
  verification?: string, checks?: Record<criterionId, checkName> }
```

Expectations come from EITHER `verification` OR a `## Résultats attendus` (also accept
`## Expected results`) Markdown section — never both (hard error). Splitting rule: top-level
Markdown list ⇒ one criterion per item; no list ⇒ the whole paragraph block is one criterion.

```ts
interface ScenarioContract {
  schemaVersion: 1
  specPath: string           // relative to the config root
  id: string
  tags: string[]
  fixtureName?: string
  body: string               // interpolated Markdown body
  criteria: Array<{
    id: string               // "c1"
    text: string             // interpolated, VERBATIM contract text
    sourceText: string       // pre-interpolation
    line: number; column: number
    method: "model" | "code"
    checkName?: string       // when method === "code"
  }>
  inputs: Record<string, string|number|boolean>   // resolved
  maxActions: number
  budgets: Budgets
  hashes: { spec: string; contract: string; criteria: Record<string,string>; prompts: Record<string,string> }
}
```

Hashes are sha256 hex (truncate to 16 chars in display, keep full in JSON). A `checks` mapping
binds a criterion id to a TS check; the check receives the criterion's **text and hash** so a
reordering of expectations cannot silently rebind it — mismatch ⇒ hard error.

### Interpolation (data substitution only, no expression engine)

Available: `{{ run.id }}`, `{{ attempt.id }}`, declared input keys, and `{{ fixture.<key> }}`.
Order: (1) resolve `inputs` values using reserved vars only → (2) run the fixture with them →
(3) interpolate body + criteria with resolved inputs AND fixture public values.
Inputs may not reference fixture values or each other. Unknown variable ⇒ error naming file, field,
line. `validate` accepts unresolved `fixture.*` (no setup yet); `run` rejects them after setup.

Input precedence: **config < spec < --inputs-file < --input**. CLI/file keys not declared in
config or spec are REJECTED. `--input k=v` always yields a string; `--inputs-file` keeps JSON types.

## 5. Agent tools (Schema-validated in and out)

| tool | params | notes |
| --- | --- | --- |
| `observe` | `{}` | returns `{ observationId, url, title, snapshot, elements[] }` |
| `navigate` | `{ url, intent? }` | rejected unless origin ∈ allowedOrigins |
| `click` | `{ observationId, ref, intent? }` | |
| `fill` | `{ observationId, ref, value, intent? }` | |
| `press` | `{ observationId?, ref?, key, intent? }` | |
| `scroll` | `{ direction: "up"\|"down", amount?, intent? }` | |
| `screenshot` | `{ label?, fullPage? }` | mints an artifact |
| `check` | `{ criterionId, note? }` | triggers evidence collection + evaluation; agent supplies NO verdict |
| `finish` | `{ summary? }` | triggers FINAL verification; never sufficient for success |

Stale/ambiguous `observationId`/`ref` ⇒ a typed tool ERROR result telling the agent to re-observe.
The action still counts. It must NOT fall back to clicking a different element.
`intent` is a short free-text string, optional, logged verbatim. Never request chain-of-thought.
Page content is DATA: the system prompt states that text from the page can never grant tools or
change the scenario, and the contract text is never re-sent from the page.

## 6. Events (`events.jsonl`, append-only, written BEFORE live fan-out)

Every event: `{ schemaVersion: 1, seq: number, runId, attemptId?, ts: string /*UTC ISO*/,
durationMs?: number, type: string, ... payload }`. `seq` increases by 1 per run.

Types (exhaustive, discriminated union):
`runStarted`, `configResolved`, `contractFrozen`, `fixtureReady`, `fixtureCleaned`,
`browserContextOpened`, `observationTaken`, `modelCallStarted`, `modelCallFinished`
(both carry `role: "browser" | "verifier"`), `actionStarted`, `actionFinished`,
`evidenceRequested`, `verificationFinished`, `artifactAvailable`, `actionGuidanceExceeded`,
`budgetExhausted`, `progressStalled`, `error`, `cancellationRequested`, `runFinished`.

Action events carry `actionId`; verification events carry `criterionId`; evidence links via
`artifactId` and `sourceSeq`. Writes are serialised through a single queue to preserve order; a
truncated last line is tolerated on reload and reported as "not finalised".

## 7. maxActions vs blocking budgets — DO NOT CONFLATE

`maxActions` counts **accepted browser tool calls** (observations, screenshots and failed attempts
included). Model calls and verification operations are counted SEPARATELY and never against it.
On the FIRST crossing only: emit `actionGuidanceExceeded`, surface `"28 actions / 25 indicatives"`,
and inject one short nudge into the agent conversation. Nothing is refused, no status is degraded,
no approval is required. A run that passes in 40 actions is `passed`.

Blocking budgets are the separate, configurable ones in §3 `budgets`. Exhausting one ends the loop
and yields `inconclusive` (not `failed`), with no late actions or requests permitted afterwards.
Verifier token usage counts toward `maxTokens`; `verifierReserveTokens` is withheld from the
browser loop so the final evaluation can always run.

## 8. Verification and result

```ts
interface CriterionResult {
  criterionId: string; criterionHash: string
  status: "pending" | "passed" | "failed" | "inconclusive" | "error"
  method: "model" | "code"
  evaluator: { kind: "model"; provider: string; model: string } | { kind: "scripted-model" } | { kind: "code"; checkName: string }
  expected: string; observed: string
  evidence: string[]          // artifactIds, MUST exist and belong to this attempt
  limitations?: string
  evaluatedAtSeq: number
}
```

The harness validates the structure and that every referenced `artifactId` exists and belongs to the
attempt. Invented/absent references ⇒ the criterion is forced to `inconclusive`, never `passed`.
A criterion with no sufficient evidence stays `inconclusive`. A verifier may instead answer
`needsEvidence`, and the loop may keep navigating within budget; but on the runner's FINAL pass
there is no "next time", so a `needsEvidence` answer there resolves to `inconclusive` naming what
was missing — never left `pending`, which would read as "never looked at". `pending` survives only
when the attempt ended before the criterion could be reached (cancellation, execution error).
Evidence minted DURING an evaluation (a code check's probe output) is part of the attempt: the
artifact inventory is re-read after the evaluation, before the reference check. Vague wording is never turned into an
invented threshold. `evaluator.kind === "scripted-model"` marks the deterministic test double so it
is never confused with a real model judgement.

Aggregation (exact order): explicit cancellation → `cancelled`; else blocking execution error or a
failure to persist mandatory evidence → `error`; else any mandatory criterion `failed` → `failed`;
else any criterion not resolved → `inconclusive`; else `passed`.
Individual criterion statuses are preserved in `result.json` even when the aggregate is `error`.

**Absence rule**: a locator missing after uncertain navigation ⇒ `inconclusive`. A locator
established as absent at the checkpoint the criterion names (page loaded, list rendered, settled)
⇒ `failed`. Implement this distinction explicitly and record which branch was taken.

## 9. Run directory

```
runs/<run-id>/
  manifest.json    # resolved non-sensitive config, dep versions, model identity, hashes, adapter id
  spec.e2e.md      # verbatim copy of the source spec
  contract.json
  events.jsonl
  result.json
  report.html
  junit.xml
  artifacts.json   # inventory: every expected artifact with state present|missing|failed + reason
  attempts/<attempt-id>/{trace.zip,screenshots/,video.webm,console.jsonl,network.jsonl}
```
Result files are written by atomic replace (temp file + rename). Missing optional artifacts are
listed in `artifacts.json` with a reason — a capture failure is never hidden.

## 10. `ModelProvider` (agent-runtime, consumed by core via a core-declared service)

```ts
interface ModelProvider {
  readonly id: string                       // "anthropic" | "scripted"
  readonly modelId: string
  generate(req: {
    role: "browser" | "verifier"
    prompt: Prompt                          // conversation so far
    tools?: ToolDefinition[]                // JSON-Schema derived from Effect Schema
    responseSchema?: Schema                 // verifier: structured object
    signal?: AbortSignal
  }): Effect<ProviderResponse, ProviderError>
}
interface ProviderResponse {
  text?: string
  toolCalls: Array<{ id: string; name: string; params: unknown }>
  object?: unknown
  usage?: { inputTokens?: number; outputTokens?: number }
  finishReason?: string
}
```
Tool calls are returned to the harness, NEVER auto-executed by the provider. The harness validates
params with Schema and applies policy before execution. Interruption must abort the in-flight HTTP
request where the provider allows it, and close resources so no late action lands.

## 11. Fixtures and TS checks (registered in config, resolved by name only)

```ts
type Fixture = (ctx: {
  runId: string; attemptId: string
  inputs: Record<string, string|number|boolean>
  secrets: (name: string) => string | undefined      // from env, never logged, never in prompts
  addCleanup: (fn: () => Promise<void> | void) => void   // registered AT ACQUISITION time
  baseUrl: string
}) => Promise<{
  public?: Record<string, string|number|boolean>     // exposed as {{ fixture.<key> }} and to the model
  storageState?: StorageStateLike                    // PRIVATE — browser only, never to the model
  cookies?: ...; origins?: ...
}>

type Check = (ctx: {
  runId: string; attemptId: string
  criterion: { id: string; text: string; hash: string }   // hash MUST be verified by the harness
  inputs; fixture: { public } ; baseUrl
  recordEvidence: (e: { label: string; data: unknown }) => Promise<string /* artifactId */>
}) => Promise<{ status: "passed"|"failed"|"inconclusive"; expected: string; observed: string; evidence: string[] }>
```
### Scripted-adapter scripts (`scripts`, resolved by name only)

```ts
type ScriptFactory = (ctx: {
  runId: string; attemptId: string
  scenarioId: string; specPath: string
  baseUrl: string
  inputs: Record<string, string|number|boolean>   // resolved, `{{ run.id }}` already substituted
  criterionIds: ReadonlyArray<string>             // source order — a script asks for `check` by id
}) => { agent: AgentScript; verdicts?: VerdictScript; defaultUsage?: { inputTokens, outputTokens } }
```

A FACTORY, not a finished script: a deterministic walkthrough has to type the value the run will
really use (`Projet {{ run.id }}` is only a string once the run id exists) and to name the criteria
of the spec being run. The CLI resolves `providerOptions.script` against this registry after minting
the run id and resolving the inputs, and before opening the browser. Core declares the context and
keeps the return value opaque (`ScriptFactory<A = unknown>`), so `@harness/core` still depends on no
model SDK; `@harness/agent-runtime` owns the returned shape. `provider: "anthropic"` ignores the
registry entirely.

Every check probe is journalled as a harness operation. Cleanup runs after success, failure AND
cancellation, under `budgets.fixtureCleanupTimeoutMs`. Without a `fixture`, open a clean context at
`baseUrl` — inputs and fixture are genuinely optional.

## 12. Exit codes (CLI)

`0` all selected scenarios passed · `1` any `failed` or `inconclusive` · `2` invalid config or
execution error · `130` user interrupt. **No spec selected is an explicit error (exit 2), never a
silent success.**

JUnit mapping: product criterion failures ⇒ `<failure>`; technical errors and indeterminate results
⇒ `<error>` with the real status preserved in the message; cancellations ⇒ `<error>` and documented.
Never emit a green `skipped` for an indeterminate result.

## 13. Security hygiene

Escape everything that reaches HTML (spec text, model text, page text, logs). Redact known secret
values from textual logs and prompts. Do not claim traces/videos/DOM are anonymised — document the
limitation and use synthetic fixture data. The origin allow-list is a tool-level check, not network
isolation — document that too.

---

## 14. Open decisions surfaced by the critic pass (decide these in step 1, not step 6)

These are contract-shaped questions the cheat-sheets can now answer *technically* but that this file
does not yet settle. Pick one and edit the relevant section above.

1. **Is `ModelProvider` (§10) a real abstraction, or just a swapped `LanguageModel` layer?**
   `effect/unstable/ai` is part of `effect` itself, not a vendor SDK, so putting
   `LanguageModel.LanguageModel` in `@harness/core` does **not** violate "core must not depend on a
   model SDK". `LanguageModel.make({ generateText, streamText })` gives a fully deterministic
   scripted provider in ~20 lines (api-effect-ai.md §B2, compiled + executed) and lets the scripted
   and real adapters share the entire loop, prompt plumbing, usage accounting and tool typing.
   Hand-rolling the §10 `ModelProvider` interface duplicates all of that. **Recommendation: drop
   §10's custom interface; make `provider` a choice of `Layer<LanguageModel>`.** If §10 is kept,
   say explicitly what it buys.

2. **`observationId` + element `ref` lifetime.** api-playwright.md §2 proves a ref is valid only
   against the *most recent ai-mode snapshot in that frame*, and that **any** default-mode
   `ariaSnapshot` anywhere disarms every ref. §5 above must state: one `observationId` is live at a
   time per attempt; a ref from an older `observationId` is rejected **without** touching the page;
   `observe` is the only caller of `ariaSnapshot`.

3. **`timeout: 90s` has no parser.** Effect rejects `"90s"` (api-effect-core.md §A1). Either
   change the contract to the spaced form (`90 seconds`) — which contradicts the spec's own
   example — or adopt the abbreviation normaliser. **Recommendation: normaliser, accept both.**
   Record the decision in §4.

4. **`artifactId` / `observationId` / `actionId` counters vs UUIDv7.** §2 specifies `art_<seq>`.
   A per-attempt counter must be single-writer and shared with the `events.jsonl` `seq` writer.
   `Crypto.randomUUIDv7` (api-effect-core.md §A2) is monotonic and needs no shared state. Keep
   `art_<seq>` only if the event writer already owns the counter.

5. **Does the aggregate `passed` require every criterion, or only "mandatory" ones?** §8's
   aggregation says "critère obligatoire", but nothing in §4's `ScenarioContract.criteria` marks a
   criterion optional, and the spec never introduces optional criteria. **Either add a field or
   drop the word "obligatoire"** — otherwise two implementers will read it differently.

6. **Where does `maxActions` counting live?** §7 says accepted browser tool calls including failed
   ones. A rejected *stale ref* produces a typed tool error (§5) — the text says the action "still
   counts". Make sure the counter increments in the tool dispatcher, before policy validation, and
   that a **policy-rejected** `navigate` (disallowed origin) is stated one way or the other.

7. **`report` (§12) must render without a model call and without the run's original config.**
   `report <run-directory>` reads `result.json` + `contract.json` + `artifacts.json` only. State
   that `manifest.json` is the sole source of "which adapter was used" so the reporter never has to
   re-resolve config.

Supporting facts now verified and available: run ids + sha256 via `Crypto.Crypto`
(api-effect-core.md §A2), cancellation with finalizer-ordering guarantees (api-effect-core.md §A3 /
api-effect-http-node.md §C2), frontmatter field→line mapping (api-tooling.md §A-L),
`--inputs-file` typed decoding (api-tooling.md §A-I), tool JSON-Schema emission
(api-effect-ai.md §B1).

---

## 15. Live-UI ↔ CLI HTTP surface (added by the `apps/ui` lane)

`apps/ui` is built by `vite build` to `apps/ui/dist` (`base: "./"`), so the CLI may mount it at any
path. Every URL the app uses is RELATIVE to the page, and the CLI may override them by injecting
one script tag before the bundle:

```html
<script>globalThis.__HARNESS_UI__ = {
  eventsUrl: "events", cancelUrl: "cancel", contractUrl: "contract", artifactBaseUrl: "artifacts/",
  pricing: { currency: "USD", inputPerMillionTokens: 3, outputPerMillionTokens: 15 }  // OPTIONAL
}</script>
```

| route | method | contract |
| --- | --- | --- |
| `eventsUrl` | GET | `text/event-stream`. One frame per journal line: `id: <seq>`, `event: <event.type>`, `data: <the full HarnessEvent as JSON>`. MUST honour `Last-Event-ID` **and** a `?lastEventId=<seq>` query parameter (see below) and replay from the journal. Send `retry:` to set the client's reconnect delay. |
| `cancelUrl` | POST | JSON body `{ reason: string }`. Any 2xx is treated as accepted; the UI then waits for `cancellationRequested` in the stream. |
| `contractUrl` | GET | `contract.json` (`ScenarioContract`). |
| `artifactBaseUrl` | GET | serves `ArtifactRecord.path` values, which are relative to the run directory. |

**Why the query parameter too.** `EventSource` sends `Last-Event-ID` on the reconnects *it* drives,
but the header cannot be set from script. When the browser gives up (readyState `CLOSED`) the UI
opens a fresh `EventSource` and can only carry the cursor in the URL. Support both; they mean the
same thing.

**Replay is exclusive or inclusive — the client tolerates either.** The UI applies an event iff
`seq > lastSeq`, which is exact because `seq` increases by 1 per run (§6). A server that replays
`seq >= cursor` produces one absorbed duplicate, not a duplicated row.

**Open gap — `contractFrozen` carries criterion ids only (§6).** §11 of the spec requires the live
view to show each criterion's *text* and its `model` vs `code` *method* from the moment the contract
is frozen, i.e. before any `verificationFinished`. The UI therefore fetches `contractUrl`. Two ways
to close this properly, pick one:
* keep the fetch and make `contractUrl` a required CLI route (what `apps/ui` implements today), or
* widen `ContractFrozenEvent` with `criteria: Array<{ id, text, method, checkName? }>` — the UI
  already reads that field when present and prefers it over the fetch.

`pricing` is absent by default and there is no price table anywhere in core, so **cost renders as
the literal string `indisponible`** — never an estimate, never `0`.
