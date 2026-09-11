import { Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import type { RunBus } from "./bus.js"
import { hasBuiltUi, contentTypeOf, fallbackDashboard, readAsset, resolveAsset, uiAssetsRoot } from "./assets.js"
import { makeFrameEncoder, parseCursor, sseHeaders } from "./sse.js"

export interface RoutesOptions {
  readonly bus: RunBus
  /** A snapshot the dashboard can render immediately, before any event arrives. */
  readonly state: () => unknown
}

/**
 * The bus is captured in a closure rather than injected as a service: route requirements surface
 * as `HttpRouter.Request<"Requires", _>` markers that only `HttpRouter.serve` can discharge
 * (api-effect-http-node.md §1), and there is nothing to gain from routing through the context here.
 */
export const makeRoutes = (options: RoutesOptions): Layer.Layer<never, never, HttpRouter.HttpRouter> => {
  const { bus, state } = options

  const events = HttpRouter.add(
    "GET",
    "/api/events",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const search = new URL(request.url, "http://localhost").searchParams
      // Header keys are lowercase. `EventSource` sets Last-Event-ID itself when it reconnects.
      const after = parseCursor(request.headers["last-event-id"] ?? search.get("lastEventId") ?? undefined)

      // Register first, snapshot second: nothing published in between can be lost.
      const subscription = yield* bus.subscribe
      const encode = makeFrameEncoder(bus.journal, after)

      const body = Stream.concat(
        Stream.fromArray(subscription.snapshotAfter(after)),
        Stream.fromQueue(subscription.queue)
      ).pipe(
        Stream.map(encode),
        Stream.encodeText
      )

      return HttpServerResponse.stream(body, { headers: sseHeaders })
    })
  )

  const cancel = HttpRouter.add(
    "POST",
    "/api/cancel",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const raw = yield* request.text.pipe(Effect.orElseSucceed(() => ""))
      const reason = (() => {
        try {
          const parsed = JSON.parse(raw) as { reason?: unknown }
          return typeof parsed.reason === "string" && parsed.reason.trim() !== "" ? parsed.reason : "dashboard"
        } catch {
          return "dashboard"
        }
      })()
      const accepted = yield* bus.requestCancel(reason)
      yield* bus.publish("cancellationRequested", { reason, accepted })
      // 202 only once the runner has been asked; the run's own finalizers close the browser and
      // the fixtures before the process exits (api-effect-http-node.md §C2).
      return yield* HttpServerResponse.json({ accepted, reason }, { status: 202 })
    })
  )

  const snapshot = HttpRouter.add(
    "GET",
    "/api/state",
    Effect.gen(function*() {
      const journal = bus.journal()
      return yield* HttpServerResponse.json({
        state: state(),
        lastEventId: journal.length === 0 ? 0 : journal[journal.length - 1]!.seq,
        subscribers: bus.subscriberCount()
      })
    })
  )

  const health = HttpRouter.add("GET", "/api/health", HttpServerResponse.empty({ status: 204 }))

  const ui = HttpRouter.add(
    "GET",
    "*",
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = new URL(request.url, "http://localhost").pathname
      const file = hasBuiltUi() ? resolveAsset(uiAssetsRoot, path) : fallbackDashboard
      if (file === undefined) return HttpServerResponse.text("not found", { status: 404 })
      const bytes = yield* readAsset(file).pipe(Effect.orElseSucceed(() => undefined))
      if (bytes === undefined) return HttpServerResponse.text("not found", { status: 404 })
      return HttpServerResponse.uint8Array(bytes, {
        headers: { "content-type": contentTypeOf(file), "cache-control": "no-store" }
      })
    })
  )

  const routes = [events, cancel, snapshot, health, ui] as const
  return Layer.mergeAll(...routes)
}
