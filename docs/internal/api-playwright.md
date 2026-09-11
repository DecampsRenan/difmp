# Playwright 1.63.0 — library API cheat-sheet (agent-driven E2E harness)

Installed: `playwright@1.63.0` / `playwright-core@1.63.0`. Bundled Chromium **153.0.8010.12**
(build `chromium-1243` in `~/.cache/ms-playwright/`). Browser launched successfully; **all output
below is real, pasted verbatim** from `.recon/pw-probe*.mjs`.

Verification status:
- `/home/ubuntu/apps/difmp/.recon/playwright.ts` — **compiles clean** under
  `npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck`.
  Every fenced `ts` block below is copied from it.
- `/home/ubuntu/apps/difmp/.recon/pw-probe.mjs`, `pw-probe2.mjs`, `pw-probe3.mjs`, `pw-probe4.mjs`,
  `pw-probe5.mjs`, `pw-probe6.mjs` — all executed with `node`; output pasted below.

Import from `"playwright"` (library). `"playwright/test"` also re-exports `chromium`, `errors`,
`selectors`, `devices`, `request`, **and `expect`** — usable without the test runner (one exception,
see §9).

---

## 1. THE HEADLINE: `page.ariaSnapshot({ mode: "ai" })` is PUBLIC in 1.63

This is the single most important finding. Three things changed vs. older Playwright:

1. **`page.accessibility` NO LONGER EXISTS.** Not deprecated — *removed*. `typeof page.accessibility`
   → `undefined`, and `grep -c "accessibility" types.d.ts` finds zero property declarations.
   Do not write `page.accessibility.snapshot()`.
2. `page.ariaSnapshot()` / `page.ariaSnapshotJSON()` exist at **Page** level (previously
   Locator-only) and are fully typed & public.
3. `mode: "ai"` is a **documented public option** — no `page._snapshotForAI()` internal needed.
   It adds `[ref=eN]` refs, `[cursor=pointer]`, and recurses into `<iframe>`s.

```ts
export const REF_RE = /\[ref=([a-z0-9]+)\]/g;

export async function snapshotForLLM(page: Page): Promise<{ yaml: string; refs: string[] }> {
  const yaml: string = await page.ariaSnapshot({ mode: "ai", boxes: false, timeout: 5_000 });
  const refs = [...yaml.matchAll(REF_RE)].map((m) => m[1]!);
  return { yaml, refs };
}

export async function snapshotJson(page: Page): Promise<unknown> {
  return page.ariaSnapshotJSON({ mode: "ai", boxes: true, depth: 10 });
}

export function refLocator(page: Page, ref: string): Locator {
  return page.locator(`aria-ref=${ref}`);           // works for iframe refs too (f1e2)
}

export async function subtreeSnapshot(loc: Locator): Promise<string> {
  return loc.ariaSnapshot({ mode: "ai" });
}
```

Exact signature (both Page and Locator, identical option bags):

```
ariaSnapshot(options?: {
  boxes?: boolean;            // append [box=x,y,width,height] (viewport CSS px)
  depth?: number;             // limit tree depth
  mode?: "ai" | "default";    // default: "default"
  signal?: AbortSignal;
  timeout?: number;           // DEFAULT 0 = NO TIMEOUT (not 30s!)
}): Promise<string>;

ariaSnapshotJSON(options?: { /* same */ }): Promise<Serializable>;
```

`mode:"ai"` semantic differences (from the .d.ts): (1) includes `[ref=eN]`; (2) **does not wait**
for an element matching the locator and **throws when no elements match**; (3) includes `<iframe>`
subtrees.

### 1a. REAL OUTPUT — `page.ariaSnapshot()` default mode

```
- heading "Task list" [level=1]
- form "New task":
  - text: Title
  - textbox "Title":
    - /placeholder: What to do?
  - text: Done
  - checkbox "Done" [checked]
  - combobox "Priority":
    - option "Low"
    - option "High" [selected]
  - button "Add task"
- list "Tasks":
  - listitem:
    - link "Alpha":
      - /url: /a
  - listitem:
    - link "Beta":
      - /url: /b
- button "Dup"
- button "Dup"
- paragraph: Some static text.
```

### 1b. REAL OUTPUT — `page.ariaSnapshot({ mode: "ai" })`

```
- generic [active] [ref=e1]:
  - heading "Task list" [level=1] [ref=e2]
  - form "New task" [ref=e3]:
    - text: Title
    - textbox "Title" [ref=e4]:
      - /placeholder: What to do?
    - text: Done
    - checkbox "Done" [checked] [ref=e5]
    - combobox "Priority" [ref=e6]:
      - option "Low"
      - option "High" [selected]
    - button "Add task" [ref=e7]
  - list "Tasks" [ref=e8]:
    - listitem [ref=e9]:
      - link "Alpha" [ref=e10] [cursor=pointer]:
        - /url: /a
    - listitem [ref=e11]:
      - link "Beta" [ref=e12] [cursor=pointer]:
        - /url: /b
  - button "Dup" [ref=e13]
  - button "Dup" [ref=e14]
  - paragraph [ref=e15]: Some static text.
```

Note: only *interactive/landmark* nodes get refs. Bare `text:` fragments and `option` children of a
`combobox` get **no ref**. `[cursor=pointer]` marks clickable elements (ai mode only).

### 1c. REAL OUTPUT — `{ mode: "ai", boxes: true, depth: 3 }`

```
- generic [active] [ref=e1] [box=8,21,1264,203]:
  - heading "Task list" [level=1] [ref=e2] [box=8,21,1264,37]
  - form "New task" [ref=e3] [box=8,80,1264,22]:
    - text: Title
    - textbox "Title" [ref=e4] [box=38,81,185,21]:
      - /placeholder: What to do?
    - text: Done
    - checkbox "Done" [checked] [ref=e5] [box=265,83,13,13]
    - combobox "Priority" [ref=e6] [box=285,82,50,19]:
      - option "Low" [box=0,0,0,0]
      - option "High" [selected] [box=0,0,0,0]
    - button "Add task" [ref=e7] [box=339,81,68,21]
  - list "Tasks" [ref=e8] [box=8,118,1264,36]:
    ...
```

`depth: 3` did **not** actually truncate this tree (depth counts from the snapshot root and this
tree is shallow). Do not rely on `depth` for token budgeting — measure the string.

### 1d. REAL OUTPUT — `ariaSnapshotJSON({ mode: "ai" })` (excerpt)

```json
[
  {
    "role": "generic", "active": true, "ref": "e1",
    "children": [
      { "role": "heading", "name": "Task list", "level": 1, "ref": "e2" },
      { "role": "form", "name": "New task", "ref": "e3",
        "children": [
          "Title",
          { "role": "textbox", "name": "Title", "ref": "e4", "placeholder": "What to do?" },
          "Done",
          { "role": "checkbox", "name": "Done", "checked": true, "ref": "e5" },
          { "role": "combobox", "name": "Priority", "ref": "e6",
            "children": [
              { "role": "option", "name": "Low" },
              { "role": "option", "name": "High", "selected": true }
            ] },
          { "role": "button", "name": "Add task", "ref": "e7" }
        ] },
      { "role": "list", "name": "Tasks", "ref": "e8",
        "children": [
          { "role": "listitem", "ref": "e9",
            "children": [ { "role": "link", "name": "Alpha", "ref": "e10",
                            "cursor": "pointer", "url": "/a" } ] }
        ] },
      { "role": "button", "name": "Dup", "ref": "e13" },
      { "role": "button", "name": "Dup", "ref": "e14" },
      { "role": "paragraph", "ref": "e15", "text": "Some static text." }
    ]
  }
]
```

Top level is an **array**. Static text fragments are **bare JSON strings** inside `children`, not
objects. Typed as `Serializable` (i.e. effectively `any`) — you must define your own zod/Schema
decoder for it.

---

## 2. `aria-ref=` selector engine — refs ARE round-trippable (with sharp edges)

`aria-ref` is a registered selector engine in `playwright-core/lib/coreBundle.js`
(`this._engines.set("aria-ref", this._createAriaRefEngine())`). Its implementation:

```js
const queryAll = (root, selector) => {
  const result = this._lastAriaSnapshotForQuery?.info?.get(selector);
  return result && result.element.isConnected ? [result.element] : [];
};
```

That one function explains every gotcha below: **refs resolve only against the single most recent
snapshot object held per frame, and only while the element is still connected.**

### REAL OUTPUT — resolving and acting through refs

```
  aria-ref=e1 -> count=1 tag=BODY text="Task list\nTitle Done \n..."
  aria-ref=e2 -> count=1 tag=H1 text="Task list"
  aria-ref=e3 -> count=1 tag=FORM text="Title Done \nLow\nHigh\n Add task"
  aria-ref=e4 -> count=1 tag=INPUT text=""
  textbox line: "    - textbox \"Title\" [ref=e4]:"
  fill() via aria-ref OK, value = typed via aria-ref
```

Refs resolve to exactly 1 element, and **full actions work through them** (`fill`, `click`, …). A
ref locator is an ordinary `Locator` — you can chain `.first()`, `.evaluate()`, `.screenshot()`.

### GOTCHA A — refs carry a frame-instance prefix `fN`, and navigation renumbers everything

```
snap1 (first load):        ["e1","e2","e3","e4"]
snap2 (after page.goto):   ["f1e1","f1e2","f1e3","f1e4"]
refs after 2nd renav:      ["f2e1","f2e2","f2e3","f2e4", "f3e1","f3e2","f3e3"]
refs after 3rd renav:      ["f4e1","f4e2","f4e3","f4e4", "f5e1","f5e2","f5e3"]
old ref e1 count now: 0
```

The main frame gets **no prefix on its first document only**; every subsequent document gets
`f1`, `f2`, `f4`… **A regex of `/\[ref=(e\d+)\]/` silently matches ZERO refs after the first
navigation.** Use `/\[ref=([a-z0-9]+)\]/`.

Upside: stale refs can never collide with fresh ones — a stale ref just yields `count === 0`.

### GOTCHA B — a `mode:"default"` snapshot **destroys** all ref resolution

```
  using ref e1 -> count before: 1
  count after DEFAULT-mode ariaSnapshot(): 0
  count after locator.ariaSnapshot (default): 0
```

Any `ariaSnapshot()` **without** `mode:"ai"` (Page *or* Locator) overwrites
`_lastAriaSnapshotForQuery` with a ref-less tree and disarms every outstanding ref.
**Rule for the harness: never mix default-mode and ai-mode snapshots on the same page.**

### GOTCHA C — refs ARE stable across repeated ai-snapshots and across DOM mutation

```
refs again: ["e1","e2","e3","e4","f1e1","f1e2","f1e3"] | identical snapshot string: true
```

Two consecutive `mode:"ai"` snapshots with no page change produce a **byte-identical string**
(cheap to diff). After a DOM mutation, surviving elements keep their refs and a new element gets a
fresh number (`e6` — note `e5` was skipped, numbering is not gap-free):

```
- generic [ref=e1]:
  - heading "P" [level=1] [ref=e2]
  - button "Click me" [active] [ref=e3]
  - iframe [ref=e4]:
    - generic [ref=f1e1]:
      - button "Inner" [ref=f1e2]
      - paragraph [ref=f1e3]: frame text
  - link "New link" [ref=e6] [cursor=pointer]:
    - /url: /x
```

A ref survives repeated actions on the same node without re-snapshotting:
```
  after 1 click, same ref count: 1
  after 2nd click via same ref count: 1
```
But it dies if the node is **replaced** (`isConnected === false`):
```
  after replacing the button node, old ref count: 0
```

### GOTCHA D — iframe refs resolve from the PAGE-level locator (no `frameLocator` needed)

```
  frame-prefixed refs: ["f1e1","f1e2","f1e3"]
   page.locator(aria-ref=f1e1) count=1
   page.locator(aria-ref=f1e2) count=1
   page.locator(aria-ref=f1e3) count=1
   via frameLocator count= 1
```

Huge for an LLM harness: one snapshot + one flat ref namespace covers the whole frame tree.

### GOTCHA E — an unknown/stale ref is NOT a distinguishable error

```
  aria-ref=e999 count: 0
  click ctor: TimeoutError2 | msg line1: locator.click: Timeout 500ms exceeded.
```

Acting on a dead ref produces a **generic TimeoutError**, not a "stale ref" error. Always
`await refLocator(page, ref).count()` first and re-snapshot on `0` rather than eating a timeout.

### Recommended harness loop

1. `const { yaml, refs } = await snapshotForLLM(page)` → give `yaml` to the model.
2. Model replies with a `ref` + action.
3. `if (await refLocator(page, ref).count() === 0) → re-snapshot, retry once`.
4. Act. **Re-snapshot (ai mode) after every action** that navigates.

---

## 3. `expect(locator).toMatchAriaSnapshot` — test-runner only

```
  toBeVisible:          PASS standalone
  toHaveText:           PASS standalone
  toHaveCount:          PASS standalone
  toHaveURL:            PASS standalone
  failing toHaveText:   THREW ExpectError :: expect(locator).toHaveText(expected) failed
  toMatchAriaSnapshot:  THREW Error :: toMatchAriaSnapshot() must be called during the test
```

`expect` imported from `"playwright/test"` works fine in library mode for every matcher **except
`toMatchAriaSnapshot`**, which hard-throws outside a `test()` body (it needs the snapshot-file
fixture). For a library harness, diff `await page.ariaSnapshot()` strings yourself.

Failing assertions throw class **`ExpectError`** (not `TimeoutError`).

```ts
export async function assertions(page: Page, loc: Locator): Promise<void> {
  await expect(loc).toBeVisible({ timeout: 5_000 });
  await expect(loc).toHaveText("text");
  await expect(loc).toHaveCount(1);
  await expect(page).toHaveURL(/\/done$/);
  // await expect(loc).toMatchAriaSnapshot('- button "Hi"');  // throws outside test runner
}
```

---

## 4. Launch + context

```ts
export async function launch(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    chromiumSandbox: false,               // preferred over --no-sandbox
    args: ["--disable-dev-shm-usage", "--disable-gpu"],
    timeout: 30_000,
    tracesDir: "/tmp/pw-traces",
    slowMo: 0,
  });
}
```

`chromiumSandbox: false` is the typed, first-class way to do what `--no-sandbox` does — prefer it
in containers. `--disable-dev-shm-usage` still matters (small `/dev/shm` in Docker).
Full `LaunchOptions` keys: `args, artifactsDir, channel, chromiumSandbox, downloadsPath, env,
executablePath, firefoxUserPrefs, handleSIGHUP, handleSIGINT, handleSIGTERM, headless,
ignoreDefaultArgs, logger, proxy, slowMo, timeout, tracesDir`.
There is **no `headless: "new"|"old"` string** — boolean only.

```ts
export async function makeContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    baseURL: "http://127.0.0.1:3000",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    storageState: undefined,               // string path | inline object
    recordVideo: { dir: "./artifacts/video", size: { width: 640, height: 360 } },
    recordHar: { path: "./artifacts/net.har", content: "embed", mode: "full" },
    serviceWorkers: "block",
    strictSelectors: true,
    timezoneId: "UTC",
    locale: "en-US",
  });
  ctx.setDefaultTimeout(10_000);
  ctx.setDefaultNavigationTimeout(20_000);
  return ctx;
}
```

`baseURL` makes `page.goto("/")` work. `viewport: null` = use the real window size.

**The two `setDefaultTimeout` calls are not optional** — in library mode there is otherwise *no*
action timeout at all and a missing element hangs forever. See §9.

### storageState — verified round-trip and isolation

```
  keys: [ 'cookies', 'origins' ]
  cookies: [{"name":"sid","value":"abc123","domain":"127.0.0.1","path":"/","expires":-1,
             "httpOnly":false,"secure":false,"sameSite":"Lax"}]
  origins: [{"origin":"http://127.0.0.1:39413","localStorage":[{"name":"k","value":"v"}]}]
  restored localStorage k = v
  restored cookie = sid=abc123
  ctx2 k after ctx3 write (isolation): v      <-- contexts are fully isolated
```

`ctx.storageState()` returns the object; `ctx.storageState({ path })` also writes the file.
`storageState` accepts either the path string or the inline object:

```ts
export async function inlineStorageState(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    storageState: {
      cookies: [{
        name: "sid", value: "abc", domain: "127.0.0.1", path: "/",
        expires: -1, httpOnly: false, secure: false, sameSite: "Lax",
      }],
      origins: [{ origin: "http://127.0.0.1:3000", localStorage: [{ name: "k", value: "v" }] }],
    },
  });
}
```

**Isolation guarantee (verified):** cookies, localStorage, cache, permissions, and service workers
are per-`BrowserContext`. Writing `localStorage` in ctx3 left ctx2 untouched. One context per test.

---

## 5. Tracing

```ts
export async function trace(ctx: BrowserContext): Promise<void> {
  await ctx.tracing.start({
    screenshots: true,
    snapshots: { dom: true, aria: true, screen: true },  // 1.63: object form
    sources: true,
    title: "run-42",
    live: false,
  });
  await ctx.tracing.stop({ path: "./artifacts/trace.zip" });
}
```

**New in 1.63:** `snapshots` accepts `boolean | { dom?, aria?, screen? }`. `snapshots: true` is a
shortcut for `{ dom: true }`. `aria: true` records an **aria snapshot on every action** — directly
useful for post-hoc agent debugging. `live: true` writes an unarchived, real-time-updating trace
instead of a zip.

**The documented limitation, quoted verbatim from `types.d.ts`:**

> The `context.tracing` API captures browser operations and network activity, but it doesn't record
> test assertions (like `expect` calls). We recommend enabling tracing through Playwright Test
> configuration, which includes those assertions and provides a more complete trace for debugging
> test failures.

So in a library-mode harness **your own assertions/steps will NOT appear in trace.zip**. Compensate
with `ctx.tracing.group(name)` / `ctx.tracing.groupEnd()` (returns a `Disposable`) around each
harness step, or write a sidecar JSON log keyed by timestamp.

### Chunks — exact ordering that works

```ts
export async function traceChunks(ctx: BrowserContext): Promise<void> {
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await ctx.tracing.stopChunk({ path: "./artifacts/step1.zip" });
  await ctx.tracing.startChunk({ title: "step2" });
  await ctx.tracing.stopChunk({ path: "./artifacts/step2.zip" });
  await ctx.tracing.stop();                 // NOTE: no { path } here
  const g = await ctx.tracing.group("Log in");
  await ctx.tracing.groupEnd();
  void g;
}
```

**GOTCHA:** after a `stopChunk`, calling `tracing.stop({ path })` throws
`tracing.stop: Must start tracing before stopping`. Use bare `tracing.stop()` to end a chunked
session; per-chunk zips come from `stopChunk({ path })`. Verified sizes: `chunk1.zip 23542`,
`chunk2.zip 25383`, and a separate plain `start`→`stop({path})` produced `full.zip 5626`.

`tracing.start({ name })` only sets the *intermediate* file prefix inside `tracesDir`; the final zip
name always comes from `stop({ path })`.

### Ordering vs. `context.close()`

```
  trace.zip exists after tracing.stop, before context.close: true 57366
```

`tracing.stop({path})` finalizes the zip **immediately** — you may call it before `ctx.close()`, and
you should (video needs `ctx.close()`, see §6).

---

## 6. Video — `context.close()` is MANDATORY

```ts
export async function shutdown(page: Page, ctx: BrowserContext, browser: Browser): Promise<string | null> {
  const video: Video | null = page.video();
  await ctx.tracing.stop({ path: "./artifacts/trace.zip" });
  await ctx.close();                                  // MUST precede browser.close()
  const p = video ? await video.path() : null;
  if (video) await video.saveAs("./artifacts/run.webm");
  await browser.close();
  return p;
}
```

REAL OUTPUT:

```
  page.video() is null? false
  video.path() resolves to: .../.recon/out/video/page@e35030235a9ad4c8702d10855d37c20a.webm
  file exists before close? true
  size before close: 0                       <-- 0 BYTES
  size after ctx.close: 9908
  path identical after close: true
```

And the failure mode you must avoid:

```
=== J. browser.close() without ctx.close(): does video survive? ===
  after browser.close() (no ctx.close), file exists: true 0     <-- 0 BYTES, VIDEO LOST
```

Rules:
- `page.video()` returns non-null as soon as `recordVideo` is set; `video.path()` resolves
  **immediately** and the file exists but is **0 bytes** until the context closes.
- **`browser.close()` without `ctx.close()` leaves a 0-byte, unusable .webm.** Always
  `await ctx.close()` first.
- `video.path()` returns the **same path** before and after close — capture it early, read it late.
- Filename is auto-generated `page@<32 hex>.webm`; you cannot choose it. Use
  `await video.saveAs(dest)` (verified working, after close) to get a deterministic name, or
  read `fs.readdirSync(dir)`.
- Order: `tracing.stop({path})` → `ctx.close()` → `video.path()`/`video.saveAs()` → `browser.close()`.

---

## 7. Console, page errors, network

```ts
export function captureConsole(page: Page, sink: ConsoleRecord[]): void {
  page.on("console", (msg: ConsoleMessage) => {
    const loc = msg.location();
    sink.push({ type: msg.type(), text: msg.text(), url: loc.url, line: loc.lineNumber, column: loc.columnNumber });
  });
  page.on("pageerror", (err: Error) => {
    sink.push({ type: "pageerror", text: `${err.name}: ${err.message}`, url: "", line: 0, column: 0 });
  });
}
```

REAL console event shape (`msg.location()` has **both** `line/column` and `lineNumber/columnNumber`):

```json
{
  "type": "log",
  "text": "hello log {a: 1}",
  "location": { "url": "http://127.0.0.1:41187/", "line": 15, "column": 8,
                "lineNumber": 15, "columnNumber": 8 },
  "argCount": 2,
  "page": true
}
```

- `msg.type()` values seen: `"log"`, `"warning"` (not `"warn"`), `"error"`.
- Browser-generated resource errors arrive as `type: "error"` with
  `text: "Failed to load resource: the server responded with a status of 500 (Internal Server Error)"`
  and `location.lineNumber === 0`, `args().length === 0`.
- `msg.args()` are `JSHandle`s — **dispose them or leak**. `msg.text()` already pre-formats objects
  (`{a: 1}`), which is usually enough for an LLM.
- `msg.page()` returns the `Page | null`.

### `page.on("pageerror")` and the NEW pull API `page.pageErrors()`

```
pageerror event: [{ "ctor": "PlaywrightError", "name": "Error",
                    "message": "boom from page", "hasStack": true }]
page.pageErrors() -> [{"name":"Error","message":"boom from page"}]
```

The handler receives an `Error` whose **runtime constructor is `PlaywrightError`** but whose `.name`
is the page-side name (`"Error"`). Don't branch on `constructor.name`.

**New in 1.63:** `page.pageErrors({ filter })` — a *pull* API returning up to the last **200** page
errors, so a harness that attaches late doesn't lose them:

```ts
export async function pullPageErrors(page: Page): Promise<Array<{ name: string; message: string }>> {
  const errs: Error[] = await page.pageErrors({ filter: "since-navigation" });
  return errs.map((e) => ({ name: e.name, message: e.message }));
}
```

`filter: "all" | "since-navigation"`. There is also `page.clearPageErrors()`.

### Context-level events (catch popups/workers too)

```ts
export function captureContextLevel(ctx: BrowserContext): void {
  ctx.on("console", (m: ConsoleMessage) => void m.text());
  ctx.on("weberror", (e) => void [e.page()?.url(), e.error().message]);
  ctx.on("request", (r: Request) => void r.url());
  ctx.on("requestfailed", (r: Request) => void r.failure()?.errorText);
}
```

Verified: `ctx.on("console")` and `ctx.on("weberror")` fire. `weberror` is the context-level
equivalent of `pageerror`: `e.page(): Page | null`, `e.error(): Error`. **Prefer context-level
listeners** — they cover pages opened later (popups) with no re-wiring.

### Network

```ts
export function captureNetwork(page: Page, sink: NetRecord[]): void {
  page.on("request", (r: Request) => {
    sink.push({ method: r.method(), url: r.url(), resourceType: r.resourceType() });
  });
  page.on("response", (r: Response) => {
    sink.push({ method: r.request().method(), url: r.url(), resourceType: r.request().resourceType(), status: r.status(), ok: r.ok() });
  });
  page.on("requestfailed", (r: Request) => {
    sink.push({ method: r.method(), url: r.url(), resourceType: r.resourceType(), status: -1, ok: false });
  });
  page.on("requestfinished", (r: Request) => { void r.timing(); });
}
```

Verified field shapes:

```json
{ "method": "GET", "url": "http://127.0.0.1:41187/api/data",
  "resourceType": "fetch", "isNavigation": false, "postData": null }
{ "status": 500, "statusText": "Internal Server Error",
  "url": "http://127.0.0.1:41187/api/boom", "ok": false, "fromServiceWorker": false }
```

`request.timing()` is **synchronous** and valid once `requestfinished` fires. Real values
(`-1` means "not applicable", e.g. a reused connection):

```json
{ "startTime": 1789144429545.472, "domainLookupStart": -1, "domainLookupEnd": -1,
  "connectStart": -1, "secureConnectionStart": -1, "connectEnd": -1,
  "requestStart": 4.495, "responseStart": 7.33, "responseEnd": 12.18 }
```

`startTime` is epoch-ms (float); every other field is **ms relative to `startTime`**.

`await request.sizes()` → `{"requestBodySize":0,"requestHeadersSize":327,"responseBodySize":27,"responseHeadersSize":155}`.
`request.failure()` → `null` or `{ errorText }`. `await req.response()` returns the identical
`Response` object instance you got from the event (`=== resp` verified true).

### Reading a response body SAFELY

```ts
export async function safeBody(resp: Response): Promise<string | null> {
  try {
    const ct = resp.headers()["content-type"] ?? "";
    if (!/json|text|javascript|xml/.test(ct)) return null;
    const buf: Buffer = await resp.body();
    return buf.subarray(0, 64 * 1024).toString("utf8");
  } catch {
    return null;                       // body evicted / redirect / request aborted
  }
}
```

Verified: `resp.body()` / `.text()` / `.json()` do **not** break the page — Chromium keeps its own
copy, so the page still receives the bytes. `body()` is **re-readable** (second call returned the
same content). Still guard with try/catch: it throws for redirects, aborted requests, and bodies
evicted from Chromium's cache. `resp.headers()` is sync & lowercased; `await resp.allHeaders()`
includes more. Verified `await resp.serverAddr()` → `{"ipAddress":"127.0.0.1","port":41971}` and
`await resp.securityDetails()` → `{}` on plain http.

---

## 8. Route interception / fault injection

```ts
export async function injectFault(page: Page): Promise<void> {
  await page.route("**/api/orders", async (route: Route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "injected" }),
      headers: { "x-injected": "1" },
    });
  });
  await page.route(/\/api\/flaky/, async (route: Route) => {
    await route.fulfill({ status: 503, json: { retryAfter: 1 } });   // `json` shorthand
  });
  await page.route("**/api/slow", async (route: Route) => {
    const real: APIResponse<Record<string, unknown>> = await route.fetch();  // real upstream
    const body = await real.json();
    await route.fulfill({ response: real, json: { ...body, patched: true } });
  });
  await page.route("**/*.png", (route: Route) => route.abort("failed"));
  await page.route("**/api/pass", (route: Route) => route.continue({ headers: { "x-trace": "1" } }));
  await page.route("**/api/next", (route: Route) => route.fallback());
  await page.unroute("**/api/orders");
  await page.unrouteAll({ behavior: "ignoreErrors" });
}

export async function contextRoute(ctx: BrowserContext): Promise<void> {
  await ctx.route("**/api/**", (r: Route) => r.continue(), { times: 3 });
}
```

REAL OUTPUT proving the injected 500 reached both the page and the `response` event:

```
   route.request().url(): http://127.0.0.1:39413/api/x method GET
   route.fetch() status: 200 body: {"v":1}
  page saw: {"s":503,"t":"{\"injected\":true}","h":"1"}

=== injected 500 response verified (page.on('response')) ===
{"status":500,"statusText":"Internal Server Error","url":".../api/boom","ok":false}
```

Key facts:
- `route.fulfill({ status, body | json, contentType, headers, path, response })`. The **`json`
  option** auto-sets `content-type: application/json` — use it, don't hand-roll.
- **`route.fetch()` returns `APIResponse<T>`, NOT `Response`.** `APIResponse<T = any>` is generic in
  1.63 (`json(): Promise<T>`) and carries `dispose()`, `timing()`, `[Symbol.asyncDispose]`. Passing
  it where a `Response` is expected is a type error. `fulfill({ response })` accepts it.
- Routes are LIFO: the **last** registered matching handler wins; `route.fallback()` passes to the
  next one; `route.continue()` sends it to the network.
- Matchers: glob string, `RegExp`, or `(url: URL) => boolean`. Globs are matched against the
  **full URL** — `"**/api/x"` not `"/api/x"`.
- `{ times: N }` auto-expires a handler — ideal for "fail the first 2 attempts, then succeed".
- `ctx.route(...)` applies to every page in the context, incl. popups.
- `page.unroute(url)`, `page.unrouteAll({ behavior })`, `page.routeFromHAR`, `page.routeWebSocket`
  all exist (verified `typeof === "function"`).
- Intercepted requests still emit `request`/`response` events with the **fulfilled** status.

---

## 9. Locators, strictness, timeouts

```ts
export async function locators(page: Page): Promise<void> {
  const byRole: Locator = page.getByRole("button", { name: "Add task", exact: true });
  const byLabel = page.getByLabel("Title", { exact: false });
  const byText = page.getByText("Alpha");
  const byTestId = page.getByTestId("add-btn");
  const byPh = page.getByPlaceholder("What to do?");
  const n: number = await byRole.count();
  const all: Locator[] = await byRole.all();
  await byRole.first().waitFor({ state: "visible", timeout: 5_000 });
  await byRole.nth(1).waitFor({ state: "attached" });
  void [byLabel, byText, byTestId, byPh, n, all];
  selectors.setTestIdAttribute("data-qa");
  const inFrame: Locator = page.frameLocator("iframe#app").getByRole("button");
  void inFrame;
}
```

Verified: `count() === 2` for two identical buttons; `all().length === 2`; default testid attribute
is `data-testid`; `getByLabel`/`getByText`/`getByPlaceholder` all resolve 1.
`waitFor({ state })` ∈ `"attached" | "detached" | "visible" | "hidden"`.
`count()` and `all()` do **not** wait — they return `0`/`[]` immediately if nothing matches.

### Error classes — REAL output

```
=== strictness violation ===
  ctor: PlaywrightError | name: Error | instanceof errors.TimeoutError: false
    locator.click: Error: strict mode violation: getByRole('button', { name: 'Dup' }) resolved to 2 elements:
        1) <button>Dup</button> aka getByRole('button', { name: 'Dup' }).first()
        2) <button>Dup</button> aka getByRole('button', { name: 'Dup' }).nth(1)

    Call log:
      - waiting for getByRole('button', { name: 'Dup' })

=== timeout ===
  ctor: TimeoutError2 | name: TimeoutError | instanceof errors.TimeoutError: true
    locator.click: Timeout 600ms exceeded.
    Call log:
      - waiting for getByRole('button', { name: 'NoSuchButton' })
```

```ts
export function classify(e: unknown): "timeout" | "strict" | "other" {
  if (e instanceof errors.TimeoutError) return "timeout";
  if (e instanceof Error && e.message.includes("strict mode violation")) return "strict";
  return "other";
}
export const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");
```

- `errors` has exactly **one** exported key: `["TimeoutError"]`. Its `.name` at runtime is the
  minified **`"TimeoutError2"`** for `constructor.name`, but `err.name === "TimeoutError"` and
  `e instanceof errors.TimeoutError` both work. **Never compare `constructor.name`.**
- `playwright.errors.TimeoutError === (await import("playwright/test")).errors.TimeoutError` → `true`.
- There is **no exported `StrictModeViolationError`**. A strict violation is a plain
  `PlaywrightError` (runtime ctor) with `name === "Error"`; detect it by the substring
  `"strict mode violation"`.
- **Error messages contain ANSI escapes** (`[2m … [22m` around the Call log). Raw JSON
  of a real message:
  `"locator.click: Timeout 400ms exceeded.\nCall log:\n[2m  - waiting for locator('#nope')[22m\n"`.
  **Strip them before feeding an error to an LLM or writing to a report.**

### Timeouts — ⚠ THERE IS NO DEFAULT ACTION TIMEOUT IN LIBRARY MODE

This is the second-biggest trap in 1.63. The `.d.ts` for every action option bag says verbatim:

> Maximum time in milliseconds. Defaults to `0` - no timeout. The default value can be changed via
> `actionTimeout` option in the config, or by using the `browserContext.setDefaultTimeout(timeout)`
> or `page.setDefaultTimeout(timeout)` methods.

`actionTimeout` is a **test-runner config** key. A library harness has no config, so unless you call
`setDefaultTimeout` yourself, **actions hang forever.** Proven:

```
A. click with no explicit timeout, no default set: STILL PENDING after 6000ms -> default is NO TIMEOUT
B. after ctx.setDefaultTimeout(1200): TimeoutError 1205ms
```

**Mandatory for the harness: call `ctx.setDefaultTimeout(ms)` immediately after `newContext()`.**
Otherwise one missing element wedges the agent loop with no error, ever.

- Per action: `loc.click({ timeout })`, `loc.waitFor({ timeout })`, `page.goto(url, { timeout })`.
- `ctx.setDefaultTimeout(ms)` / `ctx.setDefaultNavigationTimeout(ms)` — apply to all pages in the
  context, including ones created later. Also `page.setDefaultTimeout` /
  `page.setDefaultNavigationTimeout` (page-level wins over context-level).
- `timeout: 0` explicitly disables. `browserType.launch({ timeout })` **does** default to 30 000 ms
  (that one is the browser *startup* timeout only).
- `ariaSnapshot` / `ariaSnapshotJSON` likewise default to no timeout — pass one explicitly.
- Not every failure is a TimeoutError: an unreachable navigation rejects fast with a plain `Error`,
  e.g. `page.goto: net::ERR_UNSAFE_PORT at http://10.255.255.1:1/` after 22 ms.
- Many methods also take `signal?: AbortSignal` (new in 1.63) — a signal does **not** replace the
  timeout, it's additive. Useful as the harness-wide kill switch.

---

## 10. Screenshots

```ts
export async function shots(page: Page, loc: Locator): Promise<Buffer> {
  await page.screenshot({ path: "./artifacts/page.png", fullPage: true, animations: "disabled", caret: "hide", scale: "css" });
  await page.screenshot({ path: "./artifacts/clip.png", clip: { x: 0, y: 0, width: 400, height: 300 } });
  await page.screenshot({ path: "./artifacts/masked.jpeg", type: "jpeg", quality: 70, mask: [loc], maskColor: "#ff00ff" });
  return loc.screenshot({ path: "./artifacts/el.png", timeout: 5_000 });
}
```

Verified: fullPage PNG file 14947 bytes; element screenshot returned a `Buffer` of 1826 bytes;
jpeg q60 fullPage 7484 bytes; `clip` 550 bytes; `mask`+`maskColor` 6139 bytes.
Options: `animations: "disabled"|"allow"`, `caret: "hide"|"initial"`, `scale: "css"|"device"`,
`type: "png"|"jpeg"|"webp"` (**webp is supported in 1.63**), `quality` (jpeg/webp only),
`omitBackground`, `style` (inject CSS for the shot), `mask: Locator[]`, `maskColor`, `clip`,
`signal`, `timeout`. `path` is optional — always returns the `Buffer`.
`fullPage` + `clip` are mutually exclusive.

---

## 11. Clean shutdown — canonical order

```
1. await ctx.tracing.stop({ path: "trace.zip" })   // finalizes zip immediately
2. await ctx.close()                                // FINALIZES THE VIDEO
3. const p = await video.path(); await video.saveAs(dest)
4. await browser.close()
```

Skipping step 2 gives you a **0-byte video**. `page.close()` is not enough; the context is the unit
that owns the video muxer.

---

## Appendix — misc verified facts

- `chromium.launch()` → `browser.version()` = `"153.0.8010.12"`.
- `playwright/test` exports: `_android, _baseTest, _electron, _utilityTest, chromium, default,
  defineConfig, devices, errors, expect, firefox, mergeExpects, mergeTests, request, selectors,
  test, webkit`.
- `selectors.setTestIdAttribute(name)` and `selectors.register(name, script)` are both functions on
  the library-mode `selectors` singleton.
- `devices["iPhone 15"]` exists and typechecks.
- `aria-template` is a second undocumented selector engine registered alongside `aria-ref`
  (it backs `toMatchAriaSnapshot`). UNVERIFIED: whether `page.locator('aria-template=...')` is
  usable directly from the public API — not probed.
- UNVERIFIED: `tracing.start({ live: true })` output format — typechecked but not executed.
- UNVERIFIED: `page.routeWebSocket` / `page.routeFromHAR` behaviour — existence checked
  (`typeof === "function"`), semantics not probed.
- UNVERIFIED: exact `depth` truncation semantics for `ariaSnapshot` — `depth: 3` did not visibly
  truncate the probe tree.
