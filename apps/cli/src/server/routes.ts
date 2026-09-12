import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { join } from "node:path";
import type { RunBus, Subscription } from "./bus.js";
import {
  contentTypeOf,
  fallbackDashboard,
  hasBuiltUi,
  readAsset,
  resolveAsset,
  resolveUnder,
  uiAssetsRoot,
} from "./assets.js";
import { makeFrameEncoder, makeHarnessFrameEncoder, parseCursor, sseHeaders } from "./sse.js";

export interface RoutesOptions {
  readonly bus: RunBus;
  /** A snapshot the dashboard can render immediately, before any event arrives. */
  readonly state: () => unknown;
}

/**
 * Endpoints injected into the served page as `globalThis.__DIFMP_UI__`, which is the override
 * `apps/ui/src/runtime/config.ts` documents. Without the injection the UI would fall back to its
 * relative defaults (`events`, `cancel`, `contract`, `artifacts/`).
 */
const uiRuntimeConfig = {
  // The monotonic suite stream retains every scenario; raw per-run seq values restart at 1.
  eventsUrl: "/api/events",
  cancelUrl: "/api/cancel",
  closeUrl: "/api/close",
  contractUrl: "/api/contract",
  artifactBaseUrl: "/api/artifacts/",
} as const;

const injectionId = "difmp-ui-runtime";
const injection = `<script id="${injectionId}">globalThis.__DIFMP_UI__=${JSON.stringify(uiRuntimeConfig)};</script>`;

/** Injected before the bundle, and only once — the UI's own shell mentions the global in a comment. */
const withRuntimeConfig = (html: string): string =>
  html.includes(`id="${injectionId}"`)
    ? html
    : html.includes("<head>")
      ? html.replace("<head>", `<head>${injection}`)
      : `${injection}${html}`;

const sseStream = <A>(
  subscription: Subscription<A>,
  snapshotAfter: number,
  encode: (value: A) => string,
) =>
  Stream.concat(
    Stream.fromArray(subscription.snapshotAfter(snapshotAfter)),
    Stream.fromQueue(subscription.queue),
  ).pipe(Stream.map(encode), Stream.encodeText);

const cursorOf = (request: HttpServerRequest.HttpServerRequest): number => {
  const search = new URL(request.url, "http://localhost").searchParams;
  // Header keys are lowercase. `EventSource` sets Last-Event-ID itself when it reconnects; the UI
  // adds `?lastEventId=` when it takes the retrying over.
  return parseCursor(request.headers["last-event-id"] ?? search.get("lastEventId") ?? undefined);
};

const runOf = (bus: RunBus, request: HttpServerRequest.HttpServerRequest) => {
  const runId = new URL(request.url, "http://localhost").searchParams.get("runId");
  return runId === null ? bus.currentRun() : bus.runById(runId);
};

/**
 * The bus is captured in a closure rather than injected as a service: route requirements surface
 * as `HttpRouter.Request<"Requires", _>` markers that only `HttpRouter.serve` can discharge
 * (api-effect-http-node.md §1), and there is nothing to gain from routing through the context here.
 */
export const makeRoutes = (options: RoutesOptions) => {
  const { bus, state } = options;

  /** The CLI's own stream: scenario lifecycle plus every harness event, wrapped and re-sequenced. */
  const events = HttpRouter.add(
    "GET",
    "/api/events",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const after = cursorOf(request);
      // Register first, snapshot second: nothing published in between can be lost.
      const subscription = yield* bus.subscribe;
      const body = sseStream(subscription, after, makeFrameEncoder(bus.journal, after));
      return HttpServerResponse.stream(body, { headers: sseHeaders });
    }),
  );

  /** What `apps/ui` consumes: raw `HarnessEvent`s for the run currently being followed. */
  const uiEvents = HttpRouter.add(
    "GET",
    "/api/ui/events",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const after = cursorOf(request);
      const subscription = yield* bus.subscribeHarness;
      const body = sseStream(
        subscription,
        after,
        makeHarnessFrameEncoder(bus.harnessJournal, after),
      );
      return HttpServerResponse.stream(body, { headers: sseHeaders });
    }),
  );

  const cancel = HttpRouter.add(
    "POST",
    "/api/cancel",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const raw = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      const reason = (() => {
        try {
          const parsed = JSON.parse(raw) as { reason?: unknown };
          return typeof parsed.reason === "string" && parsed.reason.trim() !== ""
            ? parsed.reason
            : "dashboard";
        } catch {
          return "dashboard";
        }
      })();
      const accepted = yield* bus.requestCancel(reason);
      yield* bus.publish("cancellationRequested", { reason, accepted });
      // 202 only once the runner has been asked; the run's own finalizers close the browser and
      // the fixtures before the process exits (api-effect-http-node.md §C2).
      return yield* HttpServerResponse.json({ accepted, reason }, { status: 202 });
    }),
  );

  const close = HttpRouter.add(
    "POST",
    "/api/close",
    Effect.gen(function* () {
      const accepted = yield* bus.requestDashboardClose;
      return yield* HttpServerResponse.json({ accepted }, { status: 202 });
    }),
  );

  /**
   * The frozen contract of the run being followed. `contractFrozen` carries criterion ids only, so
   * the UI fetches the text and the `model` / `code` method from here — and retries until the
   * contract actually exists, which is why "not frozen yet" is a 404 rather than an error.
   */
  const contract = HttpRouter.add(
    "GET",
    "/api/contract",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const run = runOf(bus, request);
      if (run === undefined) return HttpServerResponse.text("no run yet", { status: 404 });
      const bytes = yield* readAsset(join(run.directory, "contract.json")).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (bytes === undefined)
        return HttpServerResponse.text("contract not frozen yet", { status: 404 });
      return HttpServerResponse.uint8Array(bytes, {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }),
  );

  /** Evidence files, addressed by the run-relative path recorded in `artifactAvailable.path`. */
  const artifacts = HttpRouter.add(
    "GET",
    "/api/artifacts/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const run = runOf(bus, request);
      if (run === undefined) return HttpServerResponse.text("no run yet", { status: 404 });
      const path = new URL(request.url, "http://localhost").pathname;
      const file = resolveUnder(run.directory, path.slice("/api/artifacts/".length));
      if (file === undefined) return HttpServerResponse.text("not found", { status: 404 });
      const bytes = yield* readAsset(file).pipe(Effect.orElseSucceed(() => undefined));
      if (bytes === undefined) return HttpServerResponse.text("not found", { status: 404 });
      return HttpServerResponse.uint8Array(bytes, {
        headers: { "content-type": contentTypeOf(file), "cache-control": "no-store" },
      });
    }),
  );

  const snapshot = HttpRouter.add(
    "GET",
    "/api/state",
    Effect.gen(function* () {
      const journal = bus.journal();
      return yield* HttpServerResponse.json({
        state: state(),
        run: bus.currentRun() ?? null,
        lastEventId: journal.length === 0 ? 0 : journal[journal.length - 1]!.seq,
        subscribers: bus.subscriberCount(),
      });
    }),
  );

  const health = HttpRouter.add("GET", "/api/health", HttpServerResponse.empty({ status: 204 }));

  const ui = HttpRouter.add(
    "GET",
    "*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = new URL(request.url, "http://localhost").pathname;
      const file = hasBuiltUi() ? resolveAsset(uiAssetsRoot, path) : fallbackDashboard;
      if (file === undefined) return HttpServerResponse.text("not found", { status: 404 });
      const bytes = yield* readAsset(file).pipe(Effect.orElseSucceed(() => undefined));
      if (bytes === undefined) return HttpServerResponse.text("not found", { status: 404 });
      const type = contentTypeOf(file);
      if (!type.startsWith("text/html")) {
        return HttpServerResponse.uint8Array(bytes, {
          headers: { "content-type": type, "cache-control": "no-store" },
        });
      }
      return HttpServerResponse.text(withRuntimeConfig(new TextDecoder().decode(bytes)), {
        headers: { "content-type": type, "cache-control": "no-store" },
      });
    }),
  );

  const routes = [
    events,
    uiEvents,
    cancel,
    close,
    contract,
    artifacts,
    snapshot,
    health,
    ui,
  ] as const;
  return Layer.mergeAll(...routes);
};
