import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { HarnessEvent } from "../src/types/events.js";
import { eventStream, criterionResult, resolvedConfig } from "./factories.js";

/**
 * End-to-end wiring of the simplified live view: suite tree + live browser preview.
 * SSE transport and `fetch` are faked; everything between is production code.
 */

const sources: Array<FakeEventSource> = [];

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

const pageOrigin = new URL(globalThis.location.href).origin;

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

afterEach(() => {
  vi.useRealTimers();
  globalThis.EventSource = originalEventSource;
  globalThis.fetch = originalFetch;
  delete (globalThis as { __DIFMP_UI__?: unknown }).__DIFMP_UI__;
});

describe("App — layout", () => {
  it("renders the suite tree and live preview panes", async () => {
    await renderApp();
    expect(screen.getByTestId("suite-tree")).toBeInTheDocument();
    expect(screen.getByTestId("live-preview")).toBeInTheDocument();
    expect(screen.getByTestId("live-preview-empty")).toHaveTextContent(
      "Waiting for the first screenshot…",
    );
  });
});

describe("App — multi-scenario suite", () => {
  it("lists files with live statuses and keeps histories selectable", async () => {
    configure({ eventsUrl: "/api/events", closeUrl: "/api/close" });
    const fetchMock = stubFetch({ close: () => Promise.resolve(jsonResponse({ accepted: true })) });
    const first = eventStream("run-one");
    const second = eventStream("run-two");
    await renderApp();
    await openStream();

    await deliverUi("cliStarted", { scenarios: ["specs/one.e2e.md", "specs/two.e2e.md"] });
    expect(screen.getByTestId("suite-file-status-specs/one.e2e.md")).toHaveTextContent(
      "not tested",
    );

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

    expect(screen.getByTestId("suite-file-status-specs/one.e2e.md")).toHaveTextContent("passed");
    expect(screen.getByTestId("suite-file-status-specs/two.e2e.md")).toHaveTextContent(
      "in progress",
    );
    expect(screen.getByTestId("scenario-id")).toHaveTextContent("two");
    expect(screen.getByTestId("run-status")).toHaveTextContent("in progress");

    fireEvent.click(screen.getByTestId("suite-scenario-specs/one.e2e.md"));
    expect(screen.getByTestId("scenario-id")).toHaveTextContent("one");
    expect(screen.getByTestId("app")).toHaveAttribute("data-run-status", "passed");
    expect(screen.getByTestId("run-status")).toHaveTextContent("passed");
    expect(screen.getByTestId("cancel-button")).toHaveTextContent("Cancel suite");
    expect(screen.getByTestId("cancel-button")).not.toBeDisabled();

    await deliverUi("cliFinished", { completed: 2, total: 2 });
    expect(screen.getByTestId("connection-state")).toHaveTextContent("finished");
    fireEvent.click(screen.getByTestId("close-dashboard-button"));
    expect(fetchMock).toHaveBeenCalledWith("/api/close", { method: "POST" });
  });
});

describe("App — connection lifecycle", () => {
  it("announces that it is connecting and opens exactly one stream", async () => {
    await renderApp();
    expect(screen.getByTestId("connection-state")).toHaveTextContent("connecting…");
    expect(sources).toHaveLength(1);
    expect(screen.getByTestId("stream-stats")).toHaveAttribute("data-connect-attempts", "1");
  });

  it("reports a live stream once the connection opens", async () => {
    await renderApp();
    await openStream();
    expect(screen.getByTestId("connection-state")).toHaveTextContent("live");
  });
});

describe("App — journal → tree + preview", () => {
  it("identifies the run from runStarted", async () => {
    const emit = eventStream("run-1");
    await renderApp();
    await openStream();
    await deliver(emit("runStarted", runStartedPayload));
    expect(screen.getByTestId("scenario-id")).toHaveTextContent("checkout-flow");
    expect(screen.getByTestId("spec-path")).toHaveTextContent("specs/checkout.e2e.md");
    expect(screen.getByTestId("run-id")).toHaveTextContent("run-1");
  });

  it("shows assertions and the latest screenshot in the live preview", async () => {
    const emit = eventStream("run-1");
    await renderApp();
    await openStream();

    const action = emit("actionStarted", { actionId: "a1", tool: "screenshot", params: {} });
    await deliver(
      emit("runStarted", runStartedPayload),
      emit("contractFrozen", {
        contractHash: "c".repeat(64),
        specHash: "s".repeat(64),
        criterionIds: ["c1", "c2"],
      }),
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
        result: criterionResult({ status: "passed", evidence: ["shot-1"] }),
      }),
      emit("runFinished", { status: "passed", criteriaCount: 1, failedCriteria: [] }),
    );

    expect(screen.getByTestId("app")).toHaveAttribute("data-run-status", "passed");
    expect(screen.getByTestId("run-status")).toHaveTextContent("passed");
    expect(screen.getByTestId("criterion-status-c1")).toHaveTextContent("passed");
    expect(screen.getByTestId("criterion-status-c2")).toHaveTextContent("need details");
    expect(screen.getByTestId("screenshot-image")).toHaveAttribute(
      "src",
      `${pageOrigin}/artifacts/screenshots/shot-1.png?runId=run-1`,
    );
  });

  it("maps a failed criterion and leaves unfinished ones as need details", async () => {
    const emit = eventStream("run-1");
    await renderApp();
    await openStream();
    await deliver(
      emit("runStarted", runStartedPayload),
      emit("contractFrozen", {
        contractHash: "c".repeat(64),
        specHash: "s".repeat(64),
        criterionIds: ["c1", "c2"],
      }),
      emit("verificationFinished", {
        criterionId: "c1",
        result: criterionResult({
          status: "failed",
          observed: "No order number was rendered",
        }),
      }),
      emit("runFinished", { status: "failed", criteriaCount: 2, failedCriteria: ["c1"] }),
    );

    expect(screen.getByTestId("app")).toHaveAttribute("data-run-status", "failed");
    expect(screen.getByTestId("criterion-status-c1")).toHaveTextContent("failed");
    expect(screen.getByTestId("criterion-status-c2")).toHaveTextContent("need details");
  });
});

describe("App — dedupe", () => {
  it("counts a replayed frame as a duplicate and applies it zero times", async () => {
    const emit = eventStream("run-1");
    await renderApp();
    await openStream();
    const started = emit("runStarted", runStartedPayload);
    await deliver(started, started);
    expect(screen.getByTestId("stream-stats")).toHaveAttribute("data-events-applied", "1");
    expect(screen.getByTestId("stream-stats")).toHaveAttribute("data-duplicates-dropped", "1");
  });

  it("absorbs a resume that replays inclusively from the cursor", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const emit = eventStream("run-1");
    await renderApp();
    await openStream();
    const started = emit("runStarted", runStartedPayload);
    const resolved = emit("configResolved", { config: resolvedConfig() });
    await deliver(started, resolved);
    expect(screen.getByTestId("stream-stats")).toHaveAttribute("data-last-seq", "2");

    await failStream(FakeEventSource.CLOSED);
    await advance(600);
    expect(sources).toHaveLength(2);
    await openStream();
    await deliver(started, resolved);
    expect(screen.getByTestId("stream-stats")).toHaveAttribute("data-events-applied", "2");
    expect(screen.getByTestId("stream-stats")).toHaveAttribute("data-duplicates-dropped", "2");
  });
});

describe("App — reconnection", () => {
  it("offers a manual resume once the takeover attempts are exhausted", async () => {
    vi.useFakeTimers();
    await renderApp();
    await openStream();

    for (let attempt = 0; attempt < 8; attempt++) {
      await failStream(FakeEventSource.CLOSED);
      await advance(10_000);
    }
    expect(sources).toHaveLength(9);

    await failStream(FakeEventSource.CLOSED);
    await advance(10_000);

    expect(screen.getByTestId("connection-state")).toHaveTextContent("unreachable");
    expect(sources).toHaveLength(9);

    fireEvent.click(screen.getByTestId("reconnect-button"));
    expect(sources).toHaveLength(10);

    await openStream();
    expect(screen.getByTestId("connection-state")).toHaveTextContent("live");
  });

  it("closes the stream for good when the run finishes", async () => {
    const emit = eventStream("run-1");
    await renderApp();
    await openStream();
    await deliver(emit("runStarted", runStartedPayload));
    await deliver(emit("runFinished", { status: "passed", criteriaCount: 0, failedCriteria: [] }));
    expect(screen.getByTestId("connection-state")).toHaveTextContent("finished");
    expect(latestSource().closed).toBe(true);
  });
});

describe("App — cancellation", () => {
  it("surfaces a rejected cancellation and leaves the button usable", async () => {
    stubFetch({ cancel: () => Promise.resolve(jsonResponse({}, { ok: false, status: 503 })) });
    await renderApp();
    await openStream();
    fireEvent.click(screen.getByTestId("cancel-button"));
    await waitFor(() => {
      expect(screen.getByTestId("cancel-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("cancel-button")).not.toBeDisabled();
  });
});

describe("App — frozen contract", () => {
  it("enriches the tree with criterion text from the contract", async () => {
    stubFetch({
      contract: () =>
        Promise.resolve(
          jsonResponse({
            criteria: [
              { id: "c1", text: "The cart shows one item", method: "model" },
              { id: "c2", text: "Checkout succeeds", method: "model" },
            ],
          }),
        ),
    });
    const emit = eventStream("run-1");
    await renderApp();
    await openStream();
    await deliver(
      emit("runStarted", runStartedPayload),
      emit("contractFrozen", {
        contractHash: "hash-1",
        specHash: "s".repeat(64),
        criterionIds: ["c1", "c2"],
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("suite-assertion-specs/checkout.e2e.md-c1")).toHaveTextContent(
        "The cart shows one item",
      );
    });
  });

  it("falls back to criterion ids when the contract answers 404", async () => {
    stubFetch({
      contract: () => Promise.resolve(jsonResponse({}, { ok: false, status: 404 })),
    });
    const emit = eventStream("run-1");
    await renderApp();
    await openStream();
    await deliver(
      emit("runStarted", runStartedPayload),
      emit("contractFrozen", {
        contractHash: "hash-1",
        specHash: "s".repeat(64),
        criterionIds: ["c1"],
      }),
    );
    expect(screen.getByTestId("suite-assertion-specs/checkout.e2e.md-c1")).toHaveTextContent("c1");
  });

  it("enriches every scenario after a suite journal replay (page refresh)", async () => {
    configure({ eventsUrl: "/api/events", contractUrl: "/api/contract" });
    const contracts: Record<string, unknown> = {
      "run-one": {
        criteria: [{ id: "c1", text: "Home shows the Start UI mark", method: "code" }],
      },
      "run-two": {
        criteria: [{ id: "c1", text: "Sign-in form accepts the demo user", method: "code" }],
      },
    };
    const fetchMock = vi.fn<(input: unknown) => Promise<Response>>((input) => {
      const url = String(input);
      if (url.includes("cancel") || url.includes("close")) {
        return Promise.resolve(jsonResponse({}, { ok: false, status: 404 }));
      }
      const runId = new URL(url, pageOrigin).searchParams.get("runId") ?? "";
      const body = contracts[runId];
      if (body === undefined) return Promise.resolve(jsonResponse({}, { ok: false, status: 404 }));
      return Promise.resolve(jsonResponse(body));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = eventStream("run-one");
    const second = eventStream("run-two");
    await renderApp();
    await openStream();

    // Mimic EventSource replaying the full suite journal after a browser refresh.
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
      event: first("contractFrozen", {
        contractHash: "hash-one",
        specHash: "s".repeat(64),
        criterionIds: ["c1"],
      }),
    });
    await deliverUi("harness", {
      runId: "run-one",
      event: first("runFinished", { status: "passed", criteriaCount: 1, failedCriteria: [] }),
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
    await deliverUi("harness", {
      runId: "run-two",
      event: second("contractFrozen", {
        contractHash: "hash-two",
        specHash: "s".repeat(64),
        criterionIds: ["c1"],
      }),
    });
    await deliverUi("cliFinished", { completed: 2, total: 2 });

    await waitFor(() => {
      expect(screen.getByTestId("suite-assertion-specs/one.e2e.md-c1")).toHaveTextContent(
        "Home shows the Start UI mark",
      );
      expect(screen.getByTestId("suite-assertion-specs/two.e2e.md-c1")).toHaveTextContent(
        "Sign-in form accepts the demo user",
      );
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("runId=run-one"))).toBe(
      true,
    );
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("runId=run-two"))).toBe(
      true,
    );
  });
});

describe("App — collapsible tree", () => {
  it("collapses and expands a file's assertions", async () => {
    const emit = eventStream("run-1");
    await renderApp();
    await openStream();
    await deliver(
      emit("runStarted", runStartedPayload),
      emit("contractFrozen", {
        contractHash: "h",
        specHash: "s".repeat(64),
        criterionIds: ["c1"],
      }),
    );
    expect(screen.getByTestId("suite-assertion-specs/checkout.e2e.md-c1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("suite-file-toggle-specs/checkout.e2e.md"));
    expect(screen.queryByTestId("suite-assertion-specs/checkout.e2e.md-c1")).toBeNull();
    fireEvent.click(screen.getByTestId("suite-file-toggle-specs/checkout.e2e.md"));
    expect(screen.getByTestId("suite-assertion-specs/checkout.e2e.md-c1")).toBeInTheDocument();
  });
});
