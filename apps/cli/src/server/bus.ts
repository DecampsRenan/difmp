import type { HarnessEvent } from "@difmp/core"
import { Cause, Deferred, Effect, Queue, Scope } from "effect"

/**
 * One message on the CLI's own dashboard stream. `seq` is the bus's OWN monotonic cursor,
 * contiguous from 1, and it is what `Last-Event-ID` refers to on `/api/events` — so a reconnect can
 * be answered exactly, whatever the underlying run journals did.
 */
export interface UiMessage {
  readonly seq: number
  readonly ts: string
  readonly type: string
  readonly data: unknown
}

export interface Subscription<A> {
  /** Bounded and DROPPING: a slow client can never make the publisher wait. */
  readonly queue: Queue.Queue<A, Cause.Done>
  /** Taken AFTER the queue is registered, so nothing published in between is lost. */
  readonly snapshotAfter: (seq: number) => ReadonlyArray<A>
}

/** Which run the dashboard is currently following. */
export interface CurrentRun {
  readonly runId: string
  /** Absolute path of `runs/<run-id>`; `/api/contract` and `/api/artifacts/*` read from here. */
  readonly directory: string
  readonly specPath: string
}

interface Channel<A> {
  readonly journal: () => ReadonlyArray<A>
  readonly publish: (value: A) => Effect.Effect<void>
  readonly subscribe: Effect.Effect<Subscription<A>, never, Scope.Scope>
  readonly subscriberCount: () => number
  readonly reset: () => void
  readonly close: Effect.Effect<void>
}

/**
 * A journal plus a set of bounded, dropping per-client queues. Two things make this safe for a
 * runner that must never be slowed down by a dashboard: `publish` only appends and offers (an
 * offer to a dropping queue resolves immediately whether or not it fit), and the journal is the
 * authority a reconnecting or lagging client is answered from.
 */
const makeChannel = <A>(seqOf: (value: A) => number, capacity: number): Effect.Effect<Channel<A>> =>
  Effect.sync(() => {
    let journal: Array<A> = []
    const subscribers = new Set<Queue.Queue<A, Cause.Done>>()
    return {
      journal: () => journal,
      publish: (value) =>
        Effect.suspend(() => {
          journal.push(value)
          return Effect.forEach([...subscribers], (queue) => Queue.offer(queue, value), { discard: true })
        }),
      subscribe: Effect.gen(function*() {
        const queue = yield* Queue.dropping<A, Cause.Done>(capacity)
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
          snapshotAfter: (after: number) => journal.filter((value) => seqOf(value) > after)
        } satisfies Subscription<A>
      }),
      subscriberCount: () => subscribers.size,
      reset: () => {
        journal = []
      },
      close: Effect.suspend(() => Effect.forEach([...subscribers], (queue) => Queue.end(queue), { discard: true }))
    }
  })

export interface RunBus {
  /** The CLI's own stream: scenario lifecycle plus every harness event, wrapped. */
  readonly journal: () => ReadonlyArray<UiMessage>
  readonly publish: (type: string, data: unknown) => Effect.Effect<void>
  /**
   * The stream `apps/ui` consumes: RAW `HarnessEvent`s, `id:` = the event's own `seq`, reset at the
   * start of each scenario because the UI models exactly one run and closes on `runFinished`.
   */
  readonly harnessJournal: () => ReadonlyArray<HarnessEvent>
  readonly publishEvent: (runId: string, event: HarnessEvent) => Effect.Effect<void>
  readonly subscribe: Effect.Effect<Subscription<UiMessage>, never, Scope.Scope>
  readonly subscribeHarness: Effect.Effect<Subscription<HarnessEvent>, never, Scope.Scope>
  readonly subscriberCount: () => number
  readonly currentRun: () => CurrentRun | undefined
  readonly startRun: (run: CurrentRun) => Effect.Effect<void>
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
    let seq = 0
    let current: CurrentRun | undefined

    const ui = yield* makeChannel<UiMessage>((m) => m.seq, capacity)
    const harness = yield* makeChannel<HarnessEvent>((e) => e.seq, capacity)

    const publish = (type: string, data: unknown): Effect.Effect<void> =>
      Effect.suspend(() => ui.publish({ seq: ++seq, ts: new Date().toISOString(), type, data }))

    return {
      journal: ui.journal,
      publish,
      harnessJournal: harness.journal,
      publishEvent: (runId, event) =>
        Effect.andThen(harness.publish(event), publish("harness", { runId, event })),
      subscribe: ui.subscribe,
      subscribeHarness: harness.subscribe,
      subscriberCount: () => ui.subscriberCount() + harness.subscriberCount(),
      currentRun: () => current,
      startRun: (run) =>
        Effect.suspend(() => {
          current = run
          // The UI's cursor is the run's own `seq`, which restarts at 1 for every scenario.
          harness.reset()
          return publish("scenarioStarted", { specPath: run.specPath, runId: run.runId })
        }),
      requestCancel: (reason) => Deferred.succeed(cancellation, reason),
      cancellation,
      close: Effect.andThen(ui.close, harness.close)
    }
  })
