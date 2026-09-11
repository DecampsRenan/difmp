import type { FixtureCleanupReport, FixtureSession, Registries, StorageStateLike } from "@harness/core"
import { FixtureError, FixtureManager } from "@harness/core"
import { Duration, Effect, Layer, Option } from "effect"

type Cleanup = () => Promise<void> | void

const mergeStorageState = (
  state: StorageStateLike | undefined,
  cookies: StorageStateLike["cookies"],
  origins: StorageStateLike["origins"]
): StorageStateLike | undefined => {
  const allCookies = [...(state?.cookies ?? []), ...(cookies ?? [])]
  const allOrigins = [...(state?.origins ?? []), ...(origins ?? [])]
  if (allCookies.length === 0 && allOrigins.length === 0 && state === undefined) return undefined
  return { cookies: allCookies, origins: allOrigins }
}

/**
 * Runs the project's registered fixtures. Names resolve in the registry only — a spec can never
 * name an import path. Cleanups are registered AT ACQUISITION time, so a setup that fails halfway
 * is still torn down, and cleanup runs after success, failure AND cancellation under
 * `budgets.fixtureCleanupTimeoutMs`.
 */
export const fixtureManagerLayer = (registries: Registries): Layer.Layer<FixtureManager> =>
  Layer.succeed(
    FixtureManager,
    FixtureManager.of({
      setup: (request) =>
        Effect.gen(function*() {
          const fixture = yield* registries.fixtures.lookup(request.fixtureName).pipe(
            Effect.mapError((error) =>
              new FixtureError({ fixtureName: request.fixtureName, phase: "setup", reason: error.message })
            )
          )
          const cleanups: Array<Cleanup> = []
          const result = yield* Effect.tryPromise({
            try: () =>
              fixture({
                runId: request.runId,
                attemptId: request.attemptId,
                inputs: request.inputs,
                // Env-backed. Secret values never reach prompts, logs or reports.
                secrets: (name: string) => process.env[name],
                addCleanup: (fn: Cleanup) => {
                  cleanups.push(fn)
                },
                baseUrl: request.baseUrl
              }),
            catch: (cause) =>
              new FixtureError({
                fixtureName: request.fixtureName,
                phase: "setup",
                reason: cause instanceof Error ? cause.message : String(cause)
              })
          }).pipe(
            // A failed setup must still run whatever it managed to acquire.
            Effect.tapError(() => runCleanups(cleanups, 15_000))
          )

          const storageState = mergeStorageState(result.storageState, result.cookies, result.origins)
          return {
            fixtureName: request.fixtureName,
            publicValues: result.public ?? {},
            ...(storageState === undefined ? {} : { storageState }),
            cleanup: ({ timeoutMs }) => runCleanups(cleanups, timeoutMs)
          } satisfies FixtureSession
        })
    })
  )

/** Never fails: problems come back in the report so the runner can journal them. */
const runCleanups = (cleanups: ReadonlyArray<Cleanup>, timeoutMs: number): Effect.Effect<FixtureCleanupReport> =>
  Effect.suspend(() => {
    const errors: Array<string> = []
    let cleanupsRun = 0
    // Reverse order: the last thing acquired is the first thing released.
    const all = Effect.forEach(
      [...cleanups].reverse(),
      (fn) =>
        Effect.tryPromise({
          try: async () => {
            await fn()
          },
          catch: (cause) => (cause instanceof Error ? cause.message : String(cause))
        }).pipe(
          Effect.match({
            onFailure: (reason) => {
              errors.push(reason)
            },
            onSuccess: () => {
              cleanupsRun += 1
            }
          })
        ),
      { discard: true }
    )
    return all.pipe(
      Effect.timeoutOption(Duration.millis(Math.max(1, timeoutMs))),
      Effect.map((finished) => ({ cleanupsRun, timedOut: Option.isNone(finished), errors }))
    )
  })
