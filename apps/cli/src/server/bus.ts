import type { HarnessEvent } from "@harness/core"
import { Cause, Deferred, Effect, Queue, Scope } from "effect"

/**
 * One message on the dashboard stream. `seq` is the bus's OWN monotonic cursor, contiguous from 1,
 * and it is what `Last-Event-ID` refers to — so a reconnect can be answered exactly, whatever the
 * underlying run journal did.
 */
export interface UiMessage {
  readonly seq: number
  readonly ts: string
  readonly type: string
  readonly data: unknown
}

export interface Subscription {
  /** Bounded and DROPPING: a slow client can never make the publisher wait. */
  readonly queue: Queue.Queue<UiMessage, Cause.Done>
  /** Taken AFTER the queue is registered, so nothing published in between is lost. */
  readonly snapshotAfter: (seq: number) => ReadonlyArray<UiMessage>
}

export interface RunBus {
  readonly journal: () => ReadonlyArray<UiMessage>
  readonly publish: (type: string, data: unknown) => Effect.Effect<void>
  readonly publishEvent: (runId: string, event: HarnessEvent) => Effect.Effect<void>
  readonly subscribe: Effect.Effect<Subscription, never, Scope.Scope>
  readonly subscriberCount: () => number
  /** A dashboard cancel request. Completing the deferred asks the runner to stop cleanly. */
  readonly requestCancel: (reason: string) => Effect.Effect<boolean>
  readonly cancellation: Deferred.Deferred<string>
  /** Ends every open stream so connected clients see a clean close instead of a dropped socket. */
  readonly close: Effect.Effect<void>
}

export interface RunBusOptions {
  /** Per-client backlog before messages start being dropped; the client recovers by reconnecting. */
  readonly clientCapacity?: number
}

export const makeRunBus = (options: RunBusOptions = {}): Effect.Effect<RunBus> =>
  Effect.gen(function*() {
    const capacity = options.clientCapacity ?? 512
    const cancellation = yield* Deferred.make<string>()
    const journal: Array<UiMessage> = []
    const subscribers = new Set<Queue.Queue<UiMessage, Cause.Done>>()
    let seq = 0

    const publish = (type: string, data: unknown): Effect.Effect<void> =>
      Effect.suspend(() => {
        const message: UiMessage = { seq: ++seq, ts: new Date().toISOString(), type, data }
        journal.push(message)
        return Effect.forEach(
          [...subscribers],
          // `offer` on a dropping queue resolves immediately whether or not the message fit.
          (queue) => Queue.offer(queue, message),
          { discard: true }
        )
      })

    const subscribe = Effect.gen(function*() {
      const queue = yield* Queue.dropping<UiMessage, Cause.Done>(capacity)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          subscribers.add(queue)
        }),
        () =>
          Effect.sync(() => {
            subscribers.delete(queue)
          })
      )
      return {
        queue,
        // Registration happened first: the snapshot may overlap the queue, never skip it.
        snapshotAfter: (after: number) => journal.filter((m) => m.seq > after)
      } satisfies Subscription
    })

    return {
      journal: () => journal,
      publish,
      publishEvent: (runId, event) => publish("harness", { runId, event }),
      subscribe,
      subscriberCount: () => subscribers.size,
      requestCancel: (reason) => Deferred.succeed(cancellation, reason),
      cancellation,
      close: Effect.suspend(() =>
        Effect.forEach([...subscribers], (queue) => Queue.end(queue), { discard: true })
      )
    }
  })
