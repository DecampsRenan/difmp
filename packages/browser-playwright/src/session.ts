import type {
  BrowserSession,
  CaptureOutcome,
  InteractionResult,
  NavigateResult,
  ObservedElement,
  ObserveResult,
  OpenContextOptions
} from "@harness/core"
import { BrowserError, checkNavigationOrigin } from "@harness/core"
import { Effect, Semaphore } from "effect"
import { mkdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { BrowserContext, Locator, Page, Video } from "playwright"
import type { Recorders } from "./capture.js"
import { attachRecorders, toJsonl } from "./capture.js"
import { browserError, fromCause } from "./errors.js"
import { parseAiSnapshot } from "./snapshot.js"

/** A model-supplied ref reaches a selector string, so it is validated before it gets there. */
const REF_SHAPE = /^[a-z0-9]+$/

/** How long an action waits to see whether it started a navigation. */
const NAVIGATION_PROBE_MS = 500

export interface SessionConfig {
  readonly viewport: { readonly width: number; readonly height: number }
  readonly maxCaptureRecords: number
  /** When set, `navigate` re-applies core's origin policy as a second line of defence. */
  readonly allowedOrigins?: ReadonlyArray<string>
}

interface CurrentObservation {
  readonly observationId: string
  readonly refs: ReadonlySet<string>
}

const sizeOf = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}

const outcome = (
  kind: CaptureOutcome["kind"],
  state: CaptureOutcome["state"],
  extra: { label?: string; path?: string; reason?: string; bytes?: number }
): CaptureOutcome => ({
  kind,
  state,
  ...(extra.label === undefined ? {} : { label: extra.label }),
  ...(extra.path === undefined ? {} : { path: extra.path }),
  ...(extra.reason === undefined ? {} : { reason: extra.reason }),
  ...(extra.bytes === undefined ? {} : { bytes: extra.bytes })
})

/**
 * Shared with the driver's scope finalizer: whoever closes the context first flips it, so an action
 * that arrives after a cancellation is refused instead of racing a half-closed context.
 */
export interface ContextState {
  closed: boolean
}

export const makeSession = (
  context: BrowserContext,
  page: Page,
  options: OpenContextOptions,
  config: SessionConfig,
  state: ContextState
): Effect.Effect<BrowserSession, BrowserError> =>
  Effect.gen(function*() {
    const lock = yield* Semaphore.make(1)
    const recorders: Recorders = attachRecorders(context, config.maxCaptureRecords)
    const timeout = options.operationTimeoutMs
    const video: Video | null = page.video()

    let current: CurrentObservation | undefined
    let navigations = 0

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        navigations += 1
        // Every ref is minted against one document; a new document invalidates all of them.
        current = undefined
      }
    })

    const ensureOpen = (operation: string): Effect.Effect<void, BrowserError> =>
      state.closed
        ? Effect.fail(browserError(operation, "closed", "the browser context is closed; no further action is possible"))
        : Effect.void

    const attempt = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => fromCause(operation, cause)
      })

    /**
     * Resolves a model-supplied reference. A stale, unknown or ambiguous reference is a typed
     * failure asking for a re-observation — it NEVER degrades into acting on another element.
     */
    const resolveRef = (
      operation: string,
      observationId: string,
      ref: string
    ): Effect.Effect<Locator, BrowserError> =>
      Effect.gen(function*() {
        if (current === undefined) {
          return yield* Effect.fail(
            browserError(
              operation,
              "stale-reference",
              `no observation is live (the page changed since the last observe); call observe again before using ${ref}`
            )
          )
        }
        if (current.observationId !== observationId) {
          return yield* Effect.fail(
            browserError(
              operation,
              "stale-reference",
              `observation ${observationId} is stale (current: ${current.observationId}); call observe again`
            )
          )
        }
        if (!REF_SHAPE.test(ref) || !current.refs.has(ref)) {
          return yield* Effect.fail(
            browserError(
              operation,
              "stale-reference",
              `reference ${ref} does not belong to observation ${observationId}; call observe again`
            )
          )
        }
        const locator = page.locator(`aria-ref=${ref}`)
        // A dead ref resolves to 0 elements; acting on it would only burn the whole action timeout.
        const count = yield* attempt(operation, () => locator.count())
        if (count === 0) {
          return yield* Effect.fail(
            browserError(
              operation,
              "stale-reference",
              `reference ${ref} no longer resolves to an element on this page; call observe again`
            )
          )
        }
        if (count > 1) {
          return yield* Effect.fail(
            browserError(
              operation,
              "stale-reference",
              `reference ${ref} resolves to ${count} elements; call observe again and pick an unambiguous one`
            )
          )
        }
        return locator
      })

    const didNavigate = (before: number, probeMs: number) =>
      attempt("navigation-probe", async () => {
        const deadline = Date.now() + probeMs
        while (navigations === before && Date.now() < deadline) {
          await page.waitForTimeout(25)
        }
        if (navigations === before) return false
        await page.waitForLoadState("load", { timeout }).catch(() => undefined)
        return true
      })

    const guarded = <A>(operation: string, effect: Effect.Effect<A, BrowserError>) =>
      lock.withPermits(1)(Effect.flatMap(ensureOpen(operation), () => effect))

    const observe = (observationId: string): Effect.Effect<ObserveResult, BrowserError> =>
      guarded(
        "observe",
        Effect.gen(function*() {
          // `mode: "ai"` is mandatory: one default-mode snapshot disarms every outstanding ref.
          const snapshot = yield* attempt("observe", (signal) => page.ariaSnapshot({ mode: "ai", timeout, signal }))
          const title = yield* attempt("observe", () => page.title())
          const elements: ReadonlyArray<ObservedElement> = parseAiSnapshot(snapshot)
          current = { observationId, refs: new Set(elements.map((element) => element.ref)) }
          return { observationId, url: page.url(), title, snapshot, elements }
        })
      )

    const navigate = (params: { readonly url: string }): Effect.Effect<NavigateResult, BrowserError> =>
      guarded(
        "navigate",
        Effect.gen(function*() {
          if (config.allowedOrigins !== undefined) {
            yield* checkNavigationOrigin(params.url, config.allowedOrigins).pipe(
              Effect.mapError((cause) => browserError("navigate", "navigation", cause.message))
            )
          }
          yield* attempt("navigate", (signal) => page.goto(params.url, { waitUntil: "commit", timeout, signal }))
          const settled = yield* attempt(
            "navigate",
            () => page.waitForLoadState("load", { timeout }).then(() => true, () => false)
          )
          current = undefined
          return { url: page.url(), settled }
        })
      )

    const interaction = (
      operation: string,
      run: (signal: AbortSignal) => Promise<void>,
      probeMs: number
    ): Effect.Effect<InteractionResult, BrowserError> =>
      Effect.gen(function*() {
        const before = navigations
        yield* attempt(operation, run)
        const navigated = yield* didNavigate(before, probeMs)
        return { performed: true as const, navigated }
      })

    const click = (params: { readonly observationId: string; readonly ref: string }) =>
      guarded(
        "click",
        Effect.flatMap(
          resolveRef("click", params.observationId, params.ref),
          (locator) =>
            interaction("click", (signal) => locator.click({ timeout, signal }), NAVIGATION_PROBE_MS)
        )
      )

    const fill = (params: { readonly observationId: string; readonly ref: string; readonly value: string }) =>
      guarded(
        "fill",
        Effect.flatMap(
          resolveRef("fill", params.observationId, params.ref),
          (locator) => interaction("fill", (signal) => locator.fill(params.value, { timeout, signal }), 0)
        )
      )

    const press = (params: { readonly observationId?: string; readonly ref?: string; readonly key: string }) =>
      guarded(
        "press",
        Effect.gen(function*() {
          if (params.ref !== undefined) {
            if (params.observationId === undefined) {
              return yield* Effect.fail(
                browserError("press", "stale-reference", "a ref can only be used together with its observationId")
              )
            }
            const locator = yield* resolveRef("press", params.observationId, params.ref)
            return yield* interaction(
              "press",
              (signal) => locator.press(params.key, { timeout, signal }),
              NAVIGATION_PROBE_MS
            )
          }
          // A keyboard-level press targets no element, but a stale observationId is still a sign
          // the agent believes it is looking at another page — refuse and ask it to re-observe.
          if (params.observationId !== undefined && current?.observationId !== params.observationId) {
            return yield* Effect.fail(
              browserError(
                "press",
                "stale-reference",
                `observation ${params.observationId} is stale (current: ${current?.observationId ?? "none"}); call observe again`
              )
            )
          }
          return yield* interaction(
            "press",
            () => page.keyboard.press(params.key, { delay: 0 }),
            NAVIGATION_PROBE_MS
          )
        })
      )

    const scroll = (params: { readonly direction: "up" | "down"; readonly amount?: number }) =>
      guarded(
        "scroll",
        Effect.gen(function*() {
          const distance = params.amount ?? Math.round(config.viewport.height * 0.8)
          const delta = params.direction === "down" ? distance : -distance
          yield* attempt("scroll", async () => {
            try {
              await page.mouse.wheel(0, delta)
            } catch {
              await page.evaluate((by: number) => window.scrollBy(0, by), delta)
            }
          })
          // Scrolling never navigates, but it can lazily load content: refs survive, the view does not.
          return { performed: true as const, navigated: false }
        })
      )

    const screenshot = (
      params: { readonly fileName: string; readonly label?: string; readonly fullPage?: boolean }
    ): Effect.Effect<CaptureOutcome> => {
      const target = join(options.screenshotsDir, params.fileName)
      return lock.withPermits(1)(
        Effect.gen(function*() {
          yield* ensureOpen("screenshot")
          yield* attempt("screenshot", async () => {
            await mkdir(dirname(target), { recursive: true })
            await page.screenshot({
              path: target,
              fullPage: params.fullPage ?? false,
              animations: "disabled",
              caret: "hide",
              scale: "css",
              timeout
            })
          })
          const bytes = yield* Effect.promise(() => sizeOf(target))
          return outcome("screenshot", "present", {
            path: target,
            ...(params.label === undefined ? {} : { label: params.label }),
            ...(bytes === undefined ? {} : { bytes })
          })
        })
      ).pipe(
        // A capture failure is recorded, never hidden, and never fails the run.
        Effect.catch((error: BrowserError) =>
          Effect.succeed(
            outcome("screenshot", "failed", {
              ...(params.label === undefined ? {} : { label: params.label }),
              reason: error.message
            })
          )
        )
      )
    }

    const writeLog = (
      kind: "console-log" | "network-log",
      path: string,
      records: ReadonlyArray<unknown>
    ): Effect.Effect<CaptureOutcome> =>
      attempt("write-log", async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, toJsonl(records), "utf8")
        return (await sizeOf(path)) ?? 0
      }).pipe(
        Effect.map((bytes) => outcome(kind, "present", { path, bytes })),
        Effect.catch((error: BrowserError) => Effect.succeed(outcome(kind, "failed", { reason: error.message })))
      )

    const finalize = (finalizeOptions: { readonly retainTrace: boolean }): Effect.Effect<ReadonlyArray<CaptureOutcome>> =>
      lock.withPermits(1)(
        Effect.gen(function*() {
          if (state.closed) return []
          state.closed = true
          const captures: Array<CaptureOutcome> = []
          const tracePath = join(options.attemptDir, "trace.zip")

          // 1. The zip is finalised immediately, so it can (and must) be stopped before close().
          if (options.capture.trace === "on") {
            const stopped = yield* attempt("trace-stop", async () => {
              if (finalizeOptions.retainTrace) {
                await mkdir(dirname(tracePath), { recursive: true })
                await context.tracing.stop({ path: tracePath })
                return (await sizeOf(tracePath)) ?? 0
              }
              await context.tracing.stop()
              return -1
            }).pipe(Effect.result)
            if (stopped._tag === "Failure") {
              captures.push(outcome("trace", "failed", { reason: stopped.failure.message }))
            } else if (stopped.success === -1) {
              captures.push(
                outcome("trace", "missing", { reason: "discarded: capture.retainTraceOn is \"failure\" and the attempt passed" })
              )
            } else {
              captures.push(outcome("trace", "present", { path: tracePath, bytes: stopped.success }))
            }
          }

          // 2. Closing the CONTEXT is what finalises the video; browser.close() alone leaves 0 bytes.
          const contextClosed = yield* attempt("context-close", () => context.close()).pipe(Effect.result)

          captures.push(
            yield* writeLog("console-log", join(options.attemptDir, "console.jsonl"), recorders.console)
          )
          captures.push(
            yield* writeLog("network-log", join(options.attemptDir, "network.jsonl"), recorders.network)
          )

          if (options.capture.video === "on") {
            if (video === null) {
              captures.push(outcome("video", "missing", { reason: "the page produced no video handle" }))
            } else if (contextClosed._tag === "Failure") {
              captures.push(
                outcome("video", "failed", {
                  reason: `the context did not close, so the video was never finalised: ${contextClosed.failure.message}`
                })
              )
            } else {
              const target = join(options.attemptDir, "video.webm")
              const saved = yield* attempt("video-save", async () => {
                await video.saveAs(target)
                await rm(join(options.attemptDir, ".video"), { recursive: true, force: true })
                return (await sizeOf(target)) ?? 0
              }).pipe(Effect.result)
              captures.push(
                saved._tag === "Failure"
                  ? outcome("video", "failed", { reason: saved.failure.message })
                  : outcome("video", "present", { path: target, bytes: saved.success })
              )
            }
          }
          return captures
        })
      ).pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CaptureOutcome>)))

    const session: BrowserSession = {
      observe,
      navigate,
      click,
      fill,
      press,
      scroll,
      screenshot,
      currentUrl: Effect.suspend(() =>
        state.closed
          ? Effect.fail(browserError("currentUrl", "closed", "the browser context is closed"))
          : Effect.succeed(page.url())
      ),
      consoleEntries: Effect.sync(() => recorders.consoleEntries()),
      networkEntries: Effect.sync(() => recorders.networkEntries()),
      finalize
    }
    return session
  })
