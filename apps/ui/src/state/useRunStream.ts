import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { UiRuntimeConfig } from "../runtime/config.js";
import { readContract } from "../types/contract.js";
import type { HarnessEvent } from "../types/events.js";
import { harnessEventTypes, isHarnessEvent } from "../types/events.js";
import { emptyRunModel } from "./model.js";
import type { CriterionView, RunModel } from "./model.js";
import { runReducer } from "./reducer.js";

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
  | "unavailable";

export interface CancelState {
  readonly pending: boolean;
  readonly requested: boolean;
  readonly error?: string;
}

export interface RunStream {
  readonly model: RunModel;
  /** Suite entries stay here after their run has finished; selecting one restores its full model. */
  readonly scenarios: ReadonlyArray<SuiteScenario>;
  readonly completed: number;
  readonly total: number;
  readonly suiteFinished: boolean;
  readonly connection: ConnectionState;
  readonly attempts: number;
  readonly cancel: CancelState;
  readonly requestCancel: () => void;
  readonly reconnectNow: () => void;
  readonly selectScenario: (runId: string) => void;
  readonly closeDashboard: () => void;
}

export interface SuiteScenario {
  readonly specPath: string;
  readonly runId?: string;
  readonly status: "pending" | "running" | RunModel["status"];
  /** Criteria frozen for this run — drives the nested assertion list in the live tree. */
  readonly assertions: ReadonlyArray<CriterionView>;
}

interface UiMessage {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly data: unknown;
}

const isUiMessage = (value: unknown): value is UiMessage => {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message["seq"] === "number" &&
    Number.isInteger(message["seq"]) &&
    message["seq"] > 0 &&
    typeof message["ts"] === "string" &&
    typeof message["type"] === "string" &&
    "data" in message
  );
};

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const withRunId = (url: string, runId: string | undefined): string => {
  if (runId === undefined) return url;
  const resolved = new URL(url, globalThis.location?.href ?? "http://127.0.0.1/");
  resolved.searchParams.set("runId", runId);
  return resolved.href;
};

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10_000] as const;
const MAX_TAKEOVER_ATTEMPTS = 8;

const withCursor = (url: string, lastSeq: number): string => {
  if (lastSeq <= 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(String(lastSeq))}`;
};

export const useRunStream = (config: UiRuntimeConfig): RunStream => {
  const [model, dispatch] = useReducer(runReducer, emptyRunModel);
  const [scenarios, setScenarios] = useState<ReadonlyArray<SuiteScenario>>([]);
  const [suiteProgress, setSuiteProgress] = useState({ completed: 0, total: 0, finished: false });
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [attempts, setAttempts] = useState(0);
  const [cancel, setCancel] = useState<CancelState>({ pending: false, requested: false });

  /**
   * The resume cursor. Kept in a ref, not state: `onerror` can fire before React has committed the
   * dispatch that raised it, and resuming from a stale cursor would replay (and, without the
   * reducer's `seq > lastSeq` guard, duplicate) events.
   */
  const cursorRef = useRef(0);
  const modelRef = useRef<RunModel>(emptyRunModel);
  const modelsRef = useRef(new Map<string, RunModel>());
  const selectedRunRef = useRef<string | undefined>(undefined);
  const suiteModeRef = useRef(false);
  const finishedRef = useRef(false);
  const sourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const takeoverRef = useRef(0);
  const disposedRef = useRef(false);
  const connectRef = useRef<(resume: boolean) => void>(() => {});

  const showModel = useCallback((next: RunModel) => {
    modelRef.current = next;
    dispatch({ kind: "replace", model: next });
  }, []);

  const applyHarnessEvent = useCallback(
    (event: HarnessEvent) => {
      const previous = modelsRef.current.get(event.runId) ?? emptyRunModel;
      const next = runReducer(previous, { kind: "event", event });
      modelsRef.current.set(event.runId, next);
      if (selectedRunRef.current === undefined) selectedRunRef.current = event.runId;
      if (selectedRunRef.current === event.runId) showModel(next);
      if (!suiteModeRef.current) return;
      setScenarios((current) => {
        const index = current.findIndex(
          (scenario) => scenario.runId === event.runId || scenario.specPath === next.specPath,
        );
        if (index < 0) {
          return [
            ...current,
            {
              specPath: next.specPath ?? event.runId,
              runId: event.runId,
              status: next.status,
              assertions: next.criteria,
            },
          ];
        }
        const row = current[index]!;
        const updated: SuiteScenario = {
          ...row,
          runId: event.runId,
          status: next.status,
          assertions: next.criteria,
          ...(next.specPath === undefined ? {} : { specPath: next.specPath }),
        };
        const copy = current.slice();
        copy[index] = updated;
        return copy;
      });
    },
    [showModel],
  );

  // Both touch refs only, so the empty dependency array is accurate rather than a silencing
  // trick — and it is what lets `connect` and the effects below list them without being
  // invalidated on every render.
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const closeSource = useCallback(() => {
    if (sourceRef.current !== null) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  const connect = useCallback(
    (resume: boolean) => {
      if (disposedRef.current || finishedRef.current) return;
      closeSource();
      clearTimer();
      setAttempts((n) => n + 1);

      const url = resume ? withCursor(config.eventsUrl, cursorRef.current) : config.eventsUrl;
      let source: EventSource;
      try {
        source = new EventSource(url);
      } catch {
        setConnection("unavailable");
        return;
      }
      sourceRef.current = source;

      source.addEventListener("open", () => {
        takeoverRef.current = 0;
        setConnection("live");
      });

      /** A frame we cannot use is counted and logged rather than silently swallowed. */
      const drop = (raw: string, why: string) => {
        console.warn(`[difmp-ui] frame dropped (${why}):`, raw.slice(0, 200));
        const next = runReducer(modelRef.current, { kind: "malformed" });
        if (next.runId !== undefined) modelsRef.current.set(next.runId, next);
        showModel(next);
      };

      const onFrame = (message: Event) => {
        /**
         * `error` is BOTH a harness event type and EventSource's own failure event, so the listener
         * registered for the journal type also receives the DOM one. The DOM event is a plain `Event`
         * with no `data`; it belongs to `onerror` and must not be counted as a malformed frame.
         */
        if (!(message instanceof MessageEvent) || typeof message.data !== "string") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          drop(message.data, "invalid JSON");
          return;
        }
        if (isHarnessEvent(parsed)) {
          // Kept for standalone/dev embeddings. The CLI injects its suite stream instead.
          if (parsed.seq > cursorRef.current) cursorRef.current = parsed.seq;
          if (parsed.type === "runFinished" && !suiteModeRef.current) {
            finishedRef.current = true;
            clearTimer();
            closeSource();
            setConnection("closed");
          }
          applyHarnessEvent(parsed);
          return;
        }

        if (!isUiMessage(parsed)) {
          drop(message.data, "unexpected envelope");
          return;
        }

        suiteModeRef.current = true;
        // The suite cursor, unlike each HarnessEvent.seq, never resets between scenarios.
        if (parsed.seq <= cursorRef.current) return;
        cursorRef.current = parsed.seq;
        const data = recordOf(parsed.data);

        if (parsed.type === "cliStarted") {
          const paths = data?.["scenarios"];
          if (Array.isArray(paths) && paths.every((path) => typeof path === "string")) {
            setScenarios(
              paths.map((specPath) => ({ specPath, status: "pending", assertions: [] })),
            );
            setSuiteProgress({ completed: 0, total: paths.length, finished: false });
          }
          return;
        }

        if (parsed.type === "scenarioStarted") {
          const runId = data?.["runId"];
          const specPath = data?.["specPath"];
          if (typeof runId !== "string" || typeof specPath !== "string") return;
          const initial: RunModel = { ...emptyRunModel, runId, specPath };
          modelsRef.current.set(runId, initial);
          selectedRunRef.current = runId;
          showModel(initial);
          setScenarios((current) => {
            const index = current.findIndex((scenario) => scenario.specPath === specPath);
            if (index < 0) {
              return [...current, { specPath, runId, status: "running", assertions: [] }];
            }
            const copy = current.slice();
            copy[index] = { ...copy[index]!, runId, status: "running" };
            return copy;
          });
          return;
        }

        if (parsed.type === "harness") {
          const event = data?.["event"];
          if (isHarnessEvent(event)) applyHarnessEvent(event);
          else drop(message.data, "invalid harness event");
          return;
        }

        if (parsed.type === "scenarioFinished") {
          const specPath = data?.["specPath"];
          const status = data?.["status"];
          if (
            typeof specPath !== "string" ||
            typeof status !== "string" ||
            !["passed", "failed", "inconclusive", "error", "cancelled"].includes(status)
          )
            return;
          setScenarios((current) =>
            current.map((scenario) =>
              scenario.specPath === specPath
                ? {
                    ...scenario,
                    status: status as SuiteScenario["status"],
                  }
                : scenario,
            ),
          );
          setSuiteProgress((current) => ({
            ...current,
            completed: Math.min(current.completed + 1, current.total || current.completed + 1),
          }));
          return;
        }

        if (parsed.type === "cliFinished") {
          const completed = data?.["completed"];
          const total = data?.["total"];
          setSuiteProgress((current) => ({
            completed: typeof completed === "number" ? completed : current.completed,
            total: typeof total === "number" ? total : current.total,
            finished: true,
          }));
          finishedRef.current = true;
          clearTimer();
          closeSource();
          setConnection("closed");
          return;
        }
      };

      // The CLI names every frame after the event type; `onmessage` covers an unnamed frame.
      for (const type of harnessEventTypes) {
        source.addEventListener(type, onFrame);
      }
      for (const type of [
        "harness",
        "cliStarted",
        "cliFinished",
        "scenarioStarted",
        "scenarioFinished",
        "cancellationRequested",
      ]) {
        source.addEventListener(type, onFrame);
      }
      source.addEventListener("message", onFrame);

      source.addEventListener("error", () => {
        if (disposedRef.current) return;
        if (finishedRef.current) {
          closeSource();
          setConnection("closed");
          return;
        }
        if (source.readyState === EventSource.CLOSED) {
          // The browser gave up. Take over: resume explicitly from the cursor, backing off.
          closeSource();
          if (takeoverRef.current >= MAX_TAKEOVER_ATTEMPTS) {
            setConnection("unavailable");
            return;
          }
          const delay = BACKOFF_MS[Math.min(takeoverRef.current, BACKOFF_MS.length - 1)] ?? 10_000;
          takeoverRef.current += 1;
          setConnection("reconnecting");
          clearTimer();
          timerRef.current = setTimeout(() => connectRef.current(true), delay);
          return;
        }
        // readyState === CONNECTING: the browser is retrying by itself and will send Last-Event-ID.
        setConnection("reconnecting");
      });
    },
    [config.eventsUrl, clearTimer, closeSource, applyHarnessEvent, showModel],
  );

  // Writing a ref during render is a render side effect: React may call the render function
  // without committing it, which would leave `connectRef` pointing at a `connect` that never
  // took effect. Declared before the mounting effect below so the ref is current by the time
  // anything can read it.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    disposedRef.current = false;
    // `connect` opens the EventSource, which is precisely the "synchronising with an external
    // system" the rule's own guidance carves out; the setState it reaches is the attempt counter
    // recording that we opened one. The rule cannot see past the call.
    // oxlint-disable-next-line react/set-state-in-effect
    connect(false);
    return () => {
      disposedRef.current = true;
      clearTimer();
      closeSource();
    };
  }, [connect, clearTimer, closeSource]);

  // The frozen contract supplies criterion text and `model` vs `code` — `contractFrozen` carries
  // ids only. Fetched once, then retried when the contract is actually frozen.
  const contractHash = model.contractHash;
  const loadedContractsRef = useRef(new Set<string>());
  useEffect(() => {
    const runId = model.runId;
    const loadKey = runId ?? "standalone";
    if (loadedContractsRef.current.has(loadKey)) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(
          withRunId(config.contractUrl, suiteModeRef.current ? runId : undefined),
          {
            headers: { accept: "application/json" },
          },
        );
        if (!response.ok) return;
        const json: unknown = await response.json();
        if (cancelled) return;
        const contract = readContract(json);
        if (contract === undefined || contract.criteria.length === 0) return;
        loadedContractsRef.current.add(loadKey);
        const previous = runId === undefined ? modelRef.current : modelsRef.current.get(runId);
        if (previous === undefined) return;
        const next = runReducer(previous, { kind: "contract", contract });
        if (runId !== undefined) modelsRef.current.set(runId, next);
        if (runId === undefined || selectedRunRef.current === runId) showModel(next);
        if (runId !== undefined) {
          setScenarios((current) =>
            current.map((scenario) =>
              scenario.runId === runId ? { ...scenario, assertions: next.criteria } : scenario,
            ),
          );
        }
      } catch {
        // The contract is an enrichment, not a requirement: without it the dashboard still
        // renders every criterion, by id. A retry comes on the next `contractHash` change.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // `contractHash` is an intentional extra dependency: the effect body never reads it, but the
    // contract is only worth re-fetching once the run has actually frozen one, and the hash
    // changing is that signal.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [config.contractUrl, contractHash, model.runId, showModel]);

  const requestCancel = useCallback(() => {
    setCancel((current) =>
      current.pending ? current : { pending: true, requested: current.requested },
    );
    const send = async (): Promise<void> => {
      try {
        const response = await fetch(config.cancelUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "cancellation requested from the dashboard" }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setCancel({ pending: false, requested: true });
      } catch (error: unknown) {
        setCancel({
          pending: false,
          requested: false,
          error: error instanceof Error ? error.message : "the cancellation request failed",
        });
      }
    };
    void send();
  }, [config.cancelUrl]);

  const reconnectNow = useCallback(() => {
    takeoverRef.current = 0;
    connectRef.current(true);
  }, []);

  const selectScenario = useCallback(
    (runId: string) => {
      const selected = modelsRef.current.get(runId);
      if (selected === undefined) return;
      selectedRunRef.current = runId;
      showModel(selected);
    },
    [showModel],
  );

  const closeDashboard = useCallback(() => {
    if (config.closeUrl === undefined) return;
    void fetch(config.closeUrl, { method: "POST" });
  }, [config.closeUrl]);

  return useMemo<RunStream>(
    () => ({
      model,
      scenarios,
      completed: suiteProgress.completed,
      total: suiteProgress.total,
      suiteFinished: suiteProgress.finished,
      connection,
      attempts,
      cancel:
        model.cancellation === undefined ? cancel : { ...cancel, pending: false, requested: true },
      requestCancel,
      reconnectNow,
      selectScenario,
      closeDashboard,
    }),
    [
      model,
      scenarios,
      suiteProgress,
      connection,
      attempts,
      cancel,
      requestCancel,
      reconnectNow,
      selectScenario,
      closeDashboard,
    ],
  );
};

/** A 1 s tick, live only while the run is running, so elapsed-time gauges stay honest. */
export const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
};
