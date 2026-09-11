# Effect v4 (4.0.0-rc.113) — CORE runtime cheat-sheet

Source of truth: `node_modules/effect/AGENTS.md`, `node_modules/effect/ai-docs/src/**`,
`node_modules/effect/src/**.ts`. Everything below compiled clean unless marked `UNVERIFIED:`.

Verified with:
```
npx tsc -p .recon/tsconfig.core.json     # files: .recon/core.ts, .recon/core2.ts
# = tsconfig.base.json (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess,
#   verbatimModuleSyntax, ES2023 + DOM, nodenext)
```

## 0. BLOCKER: `effect` is not installed at the repo root

`pnpm-lock.yaml` declares `effect`, `@effect/platform-node`, `@effect/ai-anthropic` as root
dependencies, but the current root `package.json` does **not** list them, and
`node_modules/` has only `@effect/vitest`. `import { Effect } from "effect"` fails with TS2307.

Fix before implementing (pick one):
```bash
pnpm add effect@4.0.0-rc.113 @effect/platform-node@4.0.0-rc.113 @effect/ai-anthropic@4.0.0-rc.113 -w
# or temporary recon workaround (what this doc used):
ln -sfn ../node_modules/.pnpm/effect@4.0.0-rc.113/node_modules/effect node_modules/effect
```

## 1. v3 -> v4 renames / removals (observed in the shipped source)

| v3 | v4 |
|---|---|
| `Effect.catchAll` | **`Effect.catch`** (`catch_ as catch`) |
| `Effect.catchAllCause` | `Effect.catchCause` |
| `Effect.catchAllDefect` | `Effect.catchDefect` |
| `Effect.catchSome` / `catchSomeCause` | `Effect.catchIf` / `catchFilter`, `catchCauseIf` / `catchCauseFilter` |
| `Effect.either` | `Effect.result` -> `Result.Result<A, E>` (**`Either` module deleted**, `Result.ts` replaces it) |
| `Effect.fork` | **gone**. Use `Effect.forkChild` / `forkScoped` / `forkIn` / `forkDetach` |
| `Effect.forkDaemon` | `Effect.forkDetach` |
| `Effect.async` / `asyncEffect` | `Effect.callback` |
| `Effect.timeoutTo` | **`Effect.timeoutOrElse({ duration, orElse })`** (no `timeoutTo`) |
| `Effect.tapErrorCause` | `Effect.tapCause` |
| `Context.Tag` / `Effect.Service` | **`Context.Service<Self, Shape>()("id")`** (`Effect.Service` does not exist) |
| `Context.Tag.of` | `MyService.of(...)` (same), plus `MyService.use(f)` / `useSync(f)` |
| `Layer.scoped` | **gone** — `Layer.effect` already accepts a scoped Effect and strips `Scope` |
| `Layer.scopedDiscard` | `Layer.effectDiscard` |
| `Config.string` / `Config.number` / `Config.boolean` / `Config.redacted` | **Capitalized**: `Config.String`, `Config.Number`, `Config.Boolean`, `Config.Redacted`, `Config.Int`, `Config.Port`, `Config.Duration`, `Config.URL`, `Config.Date`, `Config.Literal(s)`, `Config.Array`, `Config.Record`, `Config.ByteSize`, `Config.LogLevel` |
| `Data.TaggedError` | prefer **`Schema.TaggedError<Self>()("Tag", fields)`** (`Data` still exists) |
| `Effect.withConcurrency` | gone — pass `{ concurrency }` per call site |
| `Queue.shutdown`-only completion | `Queue.end(q)` + `Cause.Done` sentinel in the queue's error type |
| `Chunk` everywhere | v4 streams/queues use plain `Array` / `NonEmptyReadonlyArray` |
| `Effect.serviceFunctions` etc. | gone |

Also note: `Concurrency = number | "unbounded"` — **no `"inherit"`** (`effect/Types.ts:454`).

## 2. Effect.gen / Effect.fn / Effect.fnUntraced

```ts
import { Effect, Schema } from "effect"

export class StepError extends Schema.TaggedError<StepError>()("StepError", {
  message: Schema.String
}) {}

export const prog = Effect.gen(function*() {
  yield* Effect.log("hi")
  return 1
}).pipe(
  Effect.catch((e) => Effect.logError(`${e}`)),
  Effect.withSpan("prog")
)

// Effect.fn("name") -> stack frame + tracing span. Extra args act like pipe() steps.
// DO NOT .pipe() the result of Effect.fn — pass combinators as trailing arguments.
export const traced = Effect.fn("traced")(
  function*(n: number): Effect.fn.Return<string, StepError> {
    if (n < 0) return yield* new StepError({ message: "neg" })   // always `return yield*`
    return String(n)
  },
  Effect.annotateLogs({ method: "traced" })
)

// no span / no stack capture — library + hot paths
export const untraced = Effect.fnUntraced(function*(n: number): Effect.fn.Return<number, StepError> {
  return n
})

// non-generator body also works
export const tracedArrow = Effect.fn("tracedArrow")((n: number) => Effect.succeed(n + 1))
```
- `Effect.fn.Return<A, E = never, R = never>` is the **return-type annotation** for the generator
  body (needed for generic/parametric fns; inference is otherwise fine).
- `Effect.fn` signature: `fn.Traced & ((name: string, options?: SpanOptionsNoTrace) => fn.Traced)`.
  So both `Effect.fn(body)` (stack frame, no span) and `Effect.fn("name")(body)` (span) are legal.
- `{ self: this }` may be passed before the body to bind `this` (see `Effect.ts` fn docs).
- `Effect.fnUntracedEager` also exists (plus `mapEager`, `flatMapEager`, `catchEager`, …).

## 3. Context.Service — the service pattern

```ts
import { Context, Effect, Layer } from "effect"

export class Browser extends Context.Service<Browser, {
  open(url: string): Effect.Effect<void, StepError>
  readonly close: Effect.Effect<void>
}>()("harness/Browser") {
  static readonly layer = Layer.effect(
    Browser,
    Effect.gen(function*() {
      const open = Effect.fn("Browser.open")(function*(url: string) {
        yield* Effect.log(url)
      })
      return Browser.of({ open, close: Effect.void })   // Browser.of gives inference + checking
    })
  )
}

export type BrowserService = Browser["Service"]                   // the shape type
export type BrowserShape  = Context.Service.Shape<typeof Browser> // equivalent
export const useBrowser   = Browser.use((b) => b.close)           // Effect<void, never, Browser>
export const browserKey: string = Browser.key                     // "harness/Browser"
```
- Two-stage call is mandatory for the class form: `Context.Service<Self, Shape>()("id")`.
- Function-style key (no class): `const Logger2 = Context.Service<{ log: (m: string) => void }>("harness/Logger2")`.
- `Key` extends `Effect<Shape, never, Identifier>` → `yield* Browser` works directly.
- Members on the key: `.of`, `.context`, `.use(f)`, `.useSync(f)`, `.key`.
- ID string convention from AGENTS.md: `"<package>/<dir>/<Name>"`.

## 4. Context.Reference — config with a default (no layer needed)

```ts
import { Context, Duration, Effect } from "effect"

export class Headless extends Context.Reference<boolean>("harness/Headless", {
  defaultValue: () => true
}) {}

// const form works too
export const Timeout = Context.Reference<Duration.Duration>("harness/Timeout", {
  defaultValue: () => Duration.seconds(30)
})

const read = Effect.gen(function*() { return yield* Headless })   // R = never (!)
const overridden = read.pipe(Effect.provideService(Headless, false))
```
- `Reference<Shape> extends Service<never, Shape>` → **yielding it adds nothing to `R`**.
- Override with `Effect.provideService` / `Effect.updateService` / `Layer.succeed`.
- `Clock.Clock` itself is a `Context.Reference<Clock>` — same mechanism.

## 5. Layer

```ts
Layer.succeed(Key, value)
Layer.sync(Key, () => value)
Layer.effect(Key, effect)                 // effect MAY be scoped; Scope is Excluded from R
Layer.effectContext(Effect<Context<A>>)   // provide several services at once
Layer.effectDiscard(effect)               // Layer<never, E, Exclude<R, Scope>> — background tasks
Layer.suspend(() => layer)
Layer.unwrap(Effect<Layer<...>>)          // choose a layer from Config/Effect
Layer.mergeAll(l1, l2, ...)               // requires >= 1; first arg typed Layer<never, any, any>
Layer.merge(a, b)
Layer.provide(inner, deps)                // hides deps
Layer.provideMerge(inner, deps)           // exposes deps too
Layer.launch(layer)                       // Effect<never, E, RIn> — app entrypoint
Layer.fresh(layer)                        // opt out of memoization
Layer.mock(Key, partial)                  // test doubles
Layer.makeMemoMapUnsafe()                 // share memoization across ManagedRuntimes
Layer.catchTag / catchCause / tap / tapError / tapCause / orDie / updateService
```
Verified composition:
```ts
export const L5 = Browser.layer.pipe(Layer.provide(L1))
export const L6 = Browser.layer.pipe(Layer.provideMerge(L1))
export const L8: Effect.Effect<never, never, never> = Layer.launch(L7)

export const L4 = Layer.unwrap(Effect.gen(function*() {
  const on = yield* Config.Boolean("ON").pipe(Config.withDefault(false))
  return on ? L1 : L2
}))
```
Background task inside a layer (from `ai-docs/.../20_layer-side-effects.ts`):
```ts
const BackgroundTask = Layer.effectDiscard(Effect.gen(function*() {
  yield* loop.pipe(
    Effect.onInterrupt(() => Effect.logInfo("layer scope closed")),
    Effect.forkScoped          // dies with the layer's scope
  )
}))
BackgroundTask.pipe(Layer.launch, NodeRuntime.runMain)
```

## 6. Scope, acquireRelease, finalizers, bounded cleanup

```ts
import { Effect, Exit, Scope } from "effect"

export const resource = Effect.acquireRelease(
  Effect.sync(() => ({ id: 1 })),
  (r, exit) => Effect.log(`release ${r.id} ${Exit.isSuccess(exit)}`)   // release sees the Exit
)   // Effect<{id:number}, never, Scope>

export const scopedProg = Effect.gen(function*() {
  const r = yield* resource
  yield* Effect.addFinalizer((exit) => Effect.log(`fin ${exit._tag}`))
  return r
}).pipe(Effect.scoped)          // Effect.scoped removes Scope from R and runs finalizers LIFO
```
Signatures (`src/Effect.ts`):
```ts
acquireRelease: <A,E,R,R2>(acquire: Effect<A,E,R>,
  release: (a: A, exit: Exit<unknown, unknown>) => Effect<unknown, never, R2>,
  options?: { readonly interruptible?: boolean }) => Effect<A, E, R | R2 | Scope>
addFinalizer: <R>(f: (exit: Exit<unknown, unknown>) => Effect<void, never, R>) => Effect<void, never, R | Scope>
scoped: <A,E,R>(self: Effect<A,E,R>) => Effect<A, E, Exclude<R, Scope>>
scopedWith: <A,E,R>(f: (scope: Scope) => Effect<A,E,R>) => Effect<A,E,R>
scope: Effect<Scope, never, Scope>
```
Composition rules:
- Finalizers run in **reverse registration order** when the enclosing `Scope` closes.
- `Layer.effect` / `Layer.effectDiscard` build inside the **layer's** scope → resources live as long
  as the layer (i.e. until `ManagedRuntime.dispose()` / `Layer.launch` interruption).
- `Effect.forkScoped` ties a fiber to the current scope; the fiber is interrupted on scope close.
- `Effect.ensuring(fin)` / `Effect.onExit(f)` / `Effect.onError(f)` are the non-Scope variants.

**Bounded cleanup** — there is no built-in finalizer deadline; wrap the finalizer yourself:
```ts
export const boundedRelease = Effect.acquireRelease(
  Effect.succeed("res"),
  () => Effect.sleep("10 seconds").pipe(Effect.timeoutOption("500 millis"), Effect.asVoid)
)

// manual scope, parallel finalizers, bounded close
export const boundedCleanup = Effect.gen(function*() {
  const scope = yield* Scope.make("parallel")   // "sequential" (default) | "parallel"
  yield* Scope.addFinalizer(scope, Effect.sleep("10 seconds").pipe(
    Effect.timeoutOption("200 millis"), Effect.asVoid))
  yield* Scope.close(scope, Exit.void)
})
```
Use `Effect.timeoutOption` (not `timeout`) inside finalizers: release must be `Effect<_, never, _>`.
Other `Scope` members: `Scope.fork`, `Scope.forkUnsafe`, `Scope.addFinalizerExit`, `Scope.closeUnsafe`,
`Scope.provide`, `Scope.use`. The key is `Scope.Scope` (a `Context.Service<Scope, Scope>`).

## 7. Typed errors, Cause, Exit

```ts
export class AError extends Schema.TaggedError<AError>()("AError", { a: Schema.Number }) {}
export class BError extends Schema.TaggedError<BError>()("BError", { b: Schema.String }) {}
declare const mayFail: Effect.Effect<number, AError | BError>

mayFail.pipe(Effect.catchTag("AError", (e) => Effect.succeed(e.a)))
mayFail.pipe(Effect.catchTag(["AError", "BError"], () => Effect.succeed(0)))  // array form!
mayFail.pipe(Effect.catchTags({ AError: (e) => …, BError: (e) => … }))
mayFail.pipe(Effect.catch(() => Effect.succeed(0)))                           // = v3 catchAll
mayFail.pipe(Effect.catchCause((c: Cause.Cause<AError|BError>) => Effect.succeed(Cause.pretty(c))))
mayFail.pipe(Effect.catchDefect((d) => Effect.succeed(String(d))))
mayFail.pipe(Effect.orDie)                                                    // E -> defect
Effect.exit(mayFail)     // Effect<Exit<number, AError|BError>>
Effect.result(mayFail)   // Effect<Result<number, AError|BError>>  (Result, not Either)
Effect.die(new Error("boom"))
```
Inspecting a failure:
```ts
const exit = yield* Effect.exit(mayFail)
if (Exit.isFailure(exit)) {
  const cause: Cause.Cause<AError | BError> = exit.cause
  Cause.findErrorOption(cause)   // Option<E>
  Cause.findDefect(cause)        // Result<unknown, Cause<E>>
  Cause.hasInterrupts(cause)     // true if the fiber was interrupted
  Cause.hasInterruptsOnly(cause)
  Cause.pretty(cause)            // string, for reports
  Cause.prettyErrors(cause)
  Cause.squash(cause)
}
```
- `Cause<E>` in v4 is a **list of `Reason`s** (`Fail<E> | Die | Interrupt`), not a tree.
  `Cause.fromReasons`, `Cause.isFailReason/isDieReason/isInterruptReason`, `Cause.annotate`.
- Built-in error types live on `Cause`: `Cause.TimeoutError`, `Cause.NoSuchElementError`,
  `Cause.UnknownError`, `Cause.IllegalArgumentError`, `Cause.ExceededCapacityError`, `Cause.Done`.
- `Schema.TaggedError` instances are real `Error`s **and** yieldable:
  `return yield* new AError({ a: 1 })`. `Schema.encodeUnknownSync(AError)(err)` serializes them
  (handy for JSON reports). Use `Schema.Defect()` as the field type for a wrapped `unknown` cause.
- Alternate form seen in ai-docs: `class E2 extends Schema.Error<E2>("E2")({ cause: Schema.Defect() }) {}`.
- `Effect.catchReason` / `catchReasons` / `unwrapReason` handle a tagged `reason` field nested
  inside one error (the `AiError { reason: Union([...]) }` pattern).
- `class X extends Schema.TaggedError<X>()("X", { message: Schema.String })` — if you add your own
  `message`/`name` members you must mark them `override` (tsconfig has `noImplicitOverride`).

## 8. Interruption & timeouts

```ts
Effect.uninterruptible(eff)
Effect.interruptible(eff)
Effect.uninterruptibleMask((restore) => restore(eff))
Effect.interruptibleMask((restore) => …)
Effect.interrupt                                  // Effect<never>
eff.pipe(Effect.onInterrupt((interruptors: ReadonlySet<number>) => Effect.log("bye")))
eff.pipe(Effect.timeout("2 seconds"))             // Effect<A, E | Cause.TimeoutError, R>
eff.pipe(Effect.timeoutOption(1000))              // Effect<Option<A>, E, R>
Effect.timeoutOrElse(eff, { duration: "1 second", orElse: () => Effect.succeed(0) })
Effect.race(a, b)  Effect.raceFirst(a, b)  Effect.raceAll([...])  Effect.raceAllFirst([...])
Fiber.interrupt(fiber)  Fiber.interruptAll(fibers)
```
- Durations accept `Duration.Input`: `"2 seconds"`, `1000` (millis), `Duration.seconds(2)`.
- Timeout **interrupts** the loser. `race` interrupts the loser too.
- `Effect.abortSignal: Effect<AbortSignal, never, Scope>` — an AbortSignal wired to interruption.

## 9. Wrapping Promise APIs — **the callback receives an AbortSignal**

```ts
// Effect.promise: <A>(evaluate: (signal: AbortSignal) => PromiseLike<A>) => Effect<A>
export const p1 = Effect.promise((signal) => fetch("http://x", { signal }))

// Effect.tryPromise with { try, catch } — `try` also gets the signal
export const p2 = Effect.tryPromise({
  try: (signal) => fetch("http://x", { signal }),
  catch: (cause) => new StepError({ message: String(cause) })
})

// thunk form: E = Cause.UnknownError
export const p3 = Effect.tryPromise(() => Promise.resolve(1))

// callback APIs: register gets (resume, signal) and may return a finalizer Effect
export const p4 = Effect.callback<number>((resume, signal) => {
  const t = setTimeout(() => resume(Effect.succeed(1)), 10)
  signal.addEventListener("abort", () => clearTimeout(t))
  return Effect.sync(() => clearTimeout(t))
})
```
The signal is aborted on interruption, but **only cooperating APIs actually stop** — Playwright/fetch
do, a bare `setTimeout` does not; return a finalizer.
Also: `Effect.try({ try, catch })` (sync), `Effect.fromNullishOr`, `Effect.fromOption`, `Effect.fromResult`.

## 10. Concurrency & fibers

```ts
Effect.forEach([1,2,3], (n) => eff(n), { concurrency: 4 })
Effect.forEach(xs, f, { concurrency: "unbounded", discard: true })   // -> Effect<void>
Effect.all([a, b] as const, { concurrency: 2 })                      // tuple / record / iterable
Effect.all({ a, b }, { mode: "result" })                             // mode: "default" | "result"
Effect.partition(xs, f)   Effect.validate(...)   Effect.replicateEffect(...)
```
Forking (there is **no `Effect.fork`**):
```ts
const fib: Fiber.Fiber<number, never> = yield* Effect.forkChild(Effect.succeed(1))  // parent awaits
yield* Fiber.join(fib); yield* Fiber.interrupt(fib); yield* Fiber.awaitAll([fib])
yield* Effect.forkScoped(Effect.never)             // R gains Scope; dies with the scope
yield* Effect.forkIn(Effect.never, scope)
Effect.never.pipe(Effect.forkDetach)               // global scope (ex-forkDaemon)
Effect.awaitAllChildren(eff)
```
All fork APIs take `{ startImmediately?: boolean, uninterruptible?: boolean | "inherit" }` and are
dual (data-first or data-last). Also: `FiberHandle`, `FiberMap`, `FiberSet`, `Semaphore`,
`PartitionedSemaphore`, `Pool`, `RcMap`, `RcRef`.

## 11. Queue / PubSub / Deferred / Latch / SubscriptionRef — all exist in v4

```ts
// Queue<A, E = never>
const q = yield* Queue.unbounded<string, Cause.Done>()   // E must include Cause.Done to use end()
yield* Queue.offer(q, "a");  Queue.offerUnsafe(q, "b");  yield* Queue.offerAll(q, ["c"])
const one  = yield* Queue.take(q)         // Effect<A, E>
const many = yield* Queue.takeAll(q)      // NonEmptyArray<A>
yield* Queue.end(q)                       // completes the queue (fails with Cause.Done)
const all  = yield* Queue.collect(q)      // drains to Array<A>, strips Done
Queue.bounded<A>(n) | Queue.sliding<A>(n) | Queue.dropping<A>(n) | Queue.make({ capacity, strategy })
Queue.fail / failCause / interrupt / shutdown / poll / peek / size / clear / into
```
```ts
// PubSub
const pubsub = yield* PubSub.bounded<number>({ capacity: 64, replay: 8 })  // replay buffer!
yield* PubSub.publish(pubsub, 1); yield* PubSub.publishAll(pubsub, [2,3])
const stream = Stream.fromPubSub(pubsub)
const sub = yield* PubSub.subscribe(pubsub)   // Effect<Subscription<A>, never, Scope>
yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))
// also: PubSub.unbounded / dropping / sliding / makeAtomicBounded / makeAtomicUnbounded
```
```ts
// Deferred<A, E = never>  — await is a FUNCTION, not a property
const d = yield* Deferred.make<number, StepError>()
yield* Deferred.succeed(d, 1)
const v = yield* Deferred.await(d)        // NOT d.await
yield* Deferred.isDone(d) / poll / fail / failCause / die / interrupt / complete / into
```
```ts
// Latch — has BOTH property-style and function-style APIs
const latch = yield* Latch.make(false)     // open?: boolean
yield* Latch.open(latch)                   // == latch.open
yield* latch.await                         // latch.await IS a property here
yield* Latch.close(latch);  Latch.isOpen(latch);  Latch.whenOpen(eff);  latch.openUnsafe()
```
```ts
// SubscriptionRef
const ref = yield* SubscriptionRef.make(0)
yield* SubscriptionRef.update(ref, (n) => n + 1)
const changes: Stream.Stream<number> = SubscriptionRef.changes(ref)   // current + all updates
yield* SubscriptionRef.get(ref) / set / modify / getAndUpdate / updateEffect / ...
```
Also present: `Ref`, `SynchronizedRef`, `ScopedRef`, `MutableRef`, plus the STM-ish `Tx*` family
(`TxRef`, `TxQueue`, `TxPubSub`, `TxHashMap`, `TxDeferred`, `TxSemaphore`, `Effect.tx`, `Effect.txRetry`).

## 12. Stream — the pieces needed for SSE

```ts
Stream.fromQueue(queue)          // Stream<A, Exclude<E, Cause.Done>>  — Queue.end terminates it
Stream.fromPubSub(pubsub)  Stream.fromSubscription(sub)
Stream.callback<A>(register)     // register receives a Queue; use Queue.offerUnsafe
Stream.fromIterable / fromArray / make / fromAsyncIterable / fromReadableStream
Stream.fromEffect / fromEffectSchedule / fromEventListener / paginate / unfold / tick
Stream.map / mapEffect / filter / take / tap / flatMap / scan / groupedWithin / debounce / throttle
Stream.concat / prepend / merge / mergeAll / mergeLeft / mergeRight / race / zip / interleave
Stream.encodeText   // Stream<string> -> Stream<Uint8Array>
Stream.decodeText   // Stream<Uint8Array> -> Stream<string>;  Stream.splitLines
Stream.runCollect / runForEach / runDrain / runFold / runHead / runLast / mkString / toPull
Stream.toReadableStream / toReadableStreamEffect / toAsyncIterable / toQueue / toPubSub
Stream.onStart / onEnd / onExit / onError / ensuring / interruptWhen / haltWhen / scoped / unwrap
```
Verified SSE shape:
```ts
export const sseBody: Effect.Effect<ReadableStream<Uint8Array>> = Effect.gen(function*() {
  const queue = yield* Queue.unbounded<string>()
  return Stream.toReadableStream(               // DATA-FIRST — see gotcha below
    Stream.fromQueue(queue).pipe(
      Stream.map((s) => `data: ${s}\n\n`),
      Stream.concat(Stream.make("data: [DONE]\n\n")),
      Stream.encodeText
    )
  )
})
```
**GOTCHA — `Stream.toReadableStream` typing.** It is `dual`, and the data-last overload is
`<A>(options?) => <E>(self) => ReadableStream<A>`. Writing `.pipe(Stream.toReadableStream)` bare
infers `ReadableStream<unknown>`. Use the data-first form, or pass the type arg:
```ts
const rs: ReadableStream<Uint8Array> = Stream.toReadableStream(Stream.encodeText(s))      // ✅
const rs2: ReadableStream<string>    = Stream.make("a").pipe(Stream.toReadableStream<string>()) // ✅
const bad = Stream.make("a").pipe(Stream.encodeText, Stream.toReadableStream) // ❌ ReadableStream<unknown>
```
Confirmed by compiling `.recon/core3.ts`: the bare pipe form yields `ReadableStream<unknown>` even
when the upstream element type is known.
`Stream.toReadableStreamEffect(s): Effect<ReadableStream<A>, never, R | Scope>` when the stream needs
services/scope. `Stream.toReadableStreamWith(s, context, options?)` when you have the `Context`.

Queue-driven SSE with explicit termination:
```ts
const q = yield* Queue.unbounded<string, Cause.Done>()
const stream: Stream.Stream<string> = Stream.fromQueue(q)   // Done is stripped from E
yield* Effect.forkScoped(Effect.gen(function*() {
  yield* Queue.offer(q, "tick")
  yield* Queue.end(q)                                        // closes the stream cleanly
}))
```

## 13. Clock / DateTime / durations

```ts
yield* Clock.currentTimeMillis          // Effect<number>
yield* Clock.currentTimeNanos           // Effect<bigint>
yield* Clock.monotonicTimeNanos         // Effect<bigint>  <- use for elapsed measurement
yield* Clock.clockWith((clock) => …)
const dt = yield* DateTime.now          // Effect<DateTime.Utc>  (Clock-backed, testable)
DateTime.formatIso(dt) / formatIsoDate / formatIsoZoned / toEpochMillis / nowUnsafe
DateTime.makeZoned / nowInCurrentZone (requires DateTime.CurrentTimeZone)

const [dur, value] = yield* Effect.timed(eff)   // [Duration, A]
Duration.toMillis(dur); Duration.seconds(2); Duration.millis(500); Duration.format(dur)
```
Never call `Date.now()` — use `Clock`/`DateTime` so `TestClock` can drive tests.

## 14. Running programs

```ts
Effect.runPromise(eff)        // Promise<A>            (E must be never-ish; rejects otherwise)
Effect.runPromiseExit(eff)    // Promise<Exit<A, E>>   <- prefer in harness code
Effect.runFork(eff, options?) // Fiber<A, E>
Effect.runSync(eff)           // A  (throws on async boundary)
Effect.runSyncExit(eff)       // Exit<A, E>
Effect.runCallback(eff, { onExit })
// *With variants take an explicit Context: runPromiseWith, runForkWith, runSyncWith, ...
```
`ManagedRuntime` for non-Effect edges (Playwright hooks, express handlers, CLI):
```ts
export const memoMap = Layer.makeMemoMapUnsafe()          // share across runtimes
export const rt = ManagedRuntime.make(Browser.layer, { memoMap })
await rt.runPromise(Browser.use((b) => b.close))
rt.runFork(eff); rt.runSync(eff); rt.runSyncExit(eff); rt.runCallback(eff, { onExit })
await rt.dispose()      // closes the layer scope + all finalizers
rt.memoMap; rt.contextEffect; await rt.context()
```
Process entrypoints: `NodeRuntime.runMain(effect)` from `@effect/platform-node`, or
`Layer.launch(appLayer).pipe(NodeRuntime.runMain)`.
UNVERIFIED: `@effect/platform-node` imports — the package is not linked into `node_modules` in this
checkout (see §0), so `NodeRuntime`/`NodeStream` snippets are copied from `ai-docs` and not compiled here.

## 15. Config & Redacted

```ts
import { Config, Duration, Redacted } from "effect"

const url  = yield* Config.String("BASE_URL").pipe(Config.withDefault("http://localhost:3000"))
const key  = yield* Config.Redacted("API_KEY")      // Config<Redacted<string>>
const port = yield* Config.Port("PORT")
const n    = yield* Config.Int("N").pipe(Config.withDefault(1))
const on   = yield* Config.Boolean("ON").pipe(Config.withDefault(false))
const ttl  = yield* Config.Duration("TTL").pipe(Config.withDefault(Duration.seconds(5)))
const opt  = yield* Config.option(Config.String("OPT"))            // Config<Option<string>>
const raw: string = Redacted.value(key)                            // ONLY way to read it
String(key)        // "<redacted>" — safe in logs/JSON
const dbHost = Config.nested(Config.String("HOST"), "DB")          // DB_HOST
```
- `Config<T> extends Effect<T, ConfigError>` → `yield*` it directly; no `Effect.config` wrapper.
- Other constructors: `Config.NonEmptyString`, `Number`, `Finite`, `Literal`, `Literals`, `Array`,
  `Record`, `ByteSize`, `LogLevel`, `URL`, `Date`, `Config.schema(codec, path?)`, `Config.all`,
  `Config.map`, `Config.mapEffect`, `Config.orElse`, `Config.unwrap`, `Config.succeed`, `Config.fail`.
- Backing store: `ConfigProvider` (swap it in tests).
- `Redacted.make(value, options?)`, `Redacted.value`, `Redacted.wipeUnsafe`, `Redacted.isRedacted`.

## 16. Misc facts worth knowing

- Barrel `import { Effect, Layer, ... } from "effect"` works; deep paths also work
  (`import * as Effect from "effect/Effect"`). "unstable" subtrees are namespaced:
  `effect/unstable/{http,httpapi,sql,cli,ai,rpc,process,observability,...}`.
- `Effect.void`, `Exit.void`, `Effect.log/logInfo/logDebug/logWarning/logError/logFatal/logTrace`.
- `Effect.withSpan(name, { attributes })`, `Effect.annotateLogs`, `Effect.annotateSpans`,
  `Effect.withLogSpan`, `Effect.track*` metrics helpers.
- `Predicate` module is mandatory per AGENTS.md — never hand-roll `isString`/`isRecord`.
- `Effect.provide(eff, layer)` accepts layers, contexts and runtimes; `Effect.provideService(key, v)`.
- Eager variants exist for hot paths: `mapEager`, `mapErrorEager`, `mapBothEager`, `flatMapEager`,
  `catchEager`, `matchEager`, `matchCauseEager`, `fnUntracedEager`.
- Type-level assertions for tests: `Effect.satisfiesSuccessType<A>()(eff)`,
  `satisfiesErrorType`, `satisfiesServicesType`, and the `Layer.satisfies*` trio.

## Files compiled for this document
- `/home/ubuntu/apps/difmp/.recon/core.ts` — §2–§14, §15 (clean)
- `/home/ubuntu/apps/difmp/.recon/core2.ts` — §5 scoped layers, §7 errors, §12 SSE/ReadableStream, §6 bounded cleanup (clean)
- `/home/ubuntu/apps/difmp/.recon/tsconfig.core.json` — compiles both under `tsconfig.base.json` settings
