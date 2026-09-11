# Architecture, decisions and limitations

This is the document spec §15 asks for: how the harness is put together, **why** each decision was
taken, and — without softening — what it does not do. Read
[`internal/design-contracts.md`](internal/design-contracts.md) alongside it: that file is the
authoritative source for names and shapes, this one is the rationale and the honest account.

The specs (`docs/spec.md`) and the example scenarios are in French. The code, the comments and the
documentation are in English. That is the only language rule.

---

## 1. Package layout, and why each seam is where it is

```
apps/
  cli/                  commands, layer assembly, SSE server, console reporter, exit codes, packaging
  ui/                   React live dashboard, built to static assets the CLI serves
packages/
  core/                 schemas, spec loader, interpolation, config, registries, policy, events,
                        RunStore, the runner
  browser-playwright/   BrowserDriver impl: observations, actions, evidence capture
  agent-runtime/        ModelProvider impls (Anthropic + scripted), agent prompt, Verifier
  reporting/            JSON, JUnit, standalone HTML
examples/
  fixture-app/          the demo app and its four variants
  scenarios/            the demo specs, plus four deliberately invalid ones
  support/              the project side of the demo: config, fixture, TS check, scripted scripts
```

**`@harness/core` depends on no React, no Playwright and no model SDK.** That is the load-bearing
constraint, and every other seam follows from it. The driver, the model provider, the verifier, the
fixture manager and the reporter are `Context.Service` interfaces *declared in core* and implemented
elsewhere; core owns the decisions, the other packages own the I/O.

The reason is not aesthetic. The rules that matter — a stale element reference is refused, a
criterion with invented evidence can never pass, a blocking budget yields `inconclusive` and never
`failed`, a `failed` is not re-decided because the agent asked again — are the ones a reviewer has to
be able to read in one place and a test has to be able to exercise without a browser or a network.
All of them live in `packages/core/src/policy` and `packages/core/src/runner`, and `packages/core`'s
test suite drives the whole runner against fakes.

The split also keeps the trust boundaries visible. A model's output crosses one seam
(`ModelProvider`), a page's content crosses another (`BrowserDriver`), and both are *data* on the
other side: the system prompt states that text from the page can never grant a tool or change the
scenario, and the contract text is never re-sent from the page.

`apps/cli` is where layers are assembled, and nothing else assembles them. `apps/ui` is a static
bundle: it talks to the CLI over four relative URLs it lets the server override with one injected
script tag, so the dashboard has no knowledge of where it is mounted.

### The Effect service graph

| service | declared in | implemented by | needs |
| --- | --- | --- | --- |
| `SpecLoader` | `core/spec/loader.ts` | core | `FileSystem` |
| `RunStore` | `core/store/runStore.ts` | core | `FileSystem`, `Path` |
| `BrowserDriver` | `core/services/browser.ts` | `browser-playwright` | — |
| `ModelProvider` | `core/services/model.ts` | `agent-runtime` (`anthropic` \| `scripted`) | `LanguageModel` |
| `Verifier` | `core/services/verifier.ts` | `agent-runtime` | `RunStore`, `ModelProvider` |
| `FixtureManager` | `core/services/fixture.ts` | `apps/cli` | the config registries |
| `Reporter` | `core/services/reporter.ts` | `reporting` | `FileSystem`, `Path` |

`apps/cli/src/runOne.ts` merges `RunStore`, the provider, the driver and the fixture manager into one
`base` layer, then builds `Verifier` **on top of it** — the verifier journals a code check's probe
output through the store, so it cannot be wired from outside. Everything runs inside one
`Effect.scoped`, and scope order is the resource discipline: the browser is acquired before the
context so LIFO release closes the context first (which is what finalises a video), and
`session.finalize` is registered last so it runs first.

---

## 2. Decisions taken during implementation

### Effect v4 RC, pinned exactly

`effect@4.0.0-rc.113`, `@effect/platform-node@4.0.0-rc.113`, `@effect/ai-anthropic@4.0.0-rc.113`,
with `pnpm-lock.yaml` committed and `pnpm install --frozen-lockfile` in the documented install path.
A release candidate moves; a range would let a patch change `Effect.catch`, `Result`, `Schema.Union`
or `Context.Service` under the harness without a code change.

The cost is real and is paid deliberately: v4 is not v3, and the differences are not cosmetic
(`Effect.catchAll` → `Effect.catch`, `Either` → `Result`, no `Effect.fork`, no `Layer.scoped`,
`Context.Service` instead of `Context.Tag`, `Schema.Union`/`Tuple` taking arrays,
`Effect.timeoutOrElse` instead of `timeoutTo`). Rather than trusting recollection, every API the
harness depends on was compiled and, where it has runtime behaviour, executed; the results are the
cheat-sheets in [`internal/api-*.md`](internal), and they are the reference the code was written
against.

### `effect/unstable/cli`, `/http` and `/ai` rather than third-party libraries

Argument parsing, the HTTP server for the dashboard and the model seam all use modules shipped
*inside* `effect` itself. Three reasons:

1. **Not a vendor SDK.** `effect/unstable/ai` is part of `effect`, so putting
   `LanguageModel.LanguageModel` under `ModelProvider` does not violate "core depends on no model
   SDK" — and it means the scripted double and the real Anthropic adapter share the entire loop,
   prompt plumbing, usage accounting and tool typing. Only the `LanguageModel` layer differs.
2. **One error channel.** A third-party CLI parser or HTTP server fails with its own exceptions, and
   the exit-code mapping, the cancellation race and the uninterruptible finalize tail would have to
   bridge them. Staying inside Effect keeps every seam a `Schema.TaggedError` and every timeout an
   `Effect.timeoutOrElse`.
3. **One dependency to pin.** The `unstable` namespace moves with the RC we already pinned, rather
   than adding a second thing that can move.

`unstable` is exactly what it says. The mitigation is the exact pin plus the compiled cheat-sheets,
not optimism.

`ModelProvider` was kept as a thin core-declared interface rather than exposing `LanguageModel`
directly, because the runner needs three things the `LanguageModel` shape does not carry: a
`role: "browser" | "verifier"` that budget accounting and the journal both key on, an explicit
`AbortSignal` the cancellation race threads through, and a `ProviderResponse` whose `toolCalls`
arrive in wire shape for the harness to validate. It is one interface with one implementation
(`makeLanguageModelProvider`), used by both providers.

### `disableToolCallResolution: true` — the harness executes tool calls, not the SDK

`generateText` will happily run tool handlers itself. It must not. The harness has to increment the
action counter *before* schema validation (so a refused stale reference still counts), validate
parameters against the Effect Schema that produced the JSON Schema, apply the origin allow-list,
journal `actionStarted`, execute, and journal `actionFinished` — for every call, including the ones
it rejects. A tool executed inside the provider would bypass the counter, the policy, the journal
and the evidence capture at once.

So `disableToolCallResolution: true` is set on every `generateText`, tool calls come back to the
harness in their encoded form, and the toolkit passed to the provider exists only to derive the JSON
Schema the model is shown.

### `ariaSnapshot({ mode: "ai" })` with aria-refs as the observation mechanism

The agent never receives HTML. `observe` takes one `page.ariaSnapshot({ mode: "ai" })` and returns
the accessibility tree plus the element refs that snapshot minted; every subsequent `click`, `fill`
or `press` names an `observationId` and a `ref` from it. A model navigating by role and accessible
name is doing what a user does, and a snapshot is one or two orders of magnitude smaller than the
DOM.

Two constraints come with it, and both are enforced:

* **A ref is valid only against the most recent ai-mode snapshot in its frame.** So exactly one
  `observationId` is live per attempt; a ref from an older one is rejected *without touching the
  page*, with a typed tool error telling the agent to re-observe. The rejection is double-gated —
  once in the runner, once in the driver, which also re-checks `locator.count()` and treats `>1` as
  ambiguity. The harness must never "helpfully" click something else.
* **Any default-mode `ariaSnapshot` anywhere disarms every outstanding ref.** Playwright's own
  tracing takes one on every action when `aria: true`, which silently breaks every ref
  (`aria-ref=e7` then resolves to 0 elements — verified in `.recon/bp-t2.mjs`). Tracing is therefore
  configured with screenshots and snapshots but **never** `aria: true`, and `observe` is the only
  caller of `ariaSnapshot` in the codebase.

Playwright is also launched with `handleSIGINT/handleSIGTERM/handleSIGHUP: false`. Its own handlers
call `process.exit()`, which would kill the run before the finalize tail could write `result.json` —
and §12 maps exit `130` off that file. Signal handling belongs to the Effect runtime alone.

### The `tsx` fallback for loading a consumer's TypeScript config

`harness.config.ts` is the consumer's own code. Node ≥ 22.18 strips types natively, so a bare
`import()` is tried first — it is free and it is the future. It does not cover everything:
non-erasable TypeScript (`enum`, `namespace`, parameter properties) and consumers whose package is
CommonJS both fail. The fallback is `tsx`'s `tsImport`, which handles both.

`tsx` is a real runtime dependency of the published package, not something the consumer installs:
spec §12 forbids requiring a global loader. `.ts`, `.mts`, `.mjs` and `.js` are all accepted, and the
config path comes only from `--config` or an upward lookup from the working directory — **never** from
a name inside a spec, because the config is trusted code and a spec is not.

### YAML in strict data mode

Frontmatter is parsed with `schema: "core"`, `version: "1.2"`, `customTags: []`,
`resolveKnownTags: false`, `maxAliasCount: 20`, `uniqueKeys: true`, `merge: false`, plus our own size
caps (512 KiB per spec, 64 KiB of frontmatter). A spec is input, not code. Without
`resolveKnownTags: false` a `!!binary` or `!!timestamp` tag silently becomes a Buffer or a Date;
without `uniqueKeys` a duplicated key silently wins; `maxAliasCount` bounds alias expansion. Every
rejection names the file, the field and the line, which is only possible because the document is
parsed with a `LineCounter` and the field→position map is kept.

`timeout` accepts `90s`, `90 seconds`, `1500ms` or a bare number of milliseconds. Effect's own
`Duration` parser rejects the abbreviated form the spec's own example uses, so a normaliser runs
first rather than contradicting the spec.

### Deep subpath imports of `@effect/platform-node`, never the barrel

`@effect/platform-node`'s index re-exports `NodeRedis`, which eagerly imports `redis` — a
**non-optional peer dependency** of that package. npm and pnpm install missing peers automatically,
so the barrel appears to work; Yarn 1 does not, and an installed CLI died at startup with
`Cannot find package 'redis'` in a Yarn consumer project. The binary and the SSE server therefore
import `@effect/platform-node/NodeRuntime`, `/NodeServices` and `/NodeHttpServer` as subpaths, which
keeps `NodeRedis` — and `redis` with it — out of the module graph. Re-verified after the fix: a fresh
tarball installs and runs under npm, pnpm and Yarn 1.22.22 with no extra dependency.

(One trap worth knowing while testing this: Yarn 1 caches a local tarball by name and version, so
re-packing over the same filename silently reinstalls the previous bytes.)

### Other decisions worth knowing

* **`maxActions` is indicative; the blocking limits are `budgets`, and there are no hidden ones.**
  Crossing `maxActions` emits one `actionGuidanceExceeded`, renders `"28 actions / 25 indicatives"`
  and injects one nudge. Nothing is refused, no verdict is degraded, and a run that passes in 40
  actions is `passed`. Every threshold that actually *stops* something is a `budgets` key — including
  the two that used to be hardcoded, `fixtureSetupTimeoutMs` (which bounds everything before the
  attempt body; without it a fixture that never returned hung the run forever) and `maxIdleTurns`.
  Each is printed with the resolved configuration, frozen into `contract.budgets`, recorded in
  `manifest.json`, and emits `budgetExhausted` with a matching kind.
* **`verifierReserveTokens` is a pool, not a subtraction.** The browsing loop is refused a new model
  call at `maxTokens - verifierReserveTokens`; the verifier may always spend up to
  `verifierReserveTokens` *whatever* the browsing loop consumed. Rule 2 is what makes the reserve
  real — see §4 for the price.
* **The finalize tail is uninterruptible.** `Effect.exit` does **not** catch interruption in Effect
  v4 (proven in `.recon/critic-exit-interrupt2.ts`), so the tail that aggregates the outcome, runs
  the fixture cleanup, writes `result.json` and journals `runFinished` is wrapped in
  `Effect.uninterruptibleMask`/`Effect.onExit`, not `Effect.exit`. Everything inside it is separately
  bounded (`fixtureCleanupTimeoutMs`, the driver's finalizer deadline) so it cannot wedge.
* **Cancellation is raced, not polled.** The cancellation `Deferred` is raced against the in-flight
  model call, the tool dispatch loop and the final verification loop, and the `AbortSignal` that race
  interrupts is threaded into the provider, the verifier, the driver, a fixture's setup and a TS
  check. `.recon/critic-runner-coop.ts`, re-run while writing this document: cancel requested during
  a 3 s model call, **run settled after 213 ms**, `result.json` written, status `cancelled`.
* **`manifest.json` is written twice**, `stage: "initial"` before the fixture and the freeze and
  `stage: "final"` after it. That is what makes a run that dies in infrastructure setup reportable:
  CI gets a `junit.xml` with one run-level `<error>` instead of an empty directory. `contract.json`
  is optional to a reporter, and its absence is itself the information.
* **A terminal verdict is not re-decided by the agent.** `passed` and `failed` are decisions; a later
  `check` on such a criterion is evaluated and kept in `reChecks`, and replaces the recorded status
  only when it is strictly worse. A regression observed later is never hidden, and a `failed` can
  never become `passed` because the agent asked again.
* **The absence branch is the harness's, not the model's.** An evaluator's `absence` field is a
  claim. The runner re-derives the branch with `classifyAbsence` from what the driver reported —
  whether the last navigation settled, and whether an observation has been taken since — and an
  evaluator that reports `uncertain-navigation` itself can never obtain the established branch. Only
  a `failed` resting on an uncertain absence is downgraded, and the downgrade is recorded on the
  result so the report can name the rule that refused to conclude.
* **Redaction covers what the harness was told about, and nothing else.** The secret *values* a
  fixture read through `ctx.secrets`, and every string under a sensitive key inside `providerOptions`.
  Those are stripped from the browser prompt, every page observation, the verifier's fixture values,
  `manifest.json`, the `configResolved` event and every journalled event (so also `result.json`, the
  live stream and the HTML report). With no known secret the redactor is the identity function:
  nothing is guessed and a non-secret is never mangled.

---

## 3. Reading a run directory

```
runs/<run-id>/
  manifest.json    resolved non-sensitive config, dependency versions, model identity, hashes, adapter id
  spec.e2e.md      verbatim copy of the source spec
  contract.json    the frozen criteria: ids, interpolated text, pre-interpolation text, line/column, hashes
  events.jsonl     append-only journal, one JSON object per line, seq +1 per run
  result.json      per-criterion verdicts, downgrades, re-checks, and the aggregate
  report.html      standalone and offline
  junit.xml
  artifacts.json   every expected artifact with state present | missing | failed + reason
  attempts/a1/
    trace.zip  screenshots/  observations/  console.jsonl  network.jsonl  [video.webm]  [evidence/]
```

Read them in this order when something went wrong.

1. **`result.json`** — the aggregate and, per criterion, `status`, `expected` (the frozen contract
   text, verbatim), `observed`, the `evidence` artifact ids, and `downgrades`: every status the
   *harness* imposed on the evaluator's answer, with the reason. A report showing `inconclusive` can
   always name the rule that refused to conclude.
2. **`report.html`** — the same thing for humans, with the screenshots and snapshots inline. Open it
   directly; it needs no server and makes no network request.
3. **`events.jsonl`** — the ordered truth. `seq` increases by 1 per run, the journal is written
   *before* the live fan-out, and `runFinished` is the last line of any finished run, cancelled and
   interrupted ones included. A truncated last line is tolerated on reload and reported as "not
   finalised" rather than silently dropped.
4. **`artifacts.json`** — what was *supposed* to exist. A capture that failed is listed with
   `state: "failed"` and a reason; it is never silently absent. Only artifacts whose state is
   `present` are citable as evidence.
5. **`manifest.json`** — which adapter ran, which model, which dependency versions, and the hashes.
   This is the only source of "was this a model run or the scripted double", and `harness report`
   reads it rather than re-resolving any configuration.

### Opening the Playwright trace

```sh
npx playwright show-trace runs/<run-id>/attempts/a1/trace.zip
```

or drop the file on <https://trace.playwright.dev/>, which runs entirely in the browser. The trace
gives you the action timeline, the DOM snapshot before and after each action, the network log and the
console.

**The trace does not contain the harness's assertions.** Playwright records what the browser did;
the verdicts, the budget decisions, the evidence-integrity rules and the downgrades live in
`events.jsonl` and `result.json`. Diagnosing a failure usually means reading both: the trace for
*what the page was*, the journal for *what the harness concluded and why*.

---

## 4. Known limitations

Stated plainly. Nothing here is a to-do disguised as a feature.

### Textual verification is probabilistic

A `method: "model"` criterion is judged by a model reading the collected evidence. **It can produce
false positives and false negatives. It is not a deterministic assertion, and it is not equivalent to
one.** Two runs over the same evidence may disagree. Wording that is vague in the spec stays vague in
the judgement — the harness deliberately never turns "quickly" into a numeric threshold.

This is why every criterion result carries `method` and `evaluator`, and why they are on the report:
a reader has to be able to see, per criterion, whether a verdict came from a model, from a TS check
(`kind: "code"`, authoritative for that criterion) or from the deterministic test double
(`kind: "scripted-model"`, which can never be confused with a model judgement). Where an expectation
must be exact, bind it to a TS check with `checks: { c3: <name> }` and accept that this is the
escape hatch, not the default path.

The harness's own guarantees are about what it *refuses* to conclude, not about the model being
right: a criterion with no sufficient evidence stays `inconclusive`; a verdict citing an artifact
that does not exist or was not persisted is forced to `inconclusive`, never `passed`; `finish` alone
never declares success; an unevaluated criterion makes the run `inconclusive`.

### The origin allow-list is a tool-level check, not network isolation

`allowedOrigins` is applied to the `navigate` tool, in two places (the runner and the driver). That
is all it is. The page under test can still load third-party subresources, issue `fetch` calls
anywhere, and be redirected off-origin by the server; none of that goes through a harness tool, so
none of it is refused. There is no proxy, no container and no network namespace.

**Run scenarios in a controlled CI environment against an application you control.** Do not treat the
allow-list as a sandbox for untrusted targets.

### Traces, videos and DOM snapshots can contain sensitive data

There is **no anonymisation**. `trace.zip` holds DOM snapshots and network payloads, `video.webm`
holds whatever was on screen, `observations/` holds the accessibility trees, `network.jsonl` holds
requests and responses. The redactor described in §2 covers textual logs, prompts, events and the
report — it does **not** reach inside a trace, a video or a screenshot, and it only knows the secrets
it was told about.

The mitigations are the ones that actually work, and they are the whole of it: use **synthetic
fixture data** (the demo app generates exactly that), keep secrets in the environment and read them
through `ctx.secrets` so the harness can redact their values from what it does control, and adopt a
**retention policy** for run directories — treat them as artifacts that may contain production-shaped
data and delete them on a schedule. `capture.video: "off"` is the default, and `retainTraceOn:
"failure"` keeps traces only where they are needed.

### A scripted run tests the harness, not a model

`provider: "scripted"` is a deterministic, network-free double. It exercises the real prompt
construction, the real tool dispatch, the real policy and budgets, and real Playwright against the
demo app — so it proves the *harness* behaves as specified. **It is not evidence that a model can
navigate an application.** `manifest.json` and the report name the adapter for exactly this reason,
and scripted verdicts are labelled `evaluator.kind: "scripted-model"` so they can never be read as a
model judgement.

**No Anthropic API call has been made in this repository.** No API key is configured here. The real
adapter is implemented and its smoke-test procedure is in the README; it has not been run.

### Still open after the fix lanes

Three adversarial reviews sit in `.recon/findings/`. They were written against an earlier tree and
**most of what they raised has since been fixed** — re-verified by re-running their own probes while
writing this document: the finalize tail now survives interruption (`result.json` and `runFinished`
are written on a cancelled run); cancellation is raced rather than polled (213 ms to honour a cancel
during a 3 s model call, was ~2.9 s); a timed-out code check can no longer land a write after
`runFinished`; interrupting during fixture setup runs the registered cleanups; fixture setup is
bounded by `fixtureSetupTimeoutMs`; the `RunStore` pub-sub is shut down when the run scope closes, so
an SSE subscriber parked in `take` is released; a code check's own probe evidence is accepted, so a
`method: "code"` criterion can pass; a `failed` + `uncertain-navigation` verdict is downgraded to
`inconclusive`; a `failed` is sticky against an agent re-`check`; and a run whose mandatory evidence
could not be persisted comes back `error` with its criteria `inconclusive` instead of a clean
`passed`. Read those files as history, not as a current defect list.

What follows is what is **actually** still open. Each item was checked against the code as it stands,
not copied from the review that raised it.

* **Tool *results* are not Schema-validated at the driver boundary.** `ObserveResult`,
  `NavigateResult`, `InteractionResult`, `ScreenshotResult`, `CheckAccepted` and `FinishAccepted` are
  declared as Effect Schemas in `core/domain/tools.ts` but are used only as TypeScript types — there
  is no `decode` call on any of them anywhere. Tool *arguments* are strictly validated
  (`onExcessProperty: "error"`); the driver's return value is handed to the model as-is. The driver
  is a separate package, so this is an unchecked trust boundary rather than a tautology. Compile-time
  types make it low-risk; it is still a gap against design-contracts §5.
* **`artifacts.json` can lose an update under concurrent `recordArtifact`.** The in-memory push is
  under the store's semaphore; the serialise + temp-write + rename that follows is not, so two
  concurrent renames can land out of order. Re-run while writing this document:
  `npx tsx .recon/critic-jsonl-race.ts` → `INVENTORY on disk: 43 in memory: 100 · lost update:
  true`. The runner's own path is sequential, so it is latent there; a TS check that fires several
  `recordEvidence` calls without awaiting them can reach it. `events.jsonl` is unaffected — the same
  probe reports 200 lines, 200 unique `seq`, gapless and strictly increasing.
* **`verifierReserveTokens` cannot prevent an overshoot.** Every budget is checked *before* a call
  and a turn's cost is only known after it, so a single browsing turn larger than the remaining
  headroom crosses the ceiling. The reserve then still guarantees the final verification its own
  tokens (that is rule 2, and it is what stops the run coming back entirely `inconclusive`), but the
  price is explicit: total spend can exceed `maxTokens` by the overshoot plus the reserve. The name
  promises slightly more than the mechanism delivers.
* **The harness takes checkpoint screenshots after `budgetExhausted`.** No agent tool call and no
  model call happens after a blocking budget is exhausted — verified in the journal. But the runner's
  own final evaluation still captures the evidence it needs, so `artifactAvailable` events
  legitimately follow `budgetExhausted`. This is a deliberate reading of §7 ("no late actions or
  requests" binds the agent and the model, not harness-initiated evidence capture) and it is now
  written into design-contracts §7 — but it is a decision, not a consequence, and a reader who
  expects the letter of the earlier wording will be surprised.
* **There is no GitHub Actions workflow in the repository.** Spec §12 asks for a demonstrator
  workflow that installs the pinned Node and pnpm, runs `pnpm install --frozen-lockfile`, the
  typecheck, the tests and a scripted scenario through the distributed CLI, installs Chromium with
  its Linux dependencies and publishes artifacts even on failure. Every one of those commands is
  verified locally and documented in the README; none of them is wired into CI. `.github/` does not
  exist.
* **The dashboard's "stream unavailable / Reprendre le flux" path is untested.** The SSE resume
  contract itself is proven at the levels that matter (`Last-Event-ID` header and `?lastEventId=`
  query both replay from the right cursor; a full page reload rebuilds the timeline with no loss and
  no duplicates). But `context.setOffline(true)` does not tear down a live `EventSource` in Chromium
  over loopback, so the UI's own reconnect button could not be driven from a test. That code path has
  never executed.
* **The dashboard journal is fed from a *dropping* pub-sub.** That is the right call — a slow
  subscriber can never make the runner wait — but it means that if the recorder ever fell more than
  1024 events behind, those events would be missing from the dashboard's view. `events.jsonl` on disk
  is always complete, and the SSE sequence stays contiguous either way.
* **Smaller, and known:** `providerErrorFromDefect` in `agent-runtime/src/errors.ts` is dead code, so
  an HTTP-layer *defect* (as opposed to a typed error) from the provider surfaces mislabelled as a
  browser-stage execution error. `atomicWrite` leaves a stray `<target>.tmp-<n>` in the run directory
  if the process dies between the write and the rename; nothing sweeps them. `session.ts`'s
  post-interaction navigation probe uses `Date.now()` rather than `Clock`, so `TestClock` cannot drive
  it. `press` with a `ref` but no `observationId` skips the runner-side reference check — the driver
  refuses it, so the behaviour is correct, but the runner's guard reads as if it covered the case.

---

## 5. Deferred past the MVP

Per spec §3, these are **not** in scope and are not half-built:

open-ended exploration · compiling expectation text into assertion code · generating permanent
Playwright tests from a run · agent-browser and Playwright-CLI drivers · distributed execution ·
several browsers (Chromium only) · multi-agent · dashboard user accounts · resuming a browser session
after a crash.

Two more are deferred by the design rather than by §3: **one attempt per run** (`attemptId` is always
`a1` — the identifier space exists so retries can be added without a format change, and there is no
automatic scenario retry in the MVP, deliberately, because retrying a mutating action that may have
succeeded is worse than reporting it), and **no watch mode**.

Textual expectation evaluation is explicitly *in* the MVP — see the first limitation in §4 for what
that means in practice.
