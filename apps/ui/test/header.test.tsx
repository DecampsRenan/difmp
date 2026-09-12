import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Header } from "../src/components/Header.js";
import type { CancelState, ConnectionState } from "../src/state/useRunStream.js";
import type { RunModel } from "../src/state/model.js";
import { emptyRunModel } from "../src/state/model.js";
import { runModel } from "./factories.js";

const idle: CancelState = { pending: false, requested: false };

const valueOf = (label: string): HTMLElement => {
  const dt = screen.getByText(label);
  const dd = dt.parentElement?.querySelector("dd");
  if (dd === null || dd === undefined) throw new Error(`no value for ${label}`);
  return dd as HTMLElement;
};

const renderHeader = (
  over: {
    model?: RunModel;
    connection?: ConnectionState;
    attempts?: number;
    cancel?: CancelState;
    elapsedMs?: number;
  } = {},
) => {
  const onCancel = vi.fn<() => void>();
  const onReconnect = vi.fn<() => void>();
  const result = render(
    <Header
      model={over.model ?? runModel()}
      connection={over.connection ?? "live"}
      attempts={over.attempts ?? 1}
      cancel={over.cancel ?? idle}
      onCancel={onCancel}
      onReconnect={onReconnect}
      elapsedMs={over.elapsedMs ?? 4200}
    />,
  );
  return { ...result, onCancel, onReconnect };
};

describe("Header — identity", () => {
  it("shows the scenario, spec path, run and attempt once they are known", () => {
    renderHeader();
    expect(screen.getByTestId("scenario-id")).toHaveTextContent("checkout-flow");
    expect(screen.getByTestId("spec-path")).toHaveTextContent("specs/checkout.e2e.md");
    expect(screen.getByTestId("run-id")).toHaveTextContent("run-1");
    expect(screen.getByTestId("attempt-id")).toHaveTextContent("attempt-1");
    expect(screen.getByTestId("elapsed")).toHaveTextContent("4.20 s");
  });

  it("shows the wall-clock time the run started at", () => {
    // The instant is built from LOCAL components so the expected reading holds in every timezone.
    renderHeader({
      model: runModel({ startedAt: new Date(2026, 8, 12, 10, 0, 0, 0).toISOString() }),
    });
    expect(valueOf("Started")).toHaveTextContent(/^10:00:00\.000$/);
  });

  it("shows an unparseable start timestamp verbatim rather than as 'Invalid Date'", () => {
    // `startedAt` is `runStarted.ts` as it came off the wire, and only its type is validated.
    renderHeader({ model: runModel({ startedAt: "not-a-date" }) });
    expect(valueOf("Started")).toHaveTextContent(/^not-a-date$/);
  });

  it("degrades to placeholders before the first event, never to 'undefined'", () => {
    renderHeader({ model: emptyRunModel, elapsedMs: 0 });
    expect(screen.getByTestId("scenario-id")).toHaveTextContent("unknown scenario");
    expect(screen.getByTestId("spec-path")).toHaveTextContent("—");
    expect(screen.getByTestId("run-id")).toHaveTextContent("—");
    expect(screen.getByTestId("attempt-id")).toHaveTextContent("—");
    expect(valueOf("Started")).toHaveTextContent("—");
    expect(screen.getByTestId("elapsed")).toHaveTextContent("0 ms");
  });
});

describe("Header — run status", () => {
  it.each([
    ["running", "badge-info"],
    ["passed", "badge-ok"],
    ["failed", "badge-bad"],
    ["inconclusive", "badge-warn"],
    ["error", "badge-bad"],
    ["cancelled", "badge-warn"],
  ] as const)("renders %s with the %s tone", (status, tone) => {
    renderHeader({ model: runModel({ status }) });
    const badge = screen.getByTestId("run-status");
    expect(badge).toHaveTextContent(status);
    expect(badge.parentElement).toHaveClass(tone);
  });

  it("falls back to a neutral tone for a status the harness may add later", () => {
    // `runFinished.status` is stored verbatim and never validated against the union.
    renderHeader({ model: runModel({ status: "aborted" as never }) });
    const badge = screen.getByTestId("run-status");
    expect(badge).toHaveTextContent("aborted");
    expect(badge.parentElement).toHaveClass("badge-neutral");
  });
});

describe("Header — connection state", () => {
  it.each([
    ["connecting", "connecting…", "conn-info"],
    ["live", "live stream", "conn-ok"],
    ["reconnecting", "reconnecting…", "conn-warn"],
    ["closed", "stream closed (run finished)", "conn-neutral"],
    ["unavailable", "server unreachable", "conn-bad"],
  ] as const)("labels %s", (connection, label, tone) => {
    renderHeader({ connection });
    const el = screen.getByTestId("connection-state");
    expect(el).toHaveTextContent(label);
    expect(el).toHaveClass(tone);
  });

  it("offers a manual resume only once retrying has been given up on", async () => {
    const user = userEvent.setup();
    const { onReconnect, rerender } = renderHeader({ connection: "reconnecting" });
    expect(screen.queryByTestId("reconnect-button")).toBeNull();

    rerender(
      <Header
        model={runModel()}
        connection="unavailable"
        attempts={9}
        cancel={idle}
        onCancel={vi.fn<() => void>()}
        onReconnect={onReconnect}
        elapsedMs={0}
      />,
    );
    await user.click(screen.getByTestId("reconnect-button"));
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("publishes the stream counters as data attributes, not only as prose", () => {
    renderHeader({
      model: runModel({ applied: 12, duplicates: 3, malformed: 1, lastSeq: 12 }),
      attempts: 2,
    });
    const stats = screen.getByTestId("stream-stats");
    expect(stats).toHaveAttribute("data-events-applied", "12");
    expect(stats).toHaveAttribute("data-duplicates-dropped", "3");
    expect(stats).toHaveAttribute("data-malformed-dropped", "1");
    expect(stats).toHaveAttribute("data-last-seq", "12");
    expect(stats).toHaveAttribute("data-connect-attempts", "2");
    expect(stats).toHaveTextContent("12 event(s) · 3 duplicate(s) dropped · seq 12");
  });
});

describe("Header — cancellation", () => {
  it("invites a cancellation while the run is live and forwards the click", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderHeader();
    const button = screen.getByTestId("cancel-button");
    expect(button).toHaveTextContent("Cancel the run");
    expect(button).toBeEnabled();
    await user.click(button);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([
    [{ pending: true, requested: false }, "Cancelling…"],
    [{ pending: false, requested: true }, "Cancellation requested"],
  ] as const)("locks the button while %o", (cancel, label) => {
    renderHeader({ cancel });
    const button = screen.getByTestId("cancel-button");
    expect(button).toHaveTextContent(label);
    expect(button).toBeDisabled();
  });

  it("turns into a finished marker once the run is over", () => {
    renderHeader({ model: runModel({ status: "passed" }) });
    const button = screen.getByTestId("cancel-button");
    expect(button).toHaveTextContent("Run finished");
    expect(button).toBeDisabled();
  });

  it("surfaces a failed cancellation instead of swallowing it", () => {
    const { rerender, onCancel, onReconnect } = renderHeader();
    expect(screen.queryByTestId("cancel-error")).toBeNull();

    rerender(
      <Header
        model={runModel()}
        connection="live"
        attempts={1}
        cancel={{ pending: false, requested: false, error: "HTTP 503" }}
        onCancel={onCancel}
        onReconnect={onReconnect}
        elapsedMs={0}
      />,
    );
    expect(screen.getByTestId("cancel-error")).toHaveTextContent("Cancellation failed: HTTP 503");
    // A failed request leaves the button usable so the user can retry.
    expect(screen.getByTestId("cancel-button")).toBeEnabled();
  });
});
