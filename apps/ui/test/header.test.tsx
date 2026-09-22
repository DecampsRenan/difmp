import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Header } from "../src/components/Header.js";
import type { CancelState, ConnectionState } from "../src/state/useRunStream.js";
import type { RunModel } from "../src/state/model.js";
import { emptyRunModel } from "../src/state/model.js";
import { runModel } from "./factories.js";

const idle: CancelState = { pending: false, requested: false };

const renderHeader = (
  over: {
    model?: RunModel;
    connection?: ConnectionState;
    attempts?: number;
    cancel?: CancelState;
    elapsedMs?: number;
    suiteRunning?: boolean;
    suiteFinished?: boolean;
    onCloseDashboard?: () => void;
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
      {...(over.suiteRunning === undefined ? {} : { suiteRunning: over.suiteRunning })}
      {...(over.suiteFinished === undefined ? {} : { suiteFinished: over.suiteFinished })}
      {...(over.onCloseDashboard === undefined ? {} : { onCloseDashboard: over.onCloseDashboard })}
    />,
  );
  return { ...result, onCancel, onReconnect };
};

describe("Header — identity", () => {
  it("shows the scenario and spec path once they are known", () => {
    renderHeader();
    expect(screen.getByTestId("scenario-id")).toHaveTextContent("checkout-flow");
    expect(screen.getByTestId("spec-path")).toHaveTextContent("specs/checkout.e2e.md");
    expect(screen.getByTestId("run-id")).toHaveTextContent("run-1");
    expect(screen.getByTestId("attempt-id")).toHaveTextContent("attempt-1");
  });

  it("degrades to placeholders before the first event, never to 'undefined'", () => {
    renderHeader({ model: emptyRunModel, elapsedMs: 0 });
    expect(screen.getByTestId("scenario-id")).toHaveTextContent("—");
    expect(screen.getByTestId("spec-path")).toHaveTextContent("Waiting for a run…");
    expect(screen.getByTestId("run-id")).toHaveTextContent("—");
    expect(screen.getByTestId("attempt-id")).toHaveTextContent("—");
  });
});

describe("Header — live status", () => {
  it.each([
    ["running", "in progress", "badge-info"],
    ["passed", "passed", "badge-ok"],
    ["failed", "failed", "badge-bad"],
    ["inconclusive", "need details", "badge-warn"],
    ["error", "failed", "badge-bad"],
    ["cancelled", "need details", "badge-warn"],
  ] as const)("maps domain %s → %s with %s", (status, label, tone) => {
    renderHeader({ model: runModel({ status }) });
    const badge = screen.getByTestId("run-status");
    expect(badge).toHaveTextContent(label);
    expect(badge.parentElement).toHaveClass(tone);
  });

  it("falls back to not tested for a status the harness may add later", () => {
    renderHeader({ model: runModel({ status: "aborted" as never }) });
    const badge = screen.getByTestId("run-status");
    expect(badge).toHaveTextContent("not tested");
    expect(badge.parentElement).toHaveClass("badge-neutral");
  });
});

describe("Header — connection state", () => {
  it.each([
    ["connecting", "connecting…", "conn-info"],
    ["live", "live", "conn-ok"],
    ["reconnecting", "reconnecting…", "conn-warn"],
    ["closed", "finished", "conn-neutral"],
    ["unavailable", "unreachable", "conn-bad"],
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
        onCancel={() => {}}
        onReconnect={onReconnect}
        elapsedMs={0}
      />,
    );
    await user.click(screen.getByTestId("reconnect-button"));
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});

describe("Header — cancel", () => {
  it("invites a cancellation while the run is live and forwards the click", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderHeader();
    const button = screen.getByTestId("cancel-button");
    expect(button).toHaveTextContent("Cancel");
    expect(button).not.toBeDisabled();
    await user.click(button);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("disables cancel once the run has finished", () => {
    renderHeader({ model: runModel({ status: "passed" }) });
    expect(screen.getByTestId("cancel-button")).toBeDisabled();
    expect(screen.getByTestId("cancel-button")).toHaveTextContent("Run finished");
  });

  it("keeps cancel available for the suite while browsing a finished scenario", () => {
    renderHeader({ model: runModel({ status: "passed" }), suiteRunning: true });
    expect(screen.getByTestId("cancel-button")).not.toBeDisabled();
    expect(screen.getByTestId("cancel-button")).toHaveTextContent("Cancel suite");
  });

  it("shows a close control when the suite is finished", async () => {
    const user = userEvent.setup();
    const onCloseDashboard = vi.fn<() => void>();
    renderHeader({
      model: runModel({ status: "passed" }),
      suiteFinished: true,
      onCloseDashboard,
    });
    await user.click(screen.getByTestId("close-dashboard-button"));
    expect(onCloseDashboard).toHaveBeenCalledOnce();
  });
});
