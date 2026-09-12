# `@difmp/browser-playwright`

The `BrowserDriver` implementation: it is the only thing in the repository that touches Playwright.

It launches Chromium, opens one isolated context per attempt, turns the page into observations the
model can reason about, executes the actions the harness authorised, and captures the evidence.
It implements an interface declared in `@difmp/core`; it makes no policy decisions of its own
beyond fail-closed guards.

## Observation: aria snapshots, not HTML

The agent never receives HTML. `observe` takes one `page.ariaSnapshot({ mode: "ai" })` and returns
the accessibility tree together with the element refs that snapshot minted. Every `click`, `fill` and
`press` then names an `observationId` and a `ref` from it.

Two constraints come with `mode: "ai"`, and both are enforced here:

* **A ref is valid only against the most recent ai-mode snapshot in its frame.** `resolveRef`
  re-checks the observation id, the ref shape, its membership and `locator.count()` — `0` is stale,
  `>1` is ambiguous — and refuses **before** touching the page, with a typed error telling the agent
  to re-observe. It never falls back to a different element. The runner gates the same thing
  independently; the two are deliberately redundant.
* **Any default-mode `ariaSnapshot` anywhere disarms every outstanding ref.** Tracing is therefore
  configured with screenshots and snapshots but **never** `aria: true` (verified in
  `.recon/bp-t2.mjs`: with `aria: true`, `aria-ref=e7` resolves to 0 elements), and `observe` is the
  only caller of `ariaSnapshot` in the codebase.

## Interruption, not abandonment

Interrupting an Effect does not cancel an underlying Promise. Every Playwright call here is wrapped
with `Effect.tryPromise` and handed the scope's `AbortSignal` — `ariaSnapshot`, `goto`, `click`,
`fill`, `press`, `screenshot` — so a cancelled run aborts the in-flight call instead of abandoning
it. The few calls without a signal are bounded by `setDefaultTimeout` /
`setDefaultNavigationTimeout`.

Resource order is the discipline: the browser is acquired before the context, so LIFO release closes
the context first (which is what finalises a video), and `session.finalize` is registered last so it
runs first. The finalize path is bounded by its own `timeoutOrElse`, and the context close is guarded
by a *separate* flag from the "no further actions" flag — otherwise a finalize cut short by its
deadline would mark the context closed without ever closing it, and lose the video.

Chromium is launched with `handleSIGINT/handleSIGTERM/handleSIGHUP: false`. Playwright's own handlers
call `process.exit()` and would kill the run before the harness could write `result.json`; signal
handling belongs to the Effect runtime alone.

## Evidence

`trace.zip`, screenshots, the aria snapshots the model actually saw, `console.jsonl` and
`network.jsonl`. A capture that fails is reported as a `CaptureOutcome` and recorded in
`artifacts.json` with a reason — never silently dropped — including on the interrupted path.

**Traces, videos and DOM snapshots are not anonymised.** See
[`docs/architecture.md`](../../docs/architecture.md) §4.

```sh
pnpm --filter @difmp/browser-playwright build
npx playwright install chromium
```
