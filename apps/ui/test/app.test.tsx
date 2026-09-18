import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { HarnessEvent } from "../src/types/events.js";
import { capture, criterionResult, eventStream, resolvedConfig } from "./factories.js";

/**
 * End-to-end wiring of the dashboard: <App /> → useRunStream → runReducer → every panel. Only the
 * two systems jsdom cannot provide are faked — the SSE transport and `fetch`. Everything in
 * between is the production code, and every assertion goes through the rendered DOM.
 */

const sources: Array<FakeEventSource> = [];

/**
 * `useRunStream` depends on four details of EventSource, so the fake honours all four: the
 * CONNECTING/OPEN/CLOSED statics it compares the GLOBAL against, a `readyState` a test can set
 * before failing the stream, the URL it was constructed with (the resume cursor is asserted
 * through it), and real `MessageEvent` frames — the frame handler drops anything else.
 */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState: number = FakeEventSource.CONNECTING;
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    sources.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

const latestSource = (): FakeEventSource => {
  const source = sources.at(-1);
  if (source === undefined) throw new Error("no EventSource was opened");
  return source;
};

const jsonResponse = (body: unknown, init: { ok?: boolean; status?: number } = {}): Response =>
  ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  }) as unknown as Response;

interface FetchRoutes {
  readonly contract?: () => Promise<Response>;
  readonly cancel?: () => Promise<Response>;
  readonly close?: () => Promise<Response>;
}

const stubFetch = (routes: FetchRoutes = {}) => {
  const fetchMock = vi.fn<(input: unknown) => Promise<Response>>((input) => {
    const url = String(input);
    const route = url.includes("cancel")
      ? routes.cancel
      : url.includes("close")
        ? routes.close
        : routes.contract;
    return route === undefined
      ? Promise.resolve(jsonResponse({}, { ok: false, status: 404 }))
      : route();
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

const configure = (config: Record<string, unknown>): void => {
  (globalThis as { __DIFMP_UI__?: unknown }).__DIFMP_UI__ = config;
};

/** The mounting effect starts a contract fetch; flushing it here keeps every test race-free. */
const renderApp = async (): Promise<ReturnType<typeof render>> => {
  const view = render(<App />);
  await act(async () => {});
  return view;
};

const openStream = async (): Promise<void> => {
  const source = latestSource();
  await act(async () => {
    source.readyState = FakeEventSource.OPEN;
    source.dispatchEvent(new Event("open"));
  });
};

/** The CLI names every SSE frame after the harness event type, so the fake does too. */
const deliver = async (...events: ReadonlyArray<HarnessEvent>): Promise<void> => {
  const source = latestSource();
  await act(async () => {
    for (const event of events) {
      source.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    }
  });
};

const deliverRaw = async (data: string, type = "message"): Promise<void> => {
  const source = latestSource();
  await act(async () => {
    source.dispatchEvent(new MessageEvent(type, { data }));
  });
};

let uiSeq = 0;
const deliverUi = async (type: string, data: unknown): Promise<void> => {
  const message = {
    seq: ++uiSeq,
    ts: `2026-09-12T10:00:${String(uiSeq).padStart(2, "0")}.000Z`,
    type,
    data,
  };
  await deliverRaw(JSON.stringify(message), type);
};

const failStream = async (readyState: number): Promise<void> => {
  const source = latestSource();
  await act(async () => {
    source.readyState = readyState;
    source.dispatchEvent(new Event("error"));
  });
};

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const stats = (): HTMLElement => screen.getByTestId("stream-stats");
const timelineRows = (): ReadonlyArray<HTMLElement> => screen.queryAllByTestId("timeline-entry");

const timelineRowOf = (kind: string): HTMLElement => {
  const row = timelineRows().find((entry) => entry.dataset["kind"] === kind);
  if (row === undefined) throw new Error(`no ${kind} row in the timeline`);
  return row;
};

const elapsed = (): HTMLElement => screen.getByTestId("elapsed");

/** A relative artifact base resolves against the page URL; derived so no jsdom URL is baked in. */
const pageOrigin = new URL(globalThis.location.href).origin;

/** A resolved configuration plus one model call: the smallest run that has a cost to show. */
const spend = (emit: ReturnType<typeof eventStream>): ReadonlyArray<HarnessEvent> => [
  emit("configResolved", { config: resolvedConfig() }),
  emit("modelCallFinished", {
    role: "browser",
    callId: "m1",
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    toolCalls: 1,
  }),
];

const runStartedPayload = {
  specPath: "specs/checkout.e2e.md",
  scenarioId: "checkout-flow",
  harnessVersion: "0.1.0",
} as const;

const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  sources.length = 0;
  uiSeq = 0;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  stubFetch();
});

describe("App — multi-scenario suite", () => {
  it("keeps completed histories selectable and closes only after cliFinished", async () => {
    configure({ eventsUrl: "/api/events", closeUrl: "/api/close" });
    const fetchMock = stubFetch({ close: () => Promise.resolve(jsonResponse({ accepted: true })) });
    const first = eventStream("run-one");
    const second = eventStream("run-two");
    await renderApp();
    await openStream();

    await deliverUi("cliStarted", { scenarios: ["specs/one.e2e.md", "specs/two.e2e.md"] });
    await deliverUi("scenarioStarted", { specPath: "specs/one.e2e.md", runId: "run-one" });
    await deliverUi("harness", {
      runId: "run-one",
      event: first("runStarted", {
        specPath: "specs/one.e2e.md",
        scenarioId: "one",
        harnessVersion: "0.1.0",
      }),
    });
    await deliverUi("harness", {
      runId: "run-one",
      event: first("runFinished", { status: "passed", criteriaCount: 0, failedCriteria: [] }),
    });
    await deliverUi("scenarioFinished", { specPath: "specs/one.e2e.md", status: "passed" });
    await deliverUi("scenarioStarted", { specPath: "specs/two.e2e.md", runId: "run-two" });
    await deliverUi("harness", {
      runId: "run-two",
      event: second("runStarted", {
        specPath: "specs/two.e2e.md",
        scenarioId: "two",
        harnessVersion: "0.1.0",
      }),
    });

    expect(screen.getByTestId("suite-counts")).toHaveTextContent("1/2 complete");
    expect(screen.getByTestId("suite-scenario-specs/one.e2e.md")).toHaveTextContent("passed");
    expect(screen.getByTestId("suite-scenario-specs/two.e2e.md")).toHaveTextContent("running");
    expect(screen.getByTestId("scenario-id")).toHaveTextContent("two");

    fireEvent.click(screen.getByTestId("suite-scenario-specs/one.e2e.md"));
    expect(screen.getByTestId("scenario-id")).toHaveTextContent("one");
    expect(screen.getByTestId("app")).toHaveAttribute("data-run-status", "passed");
    expect(screen.getByTestId("cancel-button")).toHaveTextContent("Cancel the suite");
    expect(screen.getByTestId("cancel-button")).not.toBeDisabled();

    await deliverUi("cliFinished", { completed: 2, total: 2 });
    expect(screen.getByTestId("connection-state")).toHaveTextContent("stream closed");
    expect(screen.getByTestId("suite-counts")).toHaveTextContent("2/2 complete");
    fireEvent.click(screen.getByTestId("close-dashboard-button"));
    expect(fetchMock).toHaveBeenCalledWith("/api/close", { method: "POST" });
  });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.EventSource = originalEventSource;
  globalThis.fetch = originalFetch;
  delete (globalThis as { __DIFMP_UI__?: unknown }).__DIFMP_UI__;
});

describe("App — connection lifecycle", () => {
  it("announces that it is connecting and opens exactly one stream", async () => {
    await renderApp();

    expect(screen.getByTestId("connection-state")).toHaveTextContent("connecting…");
    expect(sources).toHaveLength(1);
    expect(stats()).toHaveAttribute("data-connect-attempts", "1");
  });

  it("reports a live stream once the connection opens", async () => {
    await renderApp();
    await openStream();

    expect(screen.getByTestId("connection-state")).toHaveTextContent("live stream");
  });

  it("asks for the whole journal on the first connection", async () => {
    configure({ eventsUrl: "/api/events" });
    await renderApp();

    // No cursor yet: resuming from one would skip the head of the run.
    expect(latestSource().url).toBe("/api/events");
  });
});

describe("App — applying the journal", () => {
  it("identifies the run from runStarted", async () => {
    const emit = eventStream("run-42");
    await renderApp();
    await openStream();

    await deliver(
      emit("runStarted", {
        specPath: "specs/checkout.e2e.md",
        scenarioId: "checkout-flow",
        harnessVersion: "0.1.0",
      }),
    );

    expect(screen.getByTestId("scenario-id")).toHaveTextContent("checkout-flow");
    expect(screen.getByTestId("spec-path")).toHaveTextContent("specs/checkout.e2e.md");
    expect(screen.getByTestId("run-id")).toHaveTextContent("run-42");
    expect(timelineRows()).toHaveLength(1);
    expect(screen.getByTestId("timeline-list")).toHaveTextContent("Run started");
  });

  it("renders a whole passing run across every panel", async () => {
    configure({ artifactBaseUrl: "/runs/run-1/artifacts/" });
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(
      emit("runStarted", {
        specPath: "specs/checkout.e2e.md",
        scenarioId: "checkout-flow",
        harnessVersion: "0.1.0",
      }),
      emit("configResolved", { config: resolvedConfig(), configPath: "difmp.config.ts" }),
      emit("contractFrozen", {
        contractHash: "c".repeat(64),
        specHash: "s".repeat(64),
        criterionIds: ["c1"],
      }),
      emit("browserContextOpened", {
        baseUrl: "http://127.0.0.1:3000",
        usedStorageState: false,
        capture,
      }),
    );

    const action = emit("actionStarted", { actionId: "a1", tool: "screenshot", params: {} });
    await deliver(
      action,
      emit("actionFinished", { actionId: "a1", tool: "screenshot", outcome: "ok" }),
      emit("artifactAvailable", {
        artifactId: "shot-1",
        kind: "screenshot",
        state: "present",
        path: "screenshots/shot-1.png",
        sourceSeq: action.seq,
      }),
      emit("verificationFinished", {
        criterionId: "c1",
        result: criterionResult({ status: "passed", evidence: ["shot-1"], confidence: 0.83 }),
      }),
      emit("runFinished", { status: "passed", criteriaCount: 1, failedCriteria: [] }),
    );

    expect(screen.getByTestId("app")).toHaveAttribute("data-run-status", "passed");
    expect(screen.getByTestId("criterion-status-c1")).toHaveTextContent("passed");
    // Declared confidence is shown next to the verdict, and labelled as playing no part in it.
    expect(screen.getByTestId("criterion-confidence-c1")).toHaveTextContent(
      "83 % — self-reported, not used to decide",
    );
    expect(screen.getByTestId("screenshot-image")).toHaveAttribute("alt", "Screenshot shot-1");
    // The base the CLI injected is what the rendered src is actually built from.
    expect(screen.getByTestId("screenshot-image")).toHaveAttribute(
      "src",
      `${pageOrigin}/runs/run-1/artifacts/screenshots/shot-1.png`,
    );
    expect(screen.getByTestId("screenshot-action")).toHaveTextContent("a1 · screenshot");
    expect(screen.getByTestId("action-count")).toHaveTextContent("1 / 25 suggested");
    expect(stats()).toHaveAttribute("data-events-applied", "9");
    expect(stats()).toHaveAttribute("data-last-seq", "9");
  });

  it("names the criteria that failed when the run fails", async () => {
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(
      emit("contractFrozen", {
        contractHash: "c".repeat(64),
        specHash: "s".repeat(64),
        criterionIds: ["c1", "c2"],
      }),
      emit("verificationFinished", {
        criterionId: "c1",
        result: criterionResult({ status: "failed", observed: "No order number was rendered" }),
      }),
      emit("runFinished", { status: "failed", criteriaCount: 2, failedCriteria: ["c1"] }),
    );

    expect(screen.getByTestId("app")).toHaveAttribute("data-run-status", "failed");
    expect(screen.getByTestId("criterion-status-c1")).toHaveTextContent("failed");
    expect(screen.getByTestId("timeline-list")).toHaveTextContent("failures: c1");
    // A criterion never verified is unresolved when the run ends, never silently passed.
    expect(screen.getByTestId("criterion-status-c2")).toHaveTextContent("inconclusive");
  });

  it("applies a frame that arrives without an event name", async () => {
    const emit = eventStream();
    await renderApp();

    await deliverRaw(
      JSON.stringify(
        emit("runStarted", {
          specPath: "specs/checkout.e2e.md",
          scenarioId: "checkout-flow",
          harnessVersion: "0.1.0",
        }),
      ),
    );

    expect(screen.getByTestId("scenario-id")).toHaveTextContent("checkout-flow");
    expect(stats()).toHaveAttribute("data-events-applied", "1");
  });
});

describe("App — the dedupe contract", () => {
  it("counts a replayed frame as a duplicate and applies it zero times", async () => {
    const emit = eventStream();
    const started = emit("runStarted", {
      specPath: "specs/checkout.e2e.md",
      scenarioId: "checkout-flow",
      harnessVersion: "0.1.0",
    });
    const resolved = emit("configResolved", { config: resolvedConfig() });
    const opened = emit("browserContextOpened", {
      baseUrl: "http://127.0.0.1:3000",
      usedStorageState: false,
      capture,
    });

    await renderApp();
    await deliver(started, resolved, opened);
    expect(timelineRows()).toHaveLength(3);

    // Both sides of the `seq > lastSeq` guard: one frame strictly behind the cursor, one sitting
    // exactly on it.
    await deliver(resolved, opened);

    expect(stats()).toHaveAttribute("data-duplicates-dropped", "2");
    expect(stats()).toHaveAttribute("data-events-applied", "3");
    expect(stats()).toHaveAttribute("data-last-seq", "3");
    expect(timelineRows()).toHaveLength(3);
  });

  it("absorbs a resume that replays inclusively from the cursor", async () => {
    vi.useFakeTimers();
    const emit = eventStream();
    const started = emit("runStarted", {
      specPath: "specs/checkout.e2e.md",
      scenarioId: "checkout-flow",
      harnessVersion: "0.1.0",
    });
    const resolved = emit("configResolved", { config: resolvedConfig() });

    await renderApp();
    await openStream();
    await deliver(started, resolved);

    await failStream(FakeEventSource.CLOSED);
    await advance(500);
    expect(sources).toHaveLength(2);

    // The server resends the cursor frame itself before the new ones.
    await deliver(
      resolved,
      emit("browserContextOpened", {
        baseUrl: "http://127.0.0.1:3000",
        usedStorageState: false,
        capture,
      }),
    );

    expect(stats()).toHaveAttribute("data-duplicates-dropped", "1");
    expect(stats()).toHaveAttribute("data-events-applied", "3");
    expect(timelineRows()).toHaveLength(3);
  });
});

describe("App — malformed frames", () => {
  it("counts a frame that is not JSON and renders nothing from it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await renderApp();

    await deliverRaw("<html>a proxy error page</html>", "runStarted");

    expect(stats()).toHaveAttribute("data-malformed-dropped", "1");
    expect(stats()).toHaveAttribute("data-events-applied", "0");
    expect(timelineRows()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("counts well-formed JSON that is not a harness envelope", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await renderApp();

    await deliverRaw(
      JSON.stringify({
        schemaVersion: 2,
        seq: 1,
        runId: "run-1",
        ts: "2026-09-12T10:00:01.000Z",
        type: "runStarted",
      }),
    );
    await deliverRaw(
      JSON.stringify({
        schemaVersion: 1,
        seq: 2,
        runId: "run-1",
        ts: "2026-09-12T10:00:02.000Z",
        type: "somethingElse",
      }),
    );

    expect(stats()).toHaveAttribute("data-malformed-dropped", "2");
    expect(timelineRows()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("never counts the connection's own failure as a malformed frame", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await renderApp();
    await openStream();

    // `error` is BOTH a harness event type and EventSource's own failure event, so the listener
    // registered for the journal type also receives the DOM one. Counting it would inflate the
    // malformed counter on every reconnect; this is the regression this file exists for.
    await failStream(FakeEventSource.CONNECTING);

    expect(stats()).toHaveAttribute("data-malformed-dropped", "0");
    expect(warn).not.toHaveBeenCalled();
    expect(screen.getByTestId("connection-state")).toHaveTextContent("reconnecting…");
  });
});

describe("App — reconnection", () => {
  it("leaves the browser to retry while the connection is still CONNECTING", async () => {
    vi.useFakeTimers();
    await renderApp();
    await openStream();

    await failStream(FakeEventSource.CONNECTING);
    await advance(30_000);

    expect(screen.getByTestId("connection-state")).toHaveTextContent("reconnecting…");
    // The browser reconnects by itself and sends Last-Event-ID; a second stream would duplicate it.
    expect(sources).toHaveLength(1);
  });

  it("takes over with an explicit resume cursor once the browser has given up", async () => {
    vi.useFakeTimers();
    const emit = eventStream();
    await renderApp();
    await openStream();
    await deliver(
      emit("runStarted", {
        specPath: "specs/checkout.e2e.md",
        scenarioId: "checkout-flow",
        harnessVersion: "0.1.0",
      }),
      emit("configResolved", { config: resolvedConfig() }),
      emit("contractFrozen", {
        contractHash: "c".repeat(64),
        specHash: "s".repeat(64),
        criterionIds: ["c1"],
      }),
    );

    await failStream(FakeEventSource.CLOSED);
    expect(screen.getByTestId("connection-state")).toHaveTextContent("reconnecting…");
    expect(sources).toHaveLength(1);

    await advance(500);

    expect(sources).toHaveLength(2);
    expect(latestSource().url).toBe("events?lastEventId=3");
  });

  it("offers a manual resume once the takeover attempts are exhausted", async () => {
    vi.useFakeTimers();
    await renderApp();
    await openStream();

    // Eight takeovers, each failing before it can open, then one failure too many.
    for (let attempt = 0; attempt < 8; attempt++) {
      await failStream(FakeEventSource.CLOSED);
      await advance(10_000);
    }
    expect(sources).toHaveLength(9);

    await failStream(FakeEventSource.CLOSED);
    await advance(10_000);

    expect(screen.getByTestId("connection-state")).toHaveTextContent("server unreachable");
    expect(sources).toHaveLength(9);

    fireEvent.click(screen.getByTestId("reconnect-button"));
    expect(sources).toHaveLength(10);

    await openStream();
    expect(screen.getByTestId("connection-state")).toHaveTextContent("live stream");
  });

  it("closes the stream for good when the run finishes", async () => {
    vi.useFakeTimers();
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(emit("runFinished", { status: "passed", criteriaCount: 0, failedCriteria: [] }));

    expect(screen.getByTestId("connection-state")).toHaveTextContent(
      "stream closed (run finished)",
    );
    expect(latestSource().closed).toBe(true);

    await failStream(FakeEventSource.CLOSED);
    await advance(30_000);

    expect(screen.getByTestId("connection-state")).toHaveTextContent(
      "stream closed (run finished)",
    );
    expect(sources).toHaveLength(1);
  });
});

describe("App — cancellation", () => {
  it("posts to the cancel endpoint and reports the request", async () => {
    configure({ cancelUrl: "/api/cancel" });
    const fetchMock = stubFetch({ cancel: () => Promise.resolve(jsonResponse({ ok: true })) });
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByTestId("cancel-button"));

    await waitFor(() => {
      expect(screen.getByTestId("cancel-button")).toHaveTextContent("Cancellation requested");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.getByTestId("cancel-button")).toBeDisabled();
  });

  it("surfaces a rejected cancellation and leaves the button usable", async () => {
    stubFetch({ cancel: () => Promise.resolve(jsonResponse({}, { ok: false, status: 503 })) });
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByTestId("cancel-button"));

    expect(await screen.findByTestId("cancel-error")).toHaveTextContent("HTTP 503");
    expect(screen.getByTestId("cancel-button")).toHaveTextContent("Cancel the run");
    expect(screen.getByTestId("cancel-button")).toBeEnabled();
  });

  it("shows the request when the cancellation came from outside the dashboard", async () => {
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(emit("cancellationRequested", { reason: "SIGINT received", source: "signal" }));

    expect(screen.getByTestId("cancel-button")).toHaveTextContent("Cancellation requested");
    expect(screen.getByTestId("cancel-button")).toBeDisabled();
  });
});

describe("App — the frozen contract", () => {
  const contractBody = {
    id: "checkout-flow",
    specPath: "specs/checkout.e2e.md",
    criteria: [
      { id: "c1", text: "The order confirmation is displayed", method: "model" },
      { id: "c2", text: "The cart is empty", method: "code", checkName: "cartIsEmpty" },
    ],
  };

  it("enriches the criteria with the text and method from the contract", async () => {
    configure({ contractUrl: "/api/contract" });
    const fetchMock = stubFetch({ contract: () => Promise.resolve(jsonResponse(contractBody)) });
    await renderApp();

    expect(fetchMock).toHaveBeenCalledWith("/api/contract", expect.anything());
    expect(screen.getByTestId("criterion-c1")).toHaveTextContent(
      "The order confirmation is displayed",
    );
    expect(screen.getByTestId("criterion-method-c1")).toHaveTextContent("model");
    expect(screen.getByTestId("criterion-method-c2")).toHaveTextContent("code · cartIsEmpty");
  });

  const brokenContracts: ReadonlyArray<{
    readonly name: string;
    readonly route: () => Promise<Response>;
  }> = [
    {
      name: "answers 404",
      route: () => Promise.resolve(jsonResponse({}, { ok: false, status: 404 })),
    },
    { name: "never answers", route: () => Promise.reject(new Error("network down")) },
    { name: "answers with junk", route: () => Promise.resolve(jsonResponse("not a contract")) },
  ];

  for (const broken of brokenContracts) {
    it(`falls back to criterion ids when the contract ${broken.name}`, async () => {
      const emit = eventStream();
      stubFetch({ contract: broken.route });
      await renderApp();
      await openStream();

      await deliver(
        emit("contractFrozen", {
          contractHash: "c".repeat(64),
          specHash: "s".repeat(64),
          criterionIds: ["c1"],
        }),
      );

      expect(screen.getByTestId("criterion-c1")).toHaveTextContent("(criterion text unavailable)");
      expect(screen.getByTestId("criterion-method-c1")).toHaveTextContent("unknown method");
      // The contract is an enrichment: the rest of the dashboard keeps working without it.
      expect(screen.getByTestId("connection-state")).toHaveTextContent("live stream");
      expect(stats()).toHaveAttribute("data-events-applied", "1");
    });
  }
});

describe("App — elapsed time", () => {
  it("shows no duration at all before the run has started", async () => {
    await renderApp();

    expect(elapsed()).toHaveTextContent(/^0 ms$/);
  });

  it("reads 0 rather than NaN when the start timestamp cannot be parsed", async () => {
    const emit = eventStream();
    await renderApp();
    await openStream();

    // `startedAt` is `runStarted.ts` verbatim, and the envelope gate only checks that `ts` is a
    // string — so an unparseable one reaches the duration arithmetic.
    await deliver(emit("runStarted", runStartedPayload, { ts: "not-a-date" }));

    expect(elapsed()).toHaveTextContent(/^0 ms$/);
  });

  it("measures the run from runStarted to runFinished", async () => {
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(emit("runStarted", runStartedPayload, { ts: "2026-09-12T10:00:00.000Z" }));
    await deliver(
      emit(
        "runFinished",
        { status: "passed", criteriaCount: 0, failedCriteria: [] },
        { ts: "2026-09-12T10:00:04.200Z" },
      ),
    );

    expect(elapsed()).toHaveTextContent(/^4\.20 s$/);
  });

  it("falls back to the live clock when the finish timestamp cannot be parsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-12T10:00:03.000Z"));
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(emit("runStarted", runStartedPayload, { ts: "2026-09-12T10:00:00.000Z" }));
    await deliver(
      emit(
        "runFinished",
        { status: "passed", criteriaCount: 0, failedCriteria: [] },
        { ts: "not-a-date" },
      ),
    );

    expect(elapsed()).toHaveTextContent(/^3\.00 s$/);
  });

  it("clamps a finish timestamp that precedes the start to zero", async () => {
    const emit = eventStream();
    await renderApp();
    await openStream();

    // Clock skew, or a journal replayed out of order: a negative duration would also drive the
    // attempt-timeout gauge negative.
    await deliver(emit("runStarted", runStartedPayload, { ts: "2026-09-12T10:00:05.000Z" }));
    await deliver(
      emit(
        "runFinished",
        { status: "passed", criteriaCount: 0, failedCriteria: [] },
        { ts: "2026-09-12T10:00:01.000Z" },
      ),
    );

    expect(elapsed()).toHaveTextContent(/^0 ms$/);
  });

  it("keeps the duration moving while the run is live and stops ticking once it ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-12T10:00:00.000Z"));
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(emit("runStarted", runStartedPayload, { ts: "2026-09-12T10:00:00.000Z" }));
    expect(elapsed()).toHaveTextContent(/^0 ms$/);

    await advance(2000);
    expect(elapsed()).toHaveTextContent(/^2\.00 s$/);

    await deliver(
      emit(
        "runFinished",
        { status: "passed", criteriaCount: 0, failedCriteria: [] },
        { ts: "2026-09-12T10:00:02.000Z" },
      ),
    );

    // The tick belongs to the live run: left armed it would re-render the dashboard once a
    // second forever, on a run that is over.
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(elapsed()).toHaveTextContent(/^2\.00 s$/);
  });
});

describe("App — blocking budgets versus indicative guidance", () => {
  it("separates an indicative crossing from an exhausted blocking budget", async () => {
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(
      emit("runStarted", runStartedPayload),
      emit("configResolved", { config: resolvedConfig() }),
      emit("contractFrozen", {
        contractHash: "c".repeat(64),
        specHash: "s".repeat(64),
        criterionIds: ["c1"],
      }),
      emit("actionGuidanceExceeded", {
        used: 26,
        guidance: 25,
        rendering: "26 actions / 25 suggested",
      }),
      emit("budgetExhausted", { budget: "maxTokens", limit: 200_000, used: 200_412 }),
      emit("verificationFinished", {
        criterionId: "c1",
        result: criterionResult({ status: "passed" }),
      }),
      emit("runFinished", { status: "passed", criteriaCount: 1, failedCriteria: [] }),
    );

    // Two events of opposite natures, delivered in one run: what the dashboard must prove is
    // that it puts them in different places, not merely that it can render each.
    const note = screen.getByTestId("guidance-exceeded");
    expect(note).toHaveTextContent("26 actions / 25 suggested");
    expect(note).toHaveTextContent("No action refused, no status degraded");

    const breaches = screen.getByTestId("budget-breaches");
    expect(within(breaches).getAllByRole("listitem")).toHaveLength(1);
    expect(breaches).toHaveTextContent(/^tokens exhausted — 200,412 \/ 200,000$/);

    expect(screen.getByTestId("budget-maxTokens").querySelector(".gauge-track")).toHaveClass(
      "is-exhausted",
    );
    expect(screen.getByTestId("guidance-gauge").querySelector(".gauge-track")).not.toHaveClass(
      "is-exhausted",
    );

    expect(timelineRowOf("guidance")).toHaveTextContent("Indicative action threshold crossed");
    expect(timelineRowOf("budget")).toHaveTextContent("Blocking budget exhausted: maxTokens");

    // Crossing the indicative threshold degrades no status: the run is still passed.
    expect(screen.getByTestId("app")).toHaveAttribute("data-run-status", "passed");
    expect(screen.getByTestId("criterion-status-c1")).toHaveTextContent("passed");
  });

  it("adds up the tokens the model spent and footnotes the verifier's share", async () => {
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(
      emit("configResolved", { config: resolvedConfig() }),
      emit("modelCallFinished", {
        role: "browser",
        callId: "m1",
        inputTokens: 30_000,
        outputTokens: 6_000,
        toolCalls: 2,
      }),
      emit("modelCallFinished", {
        role: "verifier",
        callId: "m2",
        inputTokens: 12_000,
        outputTokens: 2_000,
        toolCalls: 0,
      }),
    );

    const gauge = screen.getByTestId("budget-maxTokens");
    expect(within(gauge).getByText("50,000 / 200,000")).toBeInTheDocument();
    expect(
      within(gauge).getByText("of which 14,000 verifier · reserve 20,000"),
    ).toBeInTheDocument();
  });
});

describe("App — cost", () => {
  it("says the cost is unavailable when the CLI declared no prices", async () => {
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(...spend(emit));

    // Nothing is injected, so `config.pricing` is absent all the way to the panel: a default
    // price table anywhere on that wire would print a fabricated figure instead.
    expect(screen.getByTestId("cost-value")).toHaveTextContent("unavailable");
  });

  it("computes the cost from the price table the CLI injected", async () => {
    configure({
      pricing: { currency: "USD", inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
    });
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(...spend(emit));

    // 1M input at 3 + 0.2M output at 15 = 6.
    expect(screen.getByTestId("cost-value")).toHaveTextContent("6.0000 USD");
  });
});

describe("App — artifacts and observations", () => {
  it("keeps an artifact that never materialised, with the reason the harness gave", async () => {
    const emit = eventStream();
    await renderApp();
    await openStream();

    await deliver(
      emit("artifactAvailable", {
        artifactId: "trace-1",
        kind: "trace",
        state: "missing",
        reason: "capture disabled",
      }),
    );

    const row = screen.getByTestId("artifact-trace-1");
    expect(row).toHaveTextContent("missing");
    expect(row).toHaveTextContent("capture disabled");

    // The timeline carries the reason as the row's detail — the artifact has no path to show,
    // so dropping it would leave the absence unexplained there too.
    const entry = timelineRowOf("artifact");
    expect(entry).toHaveTextContent("Artifact trace-1 (trace) — missing");
    expect(entry).toHaveTextContent("capture disabled");
    expect(entry).toHaveClass("tone-warn");
  });

  it("renders an observation's URL as text and never as a link", async () => {
    const emit = eventStream();
    await renderApp();
    await openStream();

    // The URL comes from the page under test. It is displayed, so it must stay inert: an anchor
    // built from it would be an injection site.
    await deliver(
      emit("observationTaken", {
        observationId: "o1",
        url: "javascript:alert(1)",
        title: "Checkout",
        elementCount: 3,
      }),
    );

    const entry = timelineRowOf("observation");
    expect(entry).toHaveTextContent("javascript:alert(1)");
    expect(within(entry).queryByRole("link")).toBeNull();
  });
});

describe("App — teardown", () => {
  it("closes the stream when the dashboard unmounts", async () => {
    const view = await renderApp();
    await openStream();
    const source = latestSource();

    view.unmount();

    expect(source.closed).toBe(true);
    expect(sources).toHaveLength(1);
  });
});
