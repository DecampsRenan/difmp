// Subpath, not the barrel — see the note in `src/bin/harness.ts` (the barrel drags in `redis`).
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Context, Duration, Effect, Layer, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { ExecutionError } from "../errors.js"
import type { RunBus } from "./bus.js"
import { makeRoutes } from "./routes.js"

export interface UiServerOptions {
  readonly bus: RunBus
  readonly state: () => unknown
  /** Loopback by default: the dashboard is a local development tool, not a service. */
  readonly host?: string
  /** `0` asks the OS for an ephemeral port. */
  readonly port?: number
  /** Bounded so an open SSE connection cannot hold the process open. */
  readonly gracefulShutdownTimeout?: Duration.Input
}

export interface UiServer {
  readonly host: string
  readonly port: number
  readonly url: string
}

/**
 * Start the live UI server for the duration of the enclosing scope.
 *
 * `gracefulShutdownTimeout: 0` is deliberate: the default is 20 s and an open SSE connection keeps
 * a socket alive, so a run that ends with a dashboard attached would otherwise hang for 21 s after
 * SIGTERM (api-effect-http-node.md §6).
 */
export const openUiServer = (
  options: UiServerOptions
): Effect.Effect<UiServer, ExecutionError, Scope.Scope> =>
  Effect.gen(function*() {
    const host = options.host ?? "127.0.0.1"
    const port = options.port ?? 0

    const serverLayer = NodeHttpServer.layer(createServer, {
      host,
      port,
      // Small but NOT zero. The default is 20 s and an open SSE connection keeps a socket alive, so
      // a run that ends with a dashboard attached would otherwise hang for 21 s after SIGTERM
      // (api-effect-http-node.md §6). Zero is worse than small: `timeoutOrElse(shutdown, 0)`
      // interrupts the cached shutdown effect immediately, and the scope's own finalizer then
      // replays that interrupt as the program's exit.
      gracefulShutdownTimeout: options.gracefulShutdownTimeout ?? Duration.millis(250)
    })
    const appLayer = HttpRouter.serve(makeRoutes({ bus: options.bus, state: options.state }), {
      disableLogger: true,
      disableListenLog: true
    }).pipe(Layer.provideMerge(serverLayer))

    const context = yield* Layer.build(appLayer).pipe(
      Effect.mapError((cause) =>
        new ExecutionError({
          message: `could not start the live UI server on ${host}:${port} — ${cause.message}`
        })
      )
    )
    const server = Context.get(context, HttpServer.HttpServer)
    const address = server.address
    const bound = address._tag === "UnixPathAddress" ? 0 : address.port
    return { host, port: bound, url: `http://${host}:${bound}/` }
  })
