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

| package                       | name                        | owns                                                                                              |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/core`               | `@difmp/core`               | schemas, spec loader, interpolation, config, registries, policy/budgets, events, RunStore, runner |
| `packages/browser-playwright` | `@difmp/browser-playwright` | `BrowserDriver` impl, observation/aria refs, evidence capture                                     |
| `packages/agent-runtime`      | `@difmp/agent-runtime`      | `ModelProvider` iface, Anthropic adapter, scripted adapter, agent loop, `Verifier` impls          |
| `packages/reporting`          | `@difmp/reporting`          | JSON/JUnit/standalone-HTML reporters                                                              |
| `apps/cli`                    | `difmp`                     | commands, layer assembly, SSE server, console reporter, exit codes, packaging                     |
| `apps/ui`                     | `@difmp/ui`                 | React live UI (built to static assets consumed by the CLI)                                        |
| `examples/fixture-app`        | `@difmp/fixture-app`        | demo app + variants + probe endpoint                                                              |
| `examples/scenarios`          | —                           | `*.e2e.md` demo specs                                                                             |
| `examples/support`            | `@difmp/example-support`    | demo `difmp.config.ts`, fixtures, TS checks, scripted-adapter scripts                             |

`@difmp/core` must NOT depend on React, Playwright, or any model SDK. Driver/provider/verifier
are `Context.Service` interfaces declared in core and implemented in the other packages.

Cross-package imports use workspace deps (`"@difmp/core": "workspace:*"`) and the package's
public entrypoint only (`@difmp/core`), never deep `src/` paths.

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

## 3. `difmp.config.ts`

```ts
import { defineConfig } from "@difmp/core"; // re-exported by the CLI package too

export default defineConfig({
  // discovery
  include: ["**/*.e2e.md"], // default
  exclude: ["**/node_modules/**", "**/runs/**", "**/dist/**"], // always merged in
  // target
  baseUrl: "http://127.0.0.1:3000",
  allowedOrigins: ["http://127.0.0.1:3000"], // navigation policy; baseUrl origin always allowed
  // data
  inputs: { projectName: "Project {{ run.id }}" }, // project-level defaults (lowest priority)
  // registries — names referenced by specs resolve HERE, never as import paths
  fixtures: { "authenticated-workspace": myFixture },
  checks: { "project-unique-in-storage": myCheck },
  scripts: { healthy: myScriptFactory }, // scripted adapter only — see §11
  // model
  provider: "scripted" | "anthropic",
  model: "claude-sonnet-5", // provider-specific id, never hardcoded in core
  providerOptions: { maxTokens: 2048, script: "healthy" }, // scripted adapter: names an entry of `scripts`
  // guidance vs budgets  (SEPARATE — see §7)
  maxActions: 25, // INDICATIVE ONLY
  budgets: {
    attemptTimeoutMs: 120_000,
    operationTimeoutMs: 15_000,
    maxModelCalls: 40,
    maxTokens: 200_000,
    verifierReserveTokens: 20_000, // a POOL for the final evaluation — see §7
    fixtureSetupTimeoutMs: 60_000, // bounds EVERYTHING before the browser opens
    fixtureCleanupTimeoutMs: 15_000,
    maxIdleTurns: 3, // consecutive model turns with no tool call
    maxEvidenceRequests: 1, // "needs more evidence" answers per criterion
    modelCallRetries: 2, // retryable model-call failures retried per call — see §7
  },
  capture: {
    trace: "on" | "off", // default "on"
    video: "on" | "off", // default "off"
    screenshots: "checkpoints" | "every-action" | "off", // default "checkpoints"
    retainTraceOn: "all" | "failure", // default "all"
  },
  outputDir: "runs",
  reporters: ["console"],
});
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
the loader and be rejected. `difmp.config.ts` is loaded as trusted project code (see api-tooling.md for the
TS loader); its path comes from `--config` or upward lookup from cwd, NEVER from a spec.

**Config filename.** Discovery accepts exactly one basename, `difmp.config.{ts,mts,mjs,js}`, with
`.ts` tried first. A deeper directory wins over a shallower one during the upward walk. A
`harness.config.*` left over from the tool's former name is an ordinary file and is NOT loaded — the
run falls back to the built-in defaults rather than silently adopting settings nobody asked for.
`configFileNames` in `apps/cli/src/loadConfig.ts` is the single source of that list; the fixture
`apps/cli/test/fixtures/stray-harness-config/` pins the ignoring.

## 4. Spec → contract

```ts
// frontmatter (Schema, unknown keys rejected, duplicate YAML keys rejected)
{ version: 1, id: string, tags?: string[], fixture?: string, timeout?: string|number,
  maxActions?: number, inputs?: Record<string, string|number|boolean>,
  verification?: string, checks?: Record<criterionId, checkName> }
```

Expectations come from EITHER `verification` OR a `## Expected results` Markdown section — never
both (hard error). The heading is matched case- and accent-insensitively; `## Résultats attendus`
is still accepted as an undocumented compatibility alias for specs written before the repository
became English-only. Splitting rule: top-level Markdown list ⇒ one criterion per item; no list ⇒
the whole paragraph block is one criterion.

```ts
interface ScenarioContract {
  schemaVersion: 1;
  specPath: string; // relative to the config root
  id: string;
  tags: string[];
  fixtureName?: string;
  body: string; // interpolated Markdown body
  criteria: Array<{
    id: string; // "c1"
    text: string; // interpolated, VERBATIM contract text
    sourceText: string; // pre-interpolation
    line: number;
    column: number;
    method: "model" | "code";
    checkName?: string; // when method === "code"
  }>;
  inputs: Record<string, string | number | boolean>; // resolved
  maxActions: number;
  budgets: Budgets;
  hashes: {
    spec: string;
    contract: string;
    criteria: Record<string, string>;
    prompts: Record<string, string>;
  };
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

| tool         | params                                          | notes                                                                |
| ------------ | ----------------------------------------------- | -------------------------------------------------------------------- |
| `observe`    | `{}`                                            | returns `{ observationId, url, title, snapshot, elements[] }`        |
| `navigate`   | `{ url, intent? }`                              | rejected unless origin ∈ allowedOrigins                              |
| `click`      | `{ observationId, ref, intent? }`               |                                                                      |
| `fill`       | `{ observationId, ref, value, intent? }`        |                                                                      |
| `press`      | `{ observationId?, ref?, key, intent? }`        |                                                                      |
| `scroll`     | `{ direction: "up"\|"down", amount?, intent? }` |                                                                      |
| `screenshot` | `{ label?, fullPage? }`                         | mints an artifact                                                    |
| `check`      | `{ criterionId, note? }`                        | triggers evidence collection + evaluation; agent supplies NO verdict |
| `finish`     | `{ summary? }`                                  | triggers FINAL verification; never sufficient for success            |

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
`browserContextOpened`, `observationTaken`, `modelCallStarted`, `modelCallFinished`,
`modelCallRetried` (carries `role`, the logical `callId` when the browsing loop is the caller,
the 1-based `attempt`, the `delayMs` it waits, and the `reason` — emitted once per retried
attempt of a model call the provider reported as retryable; see §7), `actionStarted`,
`actionFinished`, `evidenceRequested`, `verificationFinished`, `artifactAvailable`,
`actionGuidanceExceeded`, `budgetExhausted`, `progressStalled`, `error`,
`cancellationRequested`, `runFinished`.

Action events carry `actionId`; verification events carry `criterionId`; evidence links via
`artifactId` and `sourceSeq`. Writes are serialised through a single queue to preserve order; a
truncated last line is tolerated on reload and reported as "not finalised".

`runFinished` is the LAST line of a finished run's journal — including a cancelled or interrupted
one. Nothing the harness started may be journalled after it.

The live fan-out (`RunStore.events`, a `dropping` PubSub so a slow subscriber can never block a
journal write) is SHUT DOWN when the run's scope closes. A subscriber parked in `PubSub.take`
otherwise never learns the run ended, and the process hangs on it at SIGTERM with an SSE connection
open (api-effect-http-node.md §6). Every `actionStarted` is paired with an `actionFinished`, even
when a cancellation interrupts the action mid-flight.

## 7. maxActions vs blocking budgets — DO NOT CONFLATE

`maxActions` counts **accepted browser tool calls** (observations, screenshots and failed attempts
included). Model calls and verification operations are counted SEPARATELY and never against it.
On the FIRST crossing only: emit `actionGuidanceExceeded`, surface `"28 actions / 25 suggested"`,
and inject one short nudge into the agent conversation. Nothing is refused, no status is degraded,
no approval is required. A run that passes in 40 actions is `passed`.

Blocking budgets are the separate, configurable ones in §3 `budgets`. Exhausting one ends the loop
and yields `inconclusive` (not `failed`) **for every criterion it stopped the run from concluding**,
with no late actions or requests permitted afterwards. A run whose criteria had all already resolved
when the budget fired keeps its verdict — spec §9 says a blocking budget is exhausted _before a
conclusion could be reached_, and `aggregate.ts` implements that reading: the budget is not itself a
verdict.
The agent is TOLD these budgets in its system prompt, next to the indicative threshold and
explicitly distinguished from it (spec §6 step 5).

**Every blocking limit lives in `budgets` — there are no hidden ones.** If the harness stops doing
something because a threshold was reached, that threshold is a `budgets` key, is printed with the
resolved configuration, is frozen into `contract.budgets`, is recorded in `manifest.json`, and
exhausting it emits `budgetExhausted` with a matching `BudgetKind`
(`attemptTimeout` · `operationTimeout` · `fixtureSetupTimeout` · `maxModelCalls` · `maxTokens` ·
`maxIdleTurns`). Two limits used to be hardcoded and are now declared:

- `fixtureSetupTimeoutMs` bounds everything that happens before the attempt body — inputs, fixture
  setup, contract freeze. `attemptTimeoutMs` wraps the attempt only, so without this a fixture that
  never returns hung the run forever.
- `maxIdleTurns` ends the browsing loop after N consecutive model turns that called no tool.
  `progressStalled` is still EMITTED (spec §7), and the budget is what ends the loop; the run is
  `inconclusive`, never `failed`.
- `maxEvidenceRequests` caps how many times ONE criterion may come back as "needs more evidence"
  before the verifier settles for `inconclusive`.
- `modelCallRetries` caps how many times ONE model call is re-attempted when the provider reports
  the failure as retryable (a 429 with `Retry-After`, a 5xx, a transport blip). It is the one
  NON-blocking member of `budgets`: exhausting it emits no `budgetExhausted` and changes no
  verdict — the call simply fails with the error that triggered the retries, exactly as it did
  before retries existed. Each retry journals `modelCallRetried` and waits 250 ms doubling,
  capped at 4 s, overridden by a provider-reported `retryAfterMs`. Retries are TRANSPORT-level:
  they happen before any tool has run, never replay a browser action, and the logical call still
  counts ONCE against `maxModelCalls`. The policy is implemented in the runner, applied to the
  browsing call and to a verifier evaluation alike; `ProviderError.retryable` /
  `VerifierError.retryable` is the seam the decision reads.

**Late work after a budget is exhausted — the exact rule.** "No late actions or requests" binds the
AGENT and the MODEL: after `budgetExhausted` there is no further agent tool call and no further
model call. It does NOT bind harness-initiated evidence capture for the FINAL evaluation: the
runner still takes the checkpoint screenshot it needs to evaluate a criterion, so `artifactAvailable`
events legitimately follow `budgetExhausted`. This is the deliberate reading — evidence the report
cites must exist, and refusing to capture it would make an already-inconclusive run unexplainable —
and it is the one the code implements.

**Cancellation and interruption.** A cancellation (the Deferred the CLI/dashboard completes) is
RACED against the in-flight model call, the tool dispatch loop and the final verification loop, and
the `AbortSignal` that race interrupts is threaded into the provider, the verifier, the browser
driver, a fixture's setup and a TS check. Observation MUST stop (the race wins; the harness moves
on). Aborting the in-flight HTTP or Playwright call is required when the client accepts a signal,
and **best-effort** when it cannot (today: `jev-use` has no public `AbortSignal` — the verifier
abandons the observation and swallows a late rejection). Interrupting the run fiber (Ctrl-C, a
supervisor) is treated as a cancellation too. Either way the finalize tail — aggregate the outcome,
run the fixture cleanup, write `result.json`, journal `runFinished` — is UNINTERRUPTIBLE and always
runs, because §9 requires the result file to exist and §12 maps exit 130 off it. Everything inside
that tail is separately bounded (`fixtureCleanupTimeoutMs`, the driver's own finalizer deadline),
so it cannot wedge. `Effect.exit` does not catch interruption in Effect v4 — `Effect.onExit` /
`Effect.uninterruptibleMask` are the constructs that make this hold. The process's signal handling
belongs to the runtime alone: the driver launches Playwright with
`handleSIGINT/handleSIGTERM/handleSIGHUP: false`, because Playwright's own handlers call
`process.exit()` and would kill the run before the tail could run (api-playwright.md §launch). A
cancelled attempt settles its evidence like any other: the trace, the console and network logs are
captured AND recorded in `artifacts.json`.

`verifierReserveTokens` is a **pool**, not a subtraction, and that is two rules:

1. the browsing loop is refused a new model call once the run has consumed
   `maxTokens - verifierReserveTokens`;
2. the verifier may always spend up to `verifierReserveTokens` of its own, **whatever** the
   browsing loop ended up consuming.

Rule 2 is what makes the reserve real. Every budget is checked BEFORE a call and a turn's cost is
only known after it, so a single oversized browsing turn can cross the ceiling of rule 1; without
rule 2 the final verification would then be denied, every criterion would come back
`inconclusive`, and the reserve would have reserved nothing. The price is explicit: when a browsing
turn overshoots, total spend can exceed `maxTokens` by that overshoot plus the reserve. Verifier
tokens are still counted in `maxTokens` accounting and reported as `model.verifierTokens`.

## 8. Verification and result

```ts
interface CriterionResult {
  criterionId: string;
  criterionHash: string;
  status: "pending" | "passed" | "failed" | "inconclusive" | "error";
  method: "model" | "code";
  evaluator:
    | {
        kind: "model";
        provider: string;
        model: string;
        confidence?: number;
        confidenceFrom?: "reported" | "estimated";
      }
    | { kind: "scripted-model" }
    | { kind: "code"; checkName: string };
  expected: string;
  observed: string;
  evidence: string[]; // artifactIds, MUST exist, belong to this attempt AND be persisted
  limitations?: string;
  absence?: "uncertain-navigation" | "established-at-checkpoint";
  // Every status the HARNESS imposed on the evaluator's answer, in order. A report that shows
  // `inconclusive` must be able to name the rule that refused to conclude.
  downgrades?: Array<{
    reason:
      | "rejected-evidence"
      | "absence-uncertain-navigation"
      | "evidence-persistence-failed"
      | "verdict-already-decided";
    from: CriterionStatus;
    to: CriterionStatus;
    detail: string;
  }>;
  // Later evaluations of an already decided criterion, kept as observations (see re-check rule).
  reChecks?: Array<{
    status: CriterionStatus;
    observed: string;
    evidence: string[];
    requestedBy: "agent" | "runner";
    evaluatedAtSeq: number;
    applied: boolean; // true only when it replaced the recorded verdict
    note: string;
  }>;
  evaluatedAtSeq: number;
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
failure to persist mandatory evidence → `error`; else any criterion `failed` → `failed`;
else any criterion not resolved → `inconclusive`; else `passed`.
Individual criterion statuses are preserved in `result.json` even when the aggregate is `error`.
There is **no optional criterion**: nothing in §4's `ScenarioContract.criteria` marks one, the spec
never introduces the notion, and `policy/aggregate.ts` fails the run on _any_ `failed` criterion.
"Mandatory evidence" (below) is a different concept and is unaffected.

**Absence rule**: a locator missing after uncertain navigation ⇒ `inconclusive`. A locator
established as absent at the checkpoint the criterion names (page loaded, list rendered, settled)
⇒ `failed`. Implement this distinction explicitly and record which branch was taken.
The evaluator's `absence` field is a CLAIM, never the decision: the runner re-derives the branch
with `classifyAbsence` from what the driver reported (`NavigateResult.settled` for the last
navigation, and whether an observation was taken since), an evaluator that reports
`uncertain-navigation` itself can never obtain the established branch, and the branch RECORDED on
the result is the harness's. Only a `failed` resting on an uncertain absence is downgraded, and the
downgrade is recorded. An interaction-driven navigation reports no settling, so what follows it is
uncertain until the page is navigated to and observed again.

**Re-`check` rule**: `passed` and `failed` are terminal. A later `check` by the agent on a terminal
criterion is evaluated, but the result is recorded as an entry in `reChecks`, not as a replacement:
it only replaces the recorded status when it is strictly WORSE (`passed` < `inconclusive` < `error`
< `failed`). So a regression observed later is never hidden, and a `failed` can never become
`passed` because the agent asked again (spec §9, "do not lose that information").
`inconclusive` and `error` are not decisions — re-evaluating them replaces them in either
direction, which is how an agent that captured the missing evidence settles a criterion. The
runner's own final pass evaluates `pending` criteria only.

**Mandatory evidence** (spec §13): the evidence the harness itself needs in order to conclude a
criterion — the checkpoint capture taken when the criterion is evaluated (unless
`capture.screenshots: "off"`), and the payload a TS check journals through `recordEvidence`. If one
of those could not be persisted, the criterion cannot be `passed` (it is downgraded to
`inconclusive` with the reason attached), a `failed` keeps its verdict with the failure recorded as
a limitation, and the attempt sets the execution error that makes the run `error` per the
aggregation order above. Artifacts whose inventory state is not `present` are not citable evidence:
`RunStore.attemptArtifacts` returns persisted artifacts only.

## 9. Run directory

```
runs/<run-id>/
  manifest.json    # resolved non-sensitive config, dep versions, model identity, hashes, adapter id
  spec.e2e.md      # verbatim copy of the source spec
  contract.json    # ONLY once the freeze succeeded
  events.jsonl
  result.json
  report.html
  junit.xml
  artifacts.json   # inventory: every expected artifact with state present|missing|failed + reason
  attempts/<attempt-id>/{trace.zip,screenshots/,video.webm,console.jsonl,network.jsonl}
```

Result files are written by atomic replace (temp file + rename); a write that fails removes its own
temp file, so the directory only ever holds the layout above. Missing optional artifacts are listed
in `artifacts.json` with a reason — a capture failure is never hidden.

**An artifact the inventory refused is not an artifact.** If the `artifacts.json` write itself
fails, the record is rolled back out of the store (so `attemptArtifacts` and the in-memory inventory
never claim what the file does not hold), it does not enter the evidence index — no evaluator can
cite it and `result.json` cannot reference an id the file never received — and the failure is
journalled as an `error` (`stage: "evidence"`, `fatal: false`). Where the capture was MANDATORY
evidence (a checkpoint capture, a check's probe payload) the criterion is demoted by the
mandatory-evidence rule of §8, exactly as if the capture itself had failed.

`manifest.json` is written **twice**, and carries a `stage` saying which write it is:

- `stage: "initial"` at spec §6 step 2, right after the ids are minted and BEFORE fixture setup and
  the contract freeze. It has no `hashes` — nothing is frozen yet. This is why it is the mandatory
  file: a run that dies in infrastructure setup is still attributable to an adapter and a config.
- `stage: "final"` once the contract is frozen, adding `hashes` and the contract's `scenarioId`.

`contract.json` is therefore OPTIONAL to a reporter, and its absence is itself the information:
`ReportInput.contract` is `undefined`, the report carries no criteria, and both `junit.xml` and
`report.html` are still produced — one run-level `<error>` naming the infrastructure failure. An
infrastructure failure that reports nothing is indistinguishable, in CI, from a suite that never
ran.

## 10. `ModelProvider` (agent-runtime, consumed by core via a core-declared service)

```ts
interface ModelProvider {
  readonly id: string; // "anthropic" | "scripted"
  readonly modelId: string;
  generate(req: {
    role: "browser" | "verifier";
    prompt: Prompt; // conversation so far
    tools?: ToolDefinition[]; // JSON-Schema derived from Effect Schema
    responseSchema?: Schema; // verifier: structured object
    signal?: AbortSignal;
  }): Effect<ProviderResponse, ProviderError>;
}
interface ProviderResponse {
  text?: string;
  toolCalls: Array<{ id: string; name: string; params: unknown }>;
  object?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
}
```

Tool calls are returned to the harness, NEVER auto-executed by the provider. The harness validates
params with Schema and applies policy before execution. Interruption must abort the in-flight HTTP
request where the provider allows it, and close resources so no late action lands.

`signal` is not optional in practice: the RUNNER always supplies one (it is the signal of the scope
that the per-operation timeout and the cancellation race interrupt), and a provider that drops it
turns a cancellation into an abandoned request. The `Verifier` seam carries the same field: it MUST
abandon the observation when the signal fires. Passing the signal through to `generate` (or the
evaluator client) so the HTTP transport is aborted is required when the client supports it, and
best-effort when it cannot — see the Jev path and `VerificationRequest.signal`.

## 11. Fixtures and TS checks (registered in config, resolved by name only)

```ts
type Fixture = (ctx: {
  runId: string; attemptId: string
  inputs: Record<string, string|number|boolean>
  secrets: (name: string) => string | undefined      // from env, never logged, never in prompts
  addCleanup: (fn: () => Promise<void> | void) => void   // registered AT ACQUISITION time
  baseUrl: string
  signal: AbortSignal                                // aborted on cancellation / fixtureSetupTimeoutMs
}) => Promise<{
  public?: Record<string, string|number|boolean>     // exposed as {{ fixture.<key> }} and to the model
  storageState?: StorageStateLike                    // PRIVATE — browser only, never to the model
  // Every secret VALUE the fixture actually read through `secrets()`. The FixtureManager
  // implementation MUST report them on the FixtureSession (`secretValues`): §13's redaction can
  // only strip values the harness was told about.
  cookies?: ...; origins?: ...
}>

type Check = (ctx: {
  runId: string; attemptId: string
  criterion: { id: string; text: string; hash: string }   // hash MUST be verified by the harness
  inputs; fixture: { public } ; baseUrl
  recordEvidence: (e: { label: string; data: unknown }) => Promise<string /* artifactId */>
  signal: AbortSignal                                // aborted on cancellation / operationTimeoutMs
}) => Promise<{ status: "passed"|"failed"|"inconclusive"; expected: string; observed: string; evidence: string[] }>
```

`signal` is not decoration. A fixture or check that ignores it is ABANDONED rather than stopped
when the run is cancelled or its deadline fires: whatever it creates afterwards has no registered
cleanup left to run it back. Pass it to every `fetch`/query you make.

`recordEvidence` is owned by the check's own scope: once the check has returned or its
`operationTimeoutMs` has fired, an outstanding call is interrupted and its promise rejects. An
abandoned check can therefore never journal `artifactAvailable` after `runFinished`, nor mutate
`artifacts.json` after `result.json` has been written.

### Scripted-adapter scripts (`scripts`, resolved by name only)

```ts
type ScriptFactory = (ctx: {
  runId: string;
  attemptId: string;
  scenarioId: string;
  specPath: string;
  baseUrl: string;
  inputs: Record<string, string | number | boolean>; // resolved, `{{ run.id }}` already substituted
  criterionIds: ReadonlyArray<string>; // source order — a script asks for `check` by id
}) => {
  agent: AgentScript;
  verdicts?: VerdictScript;
  defaultUsage?: { inputTokens; outputTokens };
};
```

A FACTORY, not a finished script: a deterministic walkthrough has to type the value the run will
really use (`Project {{ run.id }}` is only a string once the run id exists) and to name the criteria
of the spec being run. The CLI resolves `providerOptions.script` against this registry after minting
the run id and resolving the inputs, and before opening the browser. Core declares the context and
keeps the return value opaque (`ScriptFactory<A = unknown>`), so `@difmp/core` still depends on no
model SDK; `@difmp/agent-runtime` owns the returned shape. `provider: "anthropic"` ignores the
registry entirely.

Every check probe is journalled as a harness operation. Cleanup runs after success, failure AND
cancellation — INTERRUPTION included, which is a distinct branch a typed-error hook such as
`Effect.tapError` does not cover — under `budgets.fixtureCleanupTimeoutMs`, enforced both by the
`FixtureManager` implementation and, because it runs inside the uninterruptible finalize tail (§7),
by the runner itself. Without a `fixture`, open a clean context at `baseUrl` — inputs and fixture
are genuinely optional.

## 12. Exit codes (CLI)

`0` all selected scenarios passed · `1` any `failed` or `inconclusive` · `2` invalid config or
execution error · `130` user interrupt. **No spec selected is an explicit error (exit 2), never a
silent success.**

JUnit mapping: product criterion failures ⇒ `<failure>`; technical errors and indeterminate results
⇒ `<error>` with the real status preserved in the message; cancellations ⇒ `<error>` and documented.
Never emit a green `skipped` for an indeterminate result.

**Retained `harness` wire names — deliberate, and the rename does NOT touch them.** Persisted run
artifacts keep the pre-rename identifiers so `difmp report` replays a run archived before the rename
and so a CI job that already parses these keys keeps working:

| where             | name                                                                                                                                                                                                                                                                               | source                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `manifest.json`   | `harnessVersion` (the CLI's own version)                                                                                                                                                                                                                                           | `apps/cli/src/version.ts`                       |
| `junit.xml`       | `<testsuites name="harness">` and `<testsuite … hostname="harness">`                                                                                                                                                                                                               | `packages/reporting/src/junit.ts`               |
| `junit.xml`       | the whole `harness.*` property namespace — `harness.runId`, `harness.status`, `harness.specPath`, `harness.contractHash`, `harness.provider`, `harness.model`, `harness.adapter`, `harness.finalized`, `harness.actions.<attemptId>`, `harness.artifacts.{present,missing,failed}` | same                                            |
| SSE `/api/events` | the frame type `harness` wrapping each raw event                                                                                                                                                                                                                                   | `apps/cli/src/server/bus.ts`                    |
| `@difmp/core` API | `HarnessEvent`, `HarnessEventType`, `harnessEventTypes`, `HarnessConfigData`, `HarnessUserConfig`                                                                                                                                                                                  | `core/domain/events.ts`, `core/config/index.ts` |
| `difmp` API       | the three types `HarnessEvent` / `HarnessConfigData` / `HarnessUserConfig` re-exported from core, plus `harnessVersion`, `renderHarnessEvent`, `makeHarnessFrameEncoder`                                                                                                           | `apps/cli/src/index.ts`                         |

Those are the surviving uses of the old name in **data the tool writes and in the API it exports**.
Everywhere else "harness" is only the common noun for this kind of tool. Two things are explicitly
NOT on the list: the config basename (see §3 — `harness.config.*` is no longer discovered) and the
CLI binary, package and workspace scopes (all `difmp` / `@difmp/*`).

## 13. Security hygiene

Escape everything that reaches HTML (spec text, model text, page text, logs). Redact known secret
values from textual logs and prompts. Do not claim traces/videos/DOM are anonymised — document the
limitation and use synthetic fixture data. The origin allow-list is a tool-level check, not network
isolation — document that too.

**What "known secret" means, concretely** (`packages/core/src/policy/redact.ts`):

- the secret VALUES a fixture read through `ctx.secrets`, which the `FixtureManager` reports back on
  `FixtureSession.secretValues` — the harness can only redact what it was told about. Core exports
  `recordingSecrets(read)` for exactly this: wrap the env accessor, hand `secrets` to the fixture,
  return `values()` on the session;
- every string parked under a sensitive key (`secret`, `token`, `password`, `apiKey`, `authorization`,
  `cookie`, `sessionId`, …) anywhere inside `providerOptions`.

`sanitizeConfig` blanks those values (`[redacted]`, the key itself stays visible) before the config
reaches `manifest.json` and the `configResolved` event, so "resolved NON-SENSITIVE config" is
enforced rather than trusted — `providerOptions` is an open `Record<string, unknown>`.
The runner then applies the redactor to: the fixture's `public` values BEFORE interpolation (so a
leaked secret never enters the contract text or its hash), the browser system prompt, every page
observation (once, at the boundary — the same value is what the model sees, what is written next to
the attempt and what the verifier later reads), the fixture values handed to the verifier, and every
journalled event (which covers `result.json`, the live stream and the HTML report).
With no known secret the redactor is the identity function: nothing is guessed, and a value that was
never declared as a secret is never mangled. Traces, videos and DOM dumps remain out of reach — that
is a documented limitation, not something the redactor claims to cover.

---

## 14. Decision record — the questions the critic pass raised, and how they were settled

Every item below was an OPEN question while this file was being written. All seven are now decided
**and implemented**; this section is kept as the record of what was chosen and why, not as a to-do
list. Each row names the section above that is authoritative and the code that implements it.

1. **Is `ModelProvider` (§10) a real abstraction, or just a swapped `LanguageModel` layer?**
   **Decided: keep §10.** `effect/unstable/ai` is part of `effect` itself, not a vendor SDK, so
   `LanguageModel.LanguageModel` under `ModelProvider` does not violate "core depends on no model
   SDK", and the scripted and Anthropic adapters share the whole loop, prompt plumbing, usage
   accounting and tool typing — only the `LanguageModel` layer differs. §10 is kept because the
   runner needs three things the `LanguageModel` shape does not carry: `role: "browser" |
"verifier"` (which budget accounting and the journal both key on), an explicit `AbortSignal` for
   the cancellation race, and a `ProviderResponse` whose `toolCalls` arrive in wire shape for the
   harness to validate. One interface, one implementation (`makeLanguageModelProvider`), both
   providers. `packages/core/src/services/model.ts`; rationale in `../architecture.md` §2.

2. **`observationId` + element `ref` lifetime.** **Decided and stated in §5:** exactly one
   `observationId` is live per attempt; a ref from an older one is rejected **without touching the
   page**, as a typed tool error telling the agent to re-observe; the rejection is double-gated
   (runner and driver, the driver also treating `locator.count() > 1` as ambiguity); and `observe`
   is the only caller of `ariaSnapshot` in the codebase, because any default-mode `ariaSnapshot`
   anywhere disarms every outstanding ref. Tracing is therefore configured without `aria: true`.

3. **`timeout: 90s` has no parser.** **Decided: adopt the normaliser, accept both forms.** Effect's
   `Duration` parser rejects the abbreviated form the spec's own example uses, so
   `packages/core/src/spec/duration.ts` normalises first: `90s`, `2m`, `1500ms`, `90 seconds` and a
   bare number of milliseconds are all accepted. Recorded in §4.

4. **`artifactId` / `observationId` / `actionId` counters vs UUIDv7.** **Decided: keep `art_<seq>`**
   as §2 specifies. The event writer already owns the per-attempt counter, which was the stated
   condition for keeping it, so the shared-state objection does not apply.

5. **Does the aggregate `passed` require every criterion, or only "mandatory" ones?**
   **Decided: every criterion.** The word "obligatoire" is dropped — there is no optional criterion
   in the model and the spec never introduces one. §8 now says "any criterion `failed`", which is
   what `packages/core/src/policy/aggregate.ts` implements.

6. **Where does `maxActions` counting live?** **Decided: in the tool dispatcher, before parameter
   validation and before the policy check.** That is why a refused stale reference and a
   policy-rejected `navigate` (disallowed origin) both still count — the counter must not be
   escapable by sending an invalid call. §7 defines what is counted; `../architecture.md` §2
   (`disableToolCallResolution: true`) explains why the harness, not the SDK, executes tool calls.

7. **`report` (§12) must render without a model call and without the run's original config.**
   **Decided and implemented:** `difmp report <run-directory>` reads `result.json`, `contract.json`
   and `artifacts.json` only, and `manifest.json` is the sole source of "which adapter was used", so
   the reporter never re-resolves configuration. §9 states it; the packaging smoke matrix
   (`apps/cli/scripts/consumer-smoke/run.sh`) asserts the rebuild in every consumer cell.

The one contract question that is still genuinely **open** is not in this list — it is the
`contractFrozen` payload gap, stated at the end of §15.

The API facts these decisions rest on are the compiled cheat-sheets next to this file: run ids and
sha256 via `Crypto.Crypto` (api-effect-core.md §A2), cancellation with finalizer-ordering guarantees
(api-effect-core.md §A3 / api-effect-http-node.md §C2), frontmatter field→line mapping
(api-tooling.md §A-L), `--inputs-file` typed decoding (api-tooling.md §A-I), tool JSON-Schema
emission (api-effect-ai.md §B1), and aria-ref lifetime (api-playwright.md §2).

---

## 15. Live-UI ↔ CLI HTTP surface (added by the `apps/ui` lane)

`apps/ui` is built by `vite build` to `apps/ui/dist` (`base: "./"`), so the CLI may mount it at any
path. Every URL the app uses is RELATIVE to the page, and the CLI may override them by injecting
one script tag before the bundle:

```html
<script>
  globalThis.__DIFMP_UI__ = {
    eventsUrl: "events",
    cancelUrl: "cancel",
    contractUrl: "contract",
    artifactBaseUrl: "artifacts/",
    pricing: { currency: "USD", inputPerMillionTokens: 3, outputPerMillionTokens: 15 }, // OPTIONAL
  };
</script>
```

| route             | method | contract                                                                                                                                                                                                                                                                                             |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventsUrl`       | GET    | `text/event-stream`. One frame per journal line: `id: <seq>`, `event: <event.type>`, `data: <the full HarnessEvent as JSON>`. MUST honour `Last-Event-ID` **and** a `?lastEventId=<seq>` query parameter (see below) and replay from the journal. Send `retry:` to set the client's reconnect delay. |
| `cancelUrl`       | POST   | JSON body `{ reason: string }`. Any 2xx is treated as accepted; the UI then waits for `cancellationRequested` in the stream.                                                                                                                                                                         |
| `contractUrl`     | GET    | `contract.json` (`ScenarioContract`).                                                                                                                                                                                                                                                                |
| `artifactBaseUrl` | GET    | serves `ArtifactRecord.path` values, which are relative to the run directory.                                                                                                                                                                                                                        |

**Why the query parameter too.** `EventSource` sends `Last-Event-ID` on the reconnects _it_ drives,
but the header cannot be set from script. When the browser gives up (readyState `CLOSED`) the UI
opens a fresh `EventSource` and can only carry the cursor in the URL. Support both; they mean the
same thing.

**Replay is exclusive or inclusive — the client tolerates either.** The UI applies an event iff
`seq > lastSeq`, which is exact because `seq` increases by 1 per run (§6). A server that replays
`seq >= cursor` produces one absorbed duplicate, not a duplicated row.

**Open gap — `contractFrozen` carries criterion ids only (§6).** §11 of the spec requires the live
view to show each criterion's _text_ and its `model` vs `code` _method_ from the moment the contract
is frozen, i.e. before any `verificationFinished`. The UI therefore fetches `contractUrl`. Two ways
to close this properly, pick one:

- keep the fetch and make `contractUrl` a required CLI route (what `apps/ui` implements today), or
- widen `ContractFrozenEvent` with `criteria: Array<{ id, text, method, checkName? }>` — the UI
  already reads that field when present and prefers it over the fetch.

`pricing` is absent by default and there is no price table anywhere in core, so **cost renders as
the literal string `unavailable`** — never an estimate, never `0`.
