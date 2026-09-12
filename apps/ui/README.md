# `@difmp/ui` — the live dashboard

A small React app that follows **one run** as it happens. `vite build` emits static assets into
`dist/`, which `apps/cli` copies into its own `assets/ui` at build time and serves from memory. There
is no server here and no build step in the consumer's project.

```sh
pnpm --filter @difmp/ui build     # or: pnpm --filter @difmp/ui dev
```

It is an **option of the runner** (`difmp run --ui`), never a requirement: a CI run starts no
server at all, and a run progresses identically with nothing attached.

## Tests

```sh
pnpm run test:ui                                   # or: pnpm run test, which includes it
npx vitest run --config apps/ui/vitest.config.ts   # the same thing, spelled out
```

A **component** suite, under jsdom, in four layers:

- **Per component**, rendered with Testing Library and driven through `user-event`, fed run models
  built by `test/factories.ts`: the header with its connection state and Cancel flow, the run
  context, the criteria and their method, the blocking budgets and the `unavailable` cost, the
  timeline and its filters, the artifact list, the latest screenshot, and the shared primitives
  (panel, badge, gauge, time and duration formatting). Each one is checked in every state it can
  actually reach — including the ones before any event has arrived, where the rule is that a user
  sees a dash, never `undefined`.
- **The whole dashboard** (`test/app.test.tsx`), driven through its real data path —
  `App` → `useRunStream` → `runReducer` → the panels — against a fake `EventSource` and a stubbed
  `fetch`. This is where the stream's contracts are pinned: `seq > lastSeq` dedupe across an
  inclusive resume, malformed frames counted and never rendered, the backoff takeover reconnecting
  with the cursor, cancellation, and the degradation path when `contractUrl` is unavailable.
- **The tolerant readers** (`test/runtime.test.ts`): `readRuntimeConfig`, `readContract`, and the
  URL guards. `artifactHref` gets its whole rejection surface — schemes, traversal, absolute and
  protocol-relative paths — because every URL this app renders comes from a journal written from
  model- and page-influenced data.
- **The reducer's immutability contract** (`test/reducer.test.ts`), asserted directly rather than
  through the DOM — because a reducer that writes into the state it was handed still renders
  correctly, and the damage only surfaces once something retains an earlier state or memoizes a row
  on its object identity. This is the one place in the suite where a DOM assertion cannot reach the
  rule.

The suite is mutation-checked: breaking the dedupe guard, the URL scheme gate, the cost fallback,
the gauge clamp, the pending→`inconclusive` rule, its immutability, or the malformed-frame counter
each fails a test that names the rule it broke.

It **launches no browser**. Nothing here proves the bundle loads, the SSE stream arrives or a real
run renders; that is the CLI suite's job (`apps/cli/test`), which drives a real Chromium against the
CLI actually serving this app. Two suites, two questions: this one is fast and answers "does the
component behave", the other is slow and answers "does it work in a browser, end to end".

## How it finds the CLI

Every URL is **relative to the page** (`base: "./"`), so the CLI may mount the bundle at any path.
The CLI overrides the four endpoints by injecting one script tag before the bundle:

```html
<script id="difmp-ui-runtime">
  globalThis.__DIFMP_UI__ = {
    eventsUrl: "/api/ui/events",
    cancelUrl: "/api/cancel",
    contractUrl: "/api/contract",
    artifactBaseUrl: "/api/artifacts/",
  };
</script>
```

`pricing` is an optional fifth field. It is absent by default and there is no price table anywhere in
the harness, so **cost renders as the literal string `unavailable`** — never an estimate, never `0`.

## What it shows, and where each part comes from

The SSE stream carries raw `HarnessEvent`s, one frame per journal line, `id:` = the event `seq`. The
criteria, however, have to be visible with their **text** and their `model` / `code` **method** from
the moment the contract is frozen — before any verification has happened — and `contractFrozen`
carries ids only. So the app fetches `contractUrl` on that event. It also reads a `criteria` field on
`contractFrozen` and prefers it when present, so widening that event later closes the gap without a
UI change.

Everything else is derived from the stream by a plain reducer: status, the timeline, the action count
against the indicative threshold, the blocking budgets, the artifact list and the latest screenshot.

## Resume

`seq` increases by 1 per run, so the reducer applies an event iff `seq > lastSeq` — exact, and
tolerant of a server that replays inclusively (one absorbed duplicate, not a duplicated row).

Reconnection is handled twice on purpose. `EventSource` sends `Last-Event-ID` on the reconnects _it_
drives, but that header cannot be set from script; when the browser gives up (`readyState === CLOSED`)
the app opens a fresh `EventSource` and carries the cursor as `?lastEventId=<seq>`. Both are
supported by the server and mean the same thing.

**Known gap, narrowed:** the "server unreachable / Resume the stream" path has never executed _in a
real browser_. `context.setOffline(true)` does not tear down a live `EventSource` in Chromium over
loopback, so that branch cannot be driven from the CLI suite. It _is_ covered at the component level
(`test/app.test.tsx`), where a fake `EventSource` can report `readyState === CLOSED`: the backoff,
the takeover carrying the cursor, the give-up after the maximum attempts, and the manual resume. The resume contract itself is proven at the two levels that
matter — header replay, query replay, and a full page reload rebuilding the timeline with no loss and
no duplicates.

## Cancelling

The Cancel button POSTs `{ reason }` to `cancelUrl`. Any 2xx means accepted; the app then waits for
`cancellationRequested` in the stream rather than assuming. The run's finalizers still run, the
evidence is still settled, and the CLI exits `130`.
