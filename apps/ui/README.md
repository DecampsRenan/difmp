# `@difmp/ui` — the live dashboard

A small React app that follows **one run** as it happens. `vite build` emits static assets into
`dist/`, which `apps/cli` copies into its own `assets/ui` at build time and serves from memory. There
is no server here and no build step in the consumer's project.

```sh
pnpm --filter @difmp/ui build     # or: pnpm --filter @difmp/ui dev
```

It is an **option of the runner** (`difmp run --ui`), never a requirement: a CI run starts no
server at all, and a run progresses identically with nothing attached.

## How it finds the CLI

Every URL is **relative to the page** (`base: "./"`), so the CLI may mount the bundle at any path.
The CLI overrides the four endpoints by injecting one script tag before the bundle:

```html
<script id="difmp-ui-runtime">globalThis.__DIFMP_UI__ = {
  eventsUrl: "/api/ui/events", cancelUrl: "/api/cancel",
  contractUrl: "/api/contract", artifactBaseUrl: "/api/artifacts/"
}</script>
```

`pricing` is an optional fifth field. It is absent by default and there is no price table anywhere in
the harness, so **cost renders as the literal string `indisponible`** — never an estimate, never `0`.

## What it shows, and where each part comes from

The SSE stream carries raw `HarnessEvent`s, one frame per journal line, `id:` = the event `seq`. The
criteria, however, have to be visible with their **text** and their `modèle` / `code` **method** from
the moment the contract is frozen — before any verification has happened — and `contractFrozen`
carries ids only. So the app fetches `contractUrl` on that event. It also reads a `criteria` field on
`contractFrozen` and prefers it when present, so widening that event later closes the gap without a
UI change.

Everything else is derived from the stream by a plain reducer: status, the timeline, the action count
against the indicative threshold, the blocking budgets, the artifact list and the latest screenshot.

## Resume

`seq` increases by 1 per run, so the reducer applies an event iff `seq > lastSeq` — exact, and
tolerant of a server that replays inclusively (one absorbed duplicate, not a duplicated row).

Reconnection is handled twice on purpose. `EventSource` sends `Last-Event-ID` on the reconnects *it*
drives, but that header cannot be set from script; when the browser gives up (`readyState === CLOSED`)
the app opens a fresh `EventSource` and carries the cursor as `?lastEventId=<seq>`. Both are
supported by the server and mean the same thing.

**Known gap:** the "stream unavailable / Reprendre le flux" path has never executed.
`context.setOffline(true)` does not tear down a live `EventSource` in Chromium over loopback, so that
branch could not be driven from a test. The resume contract itself is proven at the two levels that
matter — header replay, query replay, and a full page reload rebuilding the timeline with no loss and
no duplicates.

## Cancelling

The Cancel button POSTs `{ reason }` to `cancelUrl`. Any 2xx means accepted; the app then waits for
`cancellationRequested` in the stream rather than assuming. The run's finalizers still run, the
evidence is still settled, and the CLI exits `130`.
