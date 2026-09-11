import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { UiRuntimeConfig } from "../runtime/config.js"
import { readContract } from "../types/contract.js"
import { harnessEventTypes, isHarnessEvent } from "../types/events.js"
import { emptyRunModel } from "./model.js"
import type { RunModel } from "./model.js"
import { runReducer } from "./reducer.js"

export type ConnectionState =
  /** No stream open yet. */
  | "connecting"
  /** Open and receiving. */
  | "live"
  /** The link dropped; a resume with the cursor is pending. */
  | "reconnecting"
  /** The run is over — we closed the stream on purpose. */
  | "closed"
  /** We gave up retrying. The user can resume manually. */
  | "unavailable"

export interface CancelState {
  readonly pending: boolean
  readonly requested: boolean
  readonly error?: string
}

export interface RunStream {
  readonly model: RunModel
  readonly connection: ConnectionState
  readonly attempts: number
  readonly cancel: CancelState
  readonly requestCancel: () => void
  readonly reconnectNow: () => void
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10_000] as const
const MAX_TAKEOVER_ATTEMPTS = 8

const withCursor = (url: string, lastSeq: number): string => {
  if (lastSeq <= 0) return url
  return `${url}${url.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(String(lastSeq))}`
}

export const useRunStream = (config: UiRuntimeConfig): RunStream => {
  const [model, dispatch] = useReducer(runReducer, emptyRunModel)
  const [connection, setConnection] = useState<ConnectionState>("connecting")
  const [attempts, setAttempts] = useState(0)
  const [cancel, setCancel] = useState<CancelState>({ pending: false, requested: false })

  /**
   * The resume cursor. Kept in a ref, not state: `onerror` can fire before React has committed the
   * dispatch that raised it, and resuming from a stale cursor would replay (and, without the
   * reducer's `seq > lastSeq` guard, duplicate) events.
   */
  const cursorRef = useRef(0)
  const finishedRef = useRef(false)
  const sourceRef = useRef<EventSource | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const takeoverRef = useRef(0)
  const disposedRef = useRef(false)
  const connectRef = useRef<(resume: boolean) => void>(() => {})

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const closeSource = () => {
    if (sourceRef.current !== null) {
      sourceRef.current.close()
      sourceRef.current = null
    }
  }

  const connect = useCallback((resume: boolean) => {
    if (disposedRef.current || finishedRef.current) return
    closeSource()
    clearTimer()
    setAttempts((n) => n + 1)

    const url = resume ? withCursor(config.eventsUrl, cursorRef.current) : config.eventsUrl
    let source: EventSource
    try {
      source = new EventSource(url)
    } catch {
      setConnection("unavailable")
      return
    }
    sourceRef.current = source

    source.onopen = () => {
      takeoverRef.current = 0
      setConnection("live")
    }

    /** A frame we cannot use is counted and logged rather than silently swallowed. */
    const drop = (raw: string, why: string) => {
      // eslint-disable-next-line no-console
      console.warn(`[harness-ui] trame ignorée (${why}) :`, raw.slice(0, 200))
      dispatch({ kind: "malformed" })
    }

    const onFrame = (message: MessageEvent<string>) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        drop(message.data, "JSON invalide")
        return
      }
      if (!isHarnessEvent(parsed)) {
        drop(message.data, "enveloppe inattendue")
        return
      }
      if (parsed.seq > cursorRef.current) cursorRef.current = parsed.seq
      if (parsed.type === "runFinished") {
        finishedRef.current = true
        clearTimer()
        closeSource()
        setConnection("closed")
      }
      dispatch({ kind: "event", event: parsed })
    }

    // The CLI names every frame after the event type; `onmessage` covers an unnamed frame.
    for (const type of harnessEventTypes) {
      source.addEventListener(type, onFrame as EventListener)
    }
    source.onmessage = onFrame

    source.onerror = () => {
      if (disposedRef.current) return
      if (finishedRef.current) {
        closeSource()
        setConnection("closed")
        return
      }
      if (source.readyState === EventSource.CLOSED) {
        // The browser gave up. Take over: resume explicitly from the cursor, backing off.
        closeSource()
        if (takeoverRef.current >= MAX_TAKEOVER_ATTEMPTS) {
          setConnection("unavailable")
          return
        }
        const delay = BACKOFF_MS[Math.min(takeoverRef.current, BACKOFF_MS.length - 1)] ?? 10_000
        takeoverRef.current += 1
        setConnection("reconnecting")
        clearTimer()
        timerRef.current = setTimeout(() => connectRef.current(true), delay)
        return
      }
      // readyState === CONNECTING: the browser is retrying by itself and will send Last-Event-ID.
      setConnection("reconnecting")
    }
  }, [config.eventsUrl])

  connectRef.current = connect

  useEffect(() => {
    disposedRef.current = false
    connect(false)
    return () => {
      disposedRef.current = true
      clearTimer()
      closeSource()
    }
  }, [connect])

  // The frozen contract supplies criterion text and `model` vs `code` — `contractFrozen` carries
  // ids only. Fetched once, then retried when the contract is actually frozen.
  const contractHash = model.contractHash
  const contractLoadedRef = useRef(false)
  useEffect(() => {
    if (contractLoadedRef.current) return
    let cancelled = false
    void fetch(config.contractUrl, { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((json: unknown) => {
        if (cancelled) return
        const contract = readContract(json)
        if (contract === undefined || contract.criteria.length === 0) return
        contractLoadedRef.current = true
        dispatch({ kind: "contract", contract })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [config.contractUrl, contractHash])

  const requestCancel = useCallback(() => {
    setCancel((current) => (current.pending ? current : { pending: true, requested: current.requested }))
    void fetch(config.cancelUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "annulation demandée depuis l'interface" })
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        setCancel({ pending: false, requested: true })
      })
      .catch((error: unknown) => {
        setCancel({
          pending: false,
          requested: false,
          error: error instanceof Error ? error.message : "échec de la requête d'annulation"
        })
      })
  }, [config.cancelUrl])

  const reconnectNow = useCallback(() => {
    takeoverRef.current = 0
    connectRef.current(true)
  }, [])

  return useMemo<RunStream>(() => ({
    model,
    connection,
    attempts,
    cancel: model.cancellation === undefined ? cancel : { ...cancel, pending: false, requested: true },
    requestCancel,
    reconnectNow
  }), [model, connection, attempts, cancel, requestCancel, reconnectNow])
}

/** A 1 s tick, live only while the run is running, so elapsed-time gauges stay honest. */
export const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}
