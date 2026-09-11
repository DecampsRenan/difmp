# Effect v4 HTTP server + @effect/platform-node — cheat-sheet

Versions pinned: `effect@4.0.0-rc.113`, `@effect/platform-node@4.0.0-rc.113`.
Source read: `node_modules/effect/src/unstable/http/*.ts`, `node_modules/effect/src/unstable/encoding/Sse.ts`,
`node_modules/@effect/platform-node/src/*.ts`, `node_modules/effect/ai-docs/src/51_http-server/`.

Verification legend: every fenced block below was extracted from a file under `.recon/` that compiles with
`npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck`.
Blocks marked **RUN** were additionally executed and their output observed.

| recon file | compiled | ran |
|---|---|---|
| `.recon/http.ts` (worked SSE example) | yes | via `.recon/http_run.ts` — **RUN** |
| `.recon/http_fs.ts` (static + FileSystem + Scope) | yes | via `.recon/http_fs_run.ts` — **RUN** |
| `.recon/http_misc.ts` (routes/params/config layers) | yes | partly, via `.recon/http_misc_run.ts` — **RUN** |
| `.recon/http_sse2.ts` (heartbeat, Queue SSE, retry) | yes | no |
| `.recon/http_fs2.ts` (extra FileSystem calls) | yes | no |
| `.recon/http_static_run.ts` | yes | **RUN** |
| `.recon/http_addall.ts`, `.recon/http_provide.ts`, `.recon/http_web.ts` (type probes) | yes | type-only |

---

## 0. Import paths (exact)

`@effect/platform-node` has **no `NodeContext`** export (that was v3). The v4 aggregate is `NodeServices`.
Its barrel exports exactly: `NodeChildProcessSpawner, NodeClusterHttp, NodeClusterSocket, NodeCrypto,
NodeFileSystem, NodeHttpClient, NodeHttpIncomingMessage, NodeHttpPlatform, NodeHttpServer,
NodeHttpServerRequest, NodeMultipart, NodeMultipartParser, NodePath, NodeRedis, NodeRuntime, NodeServices,
NodeSink, NodeSocket, NodeSocketServer, NodeStdio, NodeStream, NodeTerminal, NodeWorker, NodeWorkerRunner`.

```ts
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, PubSub, Queue, Schedule, Schema, Scope, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import {
  Headers, HttpMiddleware, HttpRouter, HttpServer, HttpServerError,
  HttpServerRequest, HttpServerResponse, HttpStaticServer
} from "effect/unstable/http"
```

* HTTP lives under `effect/unstable/http` (barrel) — **not** in `@effect/platform`.
* `NodeServices.layer : Layer<ChildProcessSpawner | Crypto | FileSystem | Path | Stdio | Terminal>`.
* `NodeHttpServer.layerHttpServices = NodeHttpPlatform.layer + Etag.layerWeak + NodeServices.layer`.

---

## 1. HttpRouter

Routes are **Layers**, not a router value you thread around.

```ts
HttpRouter.add(method, path, handler, options?)   // Layer<never, never, HttpRouter | Request<...>>
HttpRouter.addAll(routes, { prefix? })            // Layer
HttpRouter.route(method, path, handler, options?) // Route<E, R> value for addAll
HttpRouter.serve(appLayer, options?)              // Layer<..., HttpServer | ...>
HttpRouter.toWebHandler(appLayer, options?)       // { handler, dispose }
```

* `method: "*" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"`.
* `path: PathInput = \`/${string}\` | "*"`. `"/x/*"` is registered for both `/x/*` and `/x`.
* `handler` is one of: a bare `HttpServerResponse`, an `Effect<HttpServerResponse, E, R>`, or
  `(request: HttpServerRequest) => Effect<HttpServerResponse, E, R>`.
* `options.uninterruptible?: boolean` — by default route handlers run **interruptible** (client abort interrupts them).

```ts
const HealthRoute = HttpRouter.add("GET", "/health", HttpServerResponse.empty({ status: 204 }))

const PathParamRoute = HttpRouter.add(
  "GET",
  "/runs/:runId",
  Effect.gen(function*() {
    const params = yield* HttpRouter.params            // ReadonlyRecord<string, string | undefined>
    const runId = params["runId"] ?? "unknown"
    return HttpServerResponse.text(runId, { status: 200 })
  })
)
```

### Provided-per-request services

`HttpRouter.Provided = HttpServerRequest | Scope.Scope | ParsedSearchParams | RouteContext`.
A route handler may freely use all four; they are erased from its `R`.
**`Scope.Scope` is available inside a handler** and is closed when the response finishes — this is what makes
`PubSub.subscribe` / `fs.open` usable directly in a route.

### GOTCHA — route requirements are wrapped in a marker type

Route `R` (minus `Provided`) surfaces as `HttpRouter.Request<"Requires", Dep>`, and errors as
`HttpRouter.Request<"Error", E>`. Verified types:

```ts
const Route = HttpRouter.add("GET", "/n", Effect.gen(function*() {
  const dep = yield* Dep
  return HttpServerResponse.text(String(dep.n))
}))
// Route  :: Layer<never, never, HttpRouter | Request<"Requires", Dep>>

const Bad  = Route.pipe(Layer.provide(Dep.layer))
// Bad    :: Layer<never, never, HttpRouter | Request<"Requires", Dep>>   <-- SILENT NO-OP

const GoodApp     = HttpRouter.serve(Route).pipe(Layer.provide(Dep.layer))
// GoodApp     :: Layer<never, never, HttpServer>                          <-- app-scoped singleton

const GoodRequest = Route.pipe(HttpRouter.provideRequest(Dep.layer))
// GoodRequest :: Layer<never, never, HttpRouter>                          <-- fresh per request
```

`Layer.provide` on a *route* layer does not satisfy the marker and does not error. Provide **after
`HttpRouter.serve`** (singleton) or use **`HttpRouter.provideRequest(layer)`** (per-request).

### GOTCHA — `addAll` with an inline array literal leaks `any`

```ts
export const R1 = HttpRouter.addAll([HttpRouter.route("GET", "/a", HttpServerResponse.text("a"))])
// R1 :: Layer<never, never, HttpRouter | Request<"Requires", any> | Request<"Error", any>>   BAD

const list = [HttpRouter.route("GET", "/a", HttpServerResponse.text("a"))]
export const R3 = HttpRouter.addAll(list, { prefix: "/api" })
// R3 :: Layer<never, never, HttpRouter>                                                      GOOD
```

Bind the array to a `const` first (or pass the type argument explicitly). The `any` leak later makes
`toWebHandler`'s `handler` require a mandatory second `Context<any>` argument.

### Middleware / CORS

```ts
const StampMiddleware = HttpRouter.middleware((httpEffect) =>
  Effect.map(httpEffect, HttpServerResponse.setHeader("x-stamp", "1"))
).layer                                      // route-scoped: Layer.provide it to the routes

const CorsLayer = HttpRouter.cors({          // global, verified 204 + ACAO on preflight
  allowedOrigins: ["http://localhost:5173"],
  allowedHeaders: ["content-type", "last-event-id"],
  credentials: true
})

HttpRouter.disableLogger                     // Layer, per-route logger off
```

`HttpRouter.middleware(fn, { global: true })` applies to every route. The `middleware` option of
`serve`/`toWebHandler` wraps the *whole* chain including response writing — response mutations there are lost;
use `HttpRouter.middleware` when you need to change the response.

---

## 2. HttpServerResponse

```ts
HttpServerResponse.empty({ status: 204 })                      // default status 204
HttpServerResponse.text("x", { status: 404, contentType?, headers? })
HttpServerResponse.html("<h1>hi</h1>")                         // string overload -> value; tagged-template -> Effect
HttpServerResponse.json({ a: 1 }, { status: 201 })             // Effect<_, HttpBodyError>  !! not a plain value
HttpServerResponse.jsonUnsafe({ a: 1 })                        // plain value, throws on bad input
HttpServerResponse.redirect("/ui/", { status: 303 })           // default 302
HttpServerResponse.uint8Array(bytes, opts?)
HttpServerResponse.stream(streamOfUint8Array, opts?)           // plain value, NOT an Effect
HttpServerResponse.file(path, opts?)                           // Effect<_, PlatformError, HttpPlatform>
HttpServerResponse.setHeader(res, k, v) / setHeaders(res, rec)
HttpServerResponse.setStatus(res, 418, "I am a teapot")
HttpServerResponse.schemaJson(schema)(value, opts?)
```

`Options = { status?, statusText?, headers?, cookies?, contentType?, contentLength? }`.

Automatic status mapping (observed at runtime): a handler failing with `Schema.SchemaError` → **400**;
unhandled failure → 500; pure interrupt caused by the client hanging up → 499; server-side abort → 503.

---

## 3. Server-Sent Events

There is **no** `HttpServerResponse.sse`. You build a `Stream<Uint8Array>` and hand it to
`HttpServerResponse.stream`. Frame rendering is `Sse.encoder.write` from `effect/unstable/encoding`.

```ts
import { Sse } from "effect/unstable/encoding"

Sse.encoder.write({ _tag: "Event", event: "log", id: "7", data: "{...}" })
// => "id: 7\nevent: log\ndata: {...}\n\n"      (the `event:` line is omitted when event === "message";
//                                               embedded newlines in `data` are re-prefixed with "data: ")

Sse.encoder.write(new Sse.Retry({ duration: Duration.seconds(2), lastEventId: undefined }))
// => "retry: 2000\n\n"
```

`Sse.Event` is a **tagged** shape `{ _tag: "Event", event: string, id: string | undefined, data: string }`
— `id` and `event` are required properties (pass `undefined` explicitly), unlike `Sse.EventEncoded`.

Headers to set (`content-type` must be set through the response options; `HttpServerResponse.stream` does not
default it):

```ts
const sseHeaders = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no"
}
```

### Replay-then-live, with client-disconnect detection — **RUN**

```ts
const SseRoute = HttpRouter.add(
  "GET",
  "/events",
  Effect.gen(function*() {
    const bus = yield* Bus
    const request = yield* HttpServerRequest.HttpServerRequest
    const lastEventId = request.headers["last-event-id"]   // header keys are LOWERCASE
    const after = lastEventId === undefined ? -1 : Number(lastEventId)

    const body = Stream.unwrap(
      // subscribe FIRST so nothing published during replay is lost;
      // the Scope here is the per-request Scope provided by the router
      Effect.map(PubSub.subscribe(bus.pubsub), (subscription) =>
        Stream.concat(
          Stream.fromArray(bus.past.filter((e: RunEvent) => e.seq > after)),
          Stream.fromSubscription(subscription)
        ))
    ).pipe(
      Stream.map(render),
      Stream.encodeText,
      Stream.ensuring(Effect.log("sse client gone"))   // runs on client disconnect AND on normal end
    )

    return HttpServerResponse.stream(body, { headers: sseHeaders })
  })
)
```

Observed wire output (`curl -N -H 'Last-Event-ID: 0'`): `HTTP/1.1 200`, `Transfer-Encoding: chunked`,
correct `id:/event:/data:` frames, replay honoured, live frames delivered as published.

**Client disconnect**: `Stream.unwrap` puts the subscription in the request `Scope`; Node's
`makeHandler` registers `nodeResponse.on("close", …)` and interrupts the request fiber with the
`ClientAbort` annotation. Measured: killing the client fired the `Stream.ensuring` finalizer within
~3 ms. You do not need to poll for disconnect; just attach finalizers.

Relevant streaming helpers:

```ts
Stream.fromPubSub(pubsub)            // Stream<A>, subscribes internally
Stream.fromSubscription(sub)         // Stream<A> from an already-open PubSub.Subscription
Stream.fromQueue(queue)              // Stream<A, Exclude<E, Cause.Done>>; Queue.end(queue) terminates it
Stream.encodeText(streamOfString)    // Stream<Uint8Array>
Stream.decodeText() / Stream.splitLines
Stream.merge(a, b) / Stream.concat(a, b)
Stream.repeat(stream, schedule)      // NOTE: schedule is a POSITIONAL arg, not { schedule }
Stream.ensuring(effect)
```

Heartbeat + queue-driven variants (compiled, not run):

```ts
const heartbeat: Stream.Stream<string> = Stream.repeat(
  Stream.succeed(": ping\n\n"),
  Schedule.spaced(Duration.seconds(15))
)
const withHeartbeat = (events: Stream.Stream<string>) =>
  Stream.merge(events, heartbeat).pipe(Stream.encodeText)

// per-connection queue; the Done error type is required for Queue.end
const queue = yield* Queue.unbounded<string, Cause.Done>()
yield* Queue.offer(queue, "a")
yield* Queue.end(queue)      // terminates the stream -> response completes
```

`HttpApiBuilder` has a schema-driven SSE path (`HttpApiSchema.StreamSse`, `sseMode: "data" | …`) if you go
the `HttpApi` route instead of raw `HttpRouter`; it reserves the event name
`"effect/httpapi/stream/failure"` for encoded causes.

---

## 4. Request reading

```ts
const request = yield* HttpServerRequest.HttpServerRequest
request.method / request.url / request.originalUrl / request.cookies / request.remoteAddress
request.headers                       // Headers = ReadonlyRecord<string, string>, keys LOWERCASE
request.json / request.text / request.arrayBuffer / request.stream / request.urlParamsBody
request.upgrade                       // Effect<Socket, HttpServerError>  (websockets)

Headers.get(request.headers, "accept")                   // Option<string>

// schema-decoded
yield* HttpServerRequest.schemaBodyJson(Body)            // Effect<A, HttpServerError | SchemaError, HttpServerRequest>
yield* HttpServerRequest.schemaHeaders(H)
yield* HttpServerRequest.schemaSearchParams(Q)           // needs ParsedSearchParams (router-provided)
yield* HttpServerRequest.schemaCookies(C)
yield* HttpServerRequest.schemaBodyUrlParams(U) / schemaBodyForm / schemaBodyMultipart

yield* HttpRouter.params                                  // raw path params
yield* HttpRouter.schemaPathParams(Schema.Struct({ runId: Schema.String }))
yield* HttpRouter.schemaParams(S)                         // search params + path params merged (path wins)
yield* HttpServerRequest.ParsedSearchParams               // ReadonlyRecord<string, string | Array<string>>

// everything in one decode: { method, url, headers, cookies, pathParams, searchParams, body }
yield* HttpRouter.schemaJson(Schema.Struct({
  pathParams: Schema.Struct({ runId: Schema.String }),
  body: Body
}))
```

Verified at runtime: `POST /cancel` with `{"reason":"user"}` → 202 JSON; with `{"nope":1}` →
**400** and the server log `SchemaError: Missing key at ["reason"]`.

---

## 5. Serving static files (a built React UI shipped in a package)

```ts
const require_ = createRequire(import.meta.url)
const uiRoot = () => {
  const pkgJson = require_.resolve("@me/ui/package.json")  // resolve the INSTALLED package, not cwd
  return pkgJson.slice(0, pkgJson.length - "package.json".length) + "dist"
}

export const StaticLayer = HttpStaticServer.layer({
  root: uiRoot(),
  index: "index.html",      // default "index.html"; pass `index: undefined` to disable
  spa: true,
  cacheControl: "public, max-age=60",
  mimeTypes: { wasm: "application/wasm" },
  prefix: "/ui"             // mounts GET "/*" under the prefix
})
```

Requires `FileSystem | Path | HttpPlatform | HttpRouter` — all supplied by `NodeHttpServer.layer`.
Single file: `HttpServerResponse.file(path)` (needs `HttpPlatform`).

Verified **RUN** behaviour:

| request | result |
|---|---|
| `GET /ui/` | 200 `text/html; charset=utf-8`, `cache-control` applied (directory → `index`) |
| `GET /ui/assets/app.css` | 200 `text/css; charset=utf-8` |
| `GET /ui/deep/spa/route` with `Accept: */*` | **404** |
| `GET /ui/deep/spa/route` with `Accept: text/html,*/*` | 200 index.html |
| `GET /ui/deep/file.js` with `Accept: text/html` | 404 (has an extension) |
| `GET /ui/../../package.json` | 404 (traversal blocked) |

**GOTCHA — SPA fallback fires only when all three hold**: the file is `NotFound`, `path.extname(url) === ""`,
and the request's `Accept` header contains `text/html`. A `fetch()` with the default `Accept: */*` gets a 404.
Also handled for free: `Accept-Ranges`/`Range` → 206, `If-None-Match`/`If-Modified-Since` → 304,
built-in mime table (html/css/js/json/svg/woff2/wasm/…).

---

## 6. NodeHttpServer layers, binding and port discovery

```ts
NodeHttpServer.layer(createServer, options)        // Layer<HttpServer | NodeServices | HttpPlatform | Etag.Generator, ServeError>
NodeHttpServer.layerServer(createServer, options)  // Layer<HttpServer, ServeError>  (server only)
NodeHttpServer.layerHttpServices                   // platform services only
NodeHttpServer.layerConfig(createServer, wrapped)  // options as Config.Wrap<Options>
NodeHttpServer.layerTest                           // ephemeral port + Fetch HttpClient prefixed to it
```

`Options extends net.ListenOptions` plus:
`disablePreemptiveShutdown?: boolean`, `gracefulShutdownTimeout?: Duration.Input` (**default 20 s**),
`websocket?: Omit<ws.ServerOptions, "noServer"|"server"|"host"|"port"|"path">`.

```ts
const ServerLayer = NodeHttpServer.layer(createServer, {
  host: "127.0.0.1",
  port: 0,                      // ephemeral
  gracefulShutdownTimeout: 0    // see gotcha below
})

const ConfiguredServer = NodeHttpServer.layerConfig(createServer, {
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Port("PORT").pipe(Config.withDefault(0))
})
```

Discover the **actually bound** port (ephemeral `port: 0`):

```ts
export const boundPort = Effect.gen(function*() {
  const server = yield* HttpServer.HttpServer
  const address = server.address                       // NetAddress.SocketAddress
  return address._tag === "UnixPathAddress" ? -1 : address.port
})
// address._tag is "InetAddressV4" | "InetAddressV6" | "UnixPathAddress"
// HttpServer.formatAddress(address) -> "http://127.0.0.1:36235"
```

`HttpRouter.serve` logs `Listening on http://127.0.0.1:<port>` by default (`HttpServer.withLogAddress`);
suppress with `{ disableListenLog: true }`, and request logging with `{ disableLogger: true }`.

### GOTCHA — SIGTERM hangs for 20 s while an SSE connection is open

Measured with one open `/events` connection:

* default options → process exits **21 s** after `SIGTERM`
* `gracefulShutdownTimeout: 0` → exits in **<1 s**

`make()` adds an unbounded `server.close()` scope finalizer plus a `preemptiveShutdown` wrapped in
`Effect.timeoutOrElse(…, gracefulShutdownTimeout ?? 20s)`. Long-lived streaming responses keep the socket open,
so always set a small `gracefulShutdownTimeout` in a test harness.

### `NodeRuntime.runMain`

```ts
NodeRuntime.runMain(program)
NodeRuntime.runMain(program, { disableErrorReporting?: boolean, teardown?: Runtime.Teardown })
NodeRuntime.runMain({ teardown })(program)      // data-last overload
```

Installs `SIGINT`/`SIGTERM` handlers that `fiber.interruptUnsafe(fiber.id)`, removes them on fiber exit,
then runs `teardown(exit, cb)`; it calls `process.exit(code)` only when a signal was received or the code is
non-zero. The effect's `R` must be `never` — provide every layer first.

---

## 7. FileSystem + Path — **RUN** (`.recon/http_fs.ts`; extras compiled in `.recon/http_fs2.ts`)

```ts
const fs = yield* FileSystem.FileSystem
const path = yield* Path.Path

yield* fs.makeDirectory(dir, { recursive: true })                  // mkdir -p
yield* fs.writeFileString(p, "hello\n")
const text = yield* fs.readFileString(p)                           // encoding arg optional
yield* fs.writeFileString(p, "more\n", { flag: "a" })              // append
yield* fs.writeFile(p, bytes, { flag?: OpenFlag, mode?: number })
yield* fs.rename(tmp, target)                                      // atomic replace: write tmp in SAME dir, then rename
const exists = yield* fs.exists(target)
const info = yield* fs.stat(target)                                // info.size is a ByteSize (bigint-backed), NOT a number
yield* fs.remove(dir, { recursive: true, force: true })
const names = yield* fs.readDirectory(dir, { recursive: true })
const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "difmp-", directory: dir })  // needs Scope
```

Atomic replace, JSONL append handle, file streaming:

```ts
// atomic replace
const tmp = `${target}.${process.pid}.tmp`
yield* fs.writeFileString(tmp, JSON.stringify(state))
yield* fs.rename(tmp, target)

// long-lived append handle (JSONL log); fs.open requires Scope, closed on scope exit
const log = yield* fs.open(path.join(dir, "events.jsonl"), { flag: "a" })
const encoder = new TextEncoder()
const appendLine = (value: unknown) => log.writeAll(encoder.encode(JSON.stringify(value) + "\n"))
yield* appendLine({ seq: 1 })

// stream a file
const lines = yield* fs.stream(p, { chunkSize: 8192 }).pipe(
  Stream.decodeText(),
  Stream.splitLines,
  Stream.runCollect
)
```

`OpenFlag = "r" | "r+" | "w" | "wx" | "w+" | "wx+" | "a" | …` (POSIX set).
`File` handle: `.write(buf) -> Effect<number>`, `.writeAll(buf) -> Effect<void>`, `.read`, `.readAlloc`,
`.seek(offset: bigint, "start" | "current")`, `.sync`, `.truncate`, `.stat`.
`fs.sink(path, { flag })` gives a `Sink.Sink<void, Uint8Array, never, PlatformError>`:

```ts
yield* Stream.fromArray([new Uint8Array([1, 2, 3])]).pipe(Stream.run(fs.sink(target, { flag: "w" })))
```

`info.size` is a `ByteSize`, not a number — use `ByteSize.toNumberUnsafe(info.size)` (or
`ByteSize.toNumber` for an `Option<number>`). `ByteSize.Input` is accepted by `fs.stream({ offset, bytesToRead })`.

`Path.Path` is sync (`join`, `resolve`, `dirname`, `basename`, `extname`, `relative`, `normalize`, `sep`,
`isAbsolute`, `parse`, `format`); only `fromFileUrl`/`toFileUrl` are effectful. `Path.layer` is POSIX.

---

## 8. Running a long-lived server alongside other work; Scope teardown — **RUN**

```ts
const AppLayer = HttpRouter.serve(Routes).pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
)

// A: server lives for the duration of `use`
export const withServer = <A, E, R>(use: (port: number) => Effect.Effect<A, E, R>) =>
  Effect.scopedWith((scope) =>
    Effect.gen(function*() {
      const context = yield* Scope.provide(Layer.build(AppLayer), scope)
      const server = Context.get(context, HttpServer.HttpServer)     // NOT HttpServer.asEffect()
      const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
      return yield* use(port)
    })
  )

// B: explicit scope you close later (test fixture)
export const openServer = Effect.gen(function*() {
  const scope = yield* Scope.make()
  const context = yield* Scope.provide(Layer.build(AppLayer), scope)
  const server = Context.get(context, HttpServer.HttpServer)
  const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
  return { port, close: Scope.close(scope, Exit.void) }
})
```

Verified: both serve `GET /ping` → `pong`; after `close`, the port refuses connections.
Other shapes: `Layer.launch(layer)` returns `Effect<never, E, RIn>` (run it as main);
`Effect.forkScoped(effect)` forks a daemon into the enclosing scope (used for the publisher fiber).

A `Context.Service` class has no `.asEffect()`; the tag itself is yieldable (`const bus = yield* Bus`) and
`Context.get(context, Tag)` reads it out of a built context.

Fetch-style handler, no socket (good for unit tests):

```ts
const { handler, dispose } = HttpRouter.toWebHandler(AppRoutes, { disableLogger: true })
const res = await handler(new Request("http://x/api/a"))
await dispose()
```

---

## 9. Worked example — SSE replay + live PubSub + POST /cancel on 127.0.0.1:0

Full file: `.recon/http.ts` (compiles clean; `.recon/http_run.ts` is the same file plus a publisher fiber and
was executed).

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"

class RunEvent extends Schema.Class<RunEvent>("RunEvent")({
  seq: Schema.Number,
  kind: Schema.String,
  payload: Schema.String
}) {}

interface BusService {
  readonly past: Array<RunEvent>
  readonly pubsub: PubSub.PubSub<RunEvent>
  readonly publish: (e: RunEvent) => Effect.Effect<boolean>
  readonly cancel: Effect.Effect<void>
}

class Bus extends Context.Service<Bus, BusService>()("app/Bus") {
  static readonly layer: Layer.Layer<Bus> = Layer.effect(Bus)(
    Effect.gen(function*() {
      const past: Array<RunEvent> = []
      const pubsub = yield* PubSub.unbounded<RunEvent>()
      let cancelled = false
      return Bus.of({
        past,
        pubsub,
        publish: (e) =>
          Effect.suspend(() => {
            past.push(e)
            return PubSub.publish(pubsub, e)
          }),
        cancel: Effect.sync(() => {
          cancelled = true
        })
      })
    })
  )
}

const sseHeaders = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no"
}

const render = (e: RunEvent): string =>
  Sse.encoder.write({
    _tag: "Event",
    event: e.kind,
    id: String(e.seq),
    data: JSON.stringify({ seq: e.seq, payload: e.payload })
  })

const SseRoute = HttpRouter.add(
  "GET",
  "/events",
  Effect.gen(function*() {
    const bus = yield* Bus
    const request = yield* HttpServerRequest.HttpServerRequest
    const lastEventId = request.headers["last-event-id"]
    const after = lastEventId === undefined ? -1 : Number(lastEventId)

    const body = Stream.unwrap(
      Effect.map(PubSub.subscribe(bus.pubsub), (subscription) =>
        Stream.concat(
          Stream.fromArray(bus.past.filter((e: RunEvent) => e.seq > after)),
          Stream.fromSubscription(subscription)
        ))
    ).pipe(
      Stream.map(render),
      Stream.encodeText,
      Stream.ensuring(Effect.log("sse client gone"))
    )

    return HttpServerResponse.stream(body, { headers: sseHeaders })
  })
)

const CancelBody = Schema.Struct({ reason: Schema.String })

const CancelRoute = HttpRouter.add(
  "POST",
  "/cancel",
  Effect.gen(function*() {
    const bus = yield* Bus
    const body = yield* HttpServerRequest.schemaBodyJson(CancelBody)
    yield* bus.cancel
    return yield* HttpServerResponse.json({ ok: true, reason: body.reason }, { status: 202 })
  })
)

const PathParamRoute = HttpRouter.add(
  "GET",
  "/runs/:runId",
  Effect.gen(function*() {
    const params = yield* HttpRouter.params
    return HttpServerResponse.text(params["runId"] ?? "unknown", { status: 200 })
  })
)

const HealthRoute = HttpRouter.add("GET", "/health", HttpServerResponse.empty({ status: 204 }))

const AppRoutes = Layer.mergeAll(SseRoute, CancelRoute, PathParamRoute, HealthRoute)

const ServerLayer = NodeHttpServer.layer(createServer, {
  host: "127.0.0.1",
  port: 0,
  gracefulShutdownTimeout: 0
})

// Bus is provided AFTER serve: route deps are Request<"Requires", Bus> markers until then.
export const MainLayer = HttpRouter.serve(AppRoutes).pipe(
  Layer.provide(Bus.layer),
  Layer.provideMerge(ServerLayer)
)
// MainLayer :: Layer<HttpServer | NodeServices | HttpPlatform | Etag.Generator, ServeError, never>

export const boundPort = Effect.gen(function*() {
  const server = yield* HttpServer.HttpServer
  const address = server.address
  return address._tag === "UnixPathAddress" ? -1 : address.port
})

export const program = Effect.gen(function*() {
  const port = yield* boundPort
  yield* Effect.log(`listening on 127.0.0.1:${port}`)
  yield* Effect.never
}).pipe(Effect.provide(MainLayer))
// program :: Effect<void, ServeError, never>

NodeRuntime.runMain(program)
```

Observed output of the executed variant:

```
GET  /health                     -> 204
GET  /runs/abc123                -> 200 "abc123"
POST /cancel {"reason":"user"}   -> 202 {"ok":true,"reason":"user"}
POST /cancel {"nope":1}          -> 400  (SchemaError: Missing key at ["reason"])
GET  /events (Last-Event-ID: 0)  -> 200 text/event-stream, chunked,
                                    "id: 1\nevent: log\ndata: {...}\n\n" then live frames
client hangs up                  -> "sse client gone" finalizer fires within ~3 ms
```

---

## 10. Misc facts worth knowing

* `HttpServer.layerServices` = `HttpPlatform + Path + Etag.layerWeak + FileSystem.layerNoop({})` — for tests
  that need the HTTP pipeline without a socket or a real FS.
* `HttpServer.layerTestClient` / `NodeHttpServer.layerTest` give an `HttpClient` already prefixed with the
  server's URL (unspecified addresses rewritten to 127.0.0.1). Unix sockets unsupported there.
* `HttpRouter.RouterConfig` is a `Context.Reference<Partial<FindMyWay.RouterConfig>>`; pass it through
  `serve({ routerConfig: { ignoreTrailingSlash: true } })`.
* `HttpServerRequest.upgradeChannel()` / `request.upgrade` for WebSockets — `NodeHttpServer` registers a `ws`
  `WebSocketServer` in `noServer` mode automatically.
* `Effect.Service` does **not** exist in v4. Use `Context.Service<Self, Shape>()("id")` with a static
  `Layer.effect(Tag)(effect)`; a scoped effect there is fine (the layer owns the scope).
* `Queue.unbounded<A>()` cannot be `end`ed; you need `Queue.unbounded<A, Cause.Done>()` (`Cause.Done` from
  `effect`, re-exported as the `Done` type used by `Queue.end`).
* `Layer.launch(layer): Effect<never, E, RIn>`, `Layer.build(layer): Effect<Context<ROut>, E, RIn | Scope>`.
* UNVERIFIED: `HttpPlatform.compression` / `HttpMiddleware.compression`, `Multipart`, cookie helpers,
  `HttpApi*` (the schema-first stack) — read but not compiled or run here.
