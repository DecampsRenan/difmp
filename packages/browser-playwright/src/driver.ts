import type { BrowserSession, CaptureOutcome, OpenContextOptions, StorageStateLike } from "@harness/core"
import { BrowserDriver, BrowserError } from "@harness/core"
import { Effect, Layer } from "effect"
import type { Scope } from "effect/Scope"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { Browser, BrowserContext } from "playwright"
import { chromium } from "playwright"
import { fromCause } from "./errors.js"
import type { ContextState, SessionConfig } from "./session.js"
import { makeSession } from "./session.js"

export interface PlaywrightDriverOptions {
  readonly headless?: boolean
  readonly launchTimeoutMs?: number
  readonly args?: ReadonlyArray<string>
  readonly executablePath?: string
  readonly viewport?: { readonly width: number; readonly height: number }
  /** Cap on console/network records kept in memory per attempt. */
  readonly maxCaptureRecords?: number
  /**
   * Optional second application of core's navigation policy inside the driver. The runner already
   * calls `checkNavigationOrigin` before it ever reaches us; pass this when the driver is driven
   * directly (probes, tests) and must not be talked into leaving the allow-list.
   */
  readonly allowedOrigins?: ReadonlyArray<string>
}

const defaultViewport = { width: 1280, height: 720 } as const
const defaultArgs = ["--disable-dev-shm-usage", "--disable-gpu"] as const

/** Playwright wants a mutable storage state; the fixture hands us a readonly one. */
const toStorageState = (state: StorageStateLike) => ({
  cookies: (state.cookies ?? []).map((cookie) => ({ ...cookie })),
  origins: (state.origins ?? []).map((origin) => ({
    origin: origin.origin,
    localStorage: (origin.localStorage ?? []).map((entry) => ({ ...entry }))
  }))
})

export const make = (
  driverOptions: PlaywrightDriverOptions = {}
): BrowserDriver["Service"] => {
  const viewport = driverOptions.viewport ?? defaultViewport
  const sessionConfig: SessionConfig = {
    viewport,
    maxCaptureRecords: driverOptions.maxCaptureRecords ?? 5_000,
    ...(driverOptions.allowedOrigins === undefined ? {} : { allowedOrigins: driverOptions.allowedOrigins })
  }

  const openContext = (options: OpenContextOptions): Effect.Effect<BrowserSession, BrowserError, Scope> =>
    Effect.gen(function*() {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(options.screenshotsDir, { recursive: true })
          await mkdir(options.attemptDir, { recursive: true })
        },
        catch: (cause) => fromCause("open-context", cause, "capture")
      })

      // Finalizers run LIFO, so the context is always closed before the browser — the order the
      // video muxer requires.
      const browser: Browser = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            chromium.launch({
              headless: driverOptions.headless ?? true,
              // The typed equivalent of --no-sandbox; required in most CI containers.
              chromiumSandbox: false,
              // Playwright's default SIGINT/SIGTERM/SIGHUP handlers close the browser and then
              // call process.exit() themselves. In a harness that is fatal: Ctrl-C killed the
              // process ~130 ms in, so the run's uninterruptible finalize tail never ran — no
              // trace artifact, no `runFinished`, no `result.json` — and design-contracts §9/§12
              // could not be honoured. Signals belong to the runtime (NodeRuntime.runMain), which
              // interrupts the fiber; our own scope finalizers are what close the browser.
              handleSIGINT: false,
              handleSIGTERM: false,
              handleSIGHUP: false,
              args: [...(driverOptions.args ?? defaultArgs)],
              ...(driverOptions.executablePath === undefined
                ? {}
                : { executablePath: driverOptions.executablePath }),
              timeout: driverOptions.launchTimeoutMs ?? 30_000
            }),
          catch: (cause) => fromCause("launch", cause, "launch")
        }),
        (instance) => Effect.promise(() => instance.close().catch(() => undefined))
      )

      const state: ContextState = { closed: false, contextClosed: false }
      const context: BrowserContext = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            browser.newContext({
              baseURL: options.baseUrl,
              viewport: { ...viewport },
              deviceScaleFactor: 1,
              serviceWorkers: "block",
              strictSelectors: true,
              timezoneId: "UTC",
              locale: "en-US",
              ...(options.storageState === undefined ? {} : { storageState: toStorageState(options.storageState) }),
              ...(options.capture.video === "on"
                ? { recordVideo: { dir: join(options.attemptDir, ".video"), size: { width: 1280, height: 720 } } }
                : {})
            }),
          catch: (cause) => fromCause("open-context", cause, "launch")
        }),
        (instance) =>
          Effect.promise(async () => {
            // `closed` is flipped first so a cancellation cannot let a late action reach a
            // half-closed context. The guard on the close itself is `contextClosed`, which is only
            // set once `context.close()` has actually completed: a `finalize` that was cut short
            // after flipping `closed` still needs us to close the context here, or the video is
            // never muxed.
            state.closed = true
            if (!state.contextClosed) {
              await instance.close().catch(() => undefined)
              state.contextClosed = true
            }
          })
      )

      // In library mode there is NO default action timeout: without these two calls a missing
      // element wedges the agent loop forever.
      context.setDefaultTimeout(options.operationTimeoutMs)
      context.setDefaultNavigationTimeout(options.operationTimeoutMs)

      if (options.capture.trace === "on") {
        yield* Effect.tryPromise({
          try: () =>
            context.tracing.start({
              screenshots: true,
              // NEVER `aria: true`: tracing then takes a DEFAULT-mode aria snapshot on every
              // action, which disarms every outstanding [ref=…] (api-playwright.md §2 gotcha B).
              // Verified in .recon/bp-t2.mjs: with aria:true, aria-ref=e7 resolves to 0 elements.
              snapshots: { dom: true, screen: true },
              sources: false,
              title: options.attemptId
            }),
          catch: (cause) => fromCause("trace-start", cause, "capture")
        })
      }

      const page = yield* Effect.tryPromise({
        try: () => context.newPage(),
        catch: (cause) => fromCause("open-context", cause, "launch")
      })

      const session = yield* makeSession(context, page, options, sessionConfig, state)

      // A cancelled attempt still has to settle its evidence. This finalizer is registered last, so
      // it runs FIRST: trace stopped, logs written, context closed (which is what finalises the
      // video) — all before the context/browser finalizers above. `finalize` is idempotent, so a
      // runner that got there on its own pays nothing.
      yield* Effect.addFinalizer(() =>
        session.finalize({ retainTrace: true }).pipe(
          Effect.timeoutOrElse({
            duration: 15_000,
            orElse: () => Effect.succeed([] as ReadonlyArray<CaptureOutcome>)
          }),
          Effect.asVoid
        )
      )
      return session
    })

  return { id: "playwright-chromium", openContext }
}

export const layer = (options: PlaywrightDriverOptions = {}): Layer.Layer<BrowserDriver> =>
  Layer.succeed(BrowserDriver, make(options))
