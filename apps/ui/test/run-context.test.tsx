import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunContext } from "../src/components/RunContext.js";
import { emptyRunModel } from "../src/state/model.js";
import { capture, resolvedConfig, runModel } from "./factories.js";

const valueOf = (label: string): HTMLElement => {
  const dt = screen.getByText(label);
  const dd = dt.parentElement?.querySelector("dd");
  if (dd === null || dd === undefined) throw new Error(`no value for ${label}`);
  return dd as HTMLElement;
};

describe("RunContext — before the run is resolved", () => {
  it("dashes every unknown field rather than printing 'undefined'", () => {
    render(<RunContext model={emptyRunModel} />);
    expect(valueOf("Target")).toHaveTextContent("—");
    expect(valueOf("Provider")).toHaveTextContent("—");
    expect(valueOf("Capture")).toHaveTextContent("—");
    expect(valueOf("Contract fingerprint")).toHaveTextContent("—");
    expect(valueOf("difmp version")).toHaveTextContent("—");
    expect(valueOf("Observations")).toHaveTextContent("0");
  });
});

describe("RunContext — resolved run", () => {
  it("shows the target, the capture settings and the harness version", () => {
    render(
      <RunContext
        model={runModel({
          baseUrl: "http://127.0.0.1:4173",
          capture,
          observationCount: 7,
          harnessVersion: "0.1.0",
        })}
      />,
    );
    expect(valueOf("Target")).toHaveTextContent("http://127.0.0.1:4173");
    expect(valueOf("Capture")).toHaveTextContent("trace on · video off · screenshots checkpoints");
    expect(valueOf("Observations")).toHaveTextContent("7");
    expect(valueOf("difmp version")).toHaveTextContent("0.1.0");
  });

  it("names the provider alone when no model is pinned", () => {
    render(<RunContext model={runModel({ config: resolvedConfig({ provider: "scripted" }) })} />);
    // Anchored: the " / model" suffix comes from a template literal, so a substring match would
    // also accept "scripted / undefined", which is the only thing this case is about.
    expect(valueOf("Provider")).toHaveTextContent(/^scripted$/);
  });

  it("names provider and model together when both are known", () => {
    render(
      <RunContext
        model={runModel({
          config: resolvedConfig({ provider: "anthropic", model: "claude-sonnet-5" }),
        })}
      />,
    );
    expect(valueOf("Provider")).toHaveTextContent(/^anthropic \/ claude-sonnet-5$/);
  });

  it("truncates the contract fingerprint to a readable prefix", () => {
    render(<RunContext model={runModel({ contractHash: "0123456789abcdef0123456789abcdef" })} />);
    expect(valueOf("Contract fingerprint")).toHaveTextContent("0123456789abcdef");
    expect(valueOf("Contract fingerprint").textContent).toHaveLength(16);
  });
});

describe("RunContext — fixture", () => {
  it("states there is no fixture instead of leaving the block out silently", () => {
    render(<RunContext model={runModel()} />);
    expect(
      screen.getByText("No fixture — clean context opened on the baseUrl."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("fixture-block")).toBeNull();
  });

  it("lists a fixture's public values — and only those", () => {
    render(
      <RunContext
        model={runModel({
          fixture: {
            name: "seeded-cart",
            publicValues: { userEmail: "a@b.co", itemCount: 3, premium: true },
          },
        })}
      />,
    );
    const block = screen.getByTestId("fixture-block");
    expect(
      within(block).getByRole("heading", { name: 'Fixture "seeded-cart"' }),
    ).toBeInTheDocument();
    expect(block).toHaveTextContent("userEmail");
    expect(block).toHaveTextContent("a@b.co");
    expect(block).toHaveTextContent("3");
    expect(block).toHaveTextContent("true");
  });

  it("stays silent about cleanup until the fixture has actually been cleaned", () => {
    render(<RunContext model={runModel({ fixture: { name: "seeded-cart", publicValues: {} } })} />);
    expect(screen.queryByText(/Cleanup:/)).toBeNull();
  });

  it("reports the cleanup, and flags a cleanup that timed out", () => {
    const { rerender } = render(
      <RunContext
        model={runModel({
          fixture: {
            name: "seeded-cart",
            publicValues: {},
            cleaned: { cleanupsRun: 2, timedOut: false },
          },
        })}
      />,
    );
    expect(screen.getByText("Cleanup: 2 finalizer(s)")).toBeInTheDocument();

    rerender(
      <RunContext
        model={runModel({
          fixture: {
            name: "seeded-cart",
            publicValues: {},
            cleaned: { cleanupsRun: 2, timedOut: true },
          },
        })}
      />,
    );
    expect(screen.getByText("Cleanup: 2 finalizer(s) — timed out")).toBeInTheDocument();
  });
});

describe("RunContext — errors", () => {
  it("shows no error list when the run is clean", () => {
    render(<RunContext model={runModel()} />);
    expect(screen.queryByTestId("errors-list")).toBeNull();
  });

  it("lists every error with its stage, and marks the fatal one", () => {
    render(
      <RunContext
        model={runModel({
          errors: [
            {
              seq: 4,
              ts: "2026-09-12T10:00:04.000Z",
              stage: "capture",
              reason: "screenshot failed",
              fatal: false,
            },
            {
              seq: 9,
              ts: "2026-09-12T10:00:09.000Z",
              stage: "browser",
              reason: "target closed",
              fatal: true,
              cause: "Protocol error: Target.closeTarget",
            },
          ],
        })}
      />,
    );
    const items = within(screen.getByTestId("errors-list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("capture — screenshot failed");
    expect(items[0]).not.toHaveClass("fatal");
    expect(items[1]).toHaveClass("fatal");
    expect(items[1]).toHaveTextContent("Protocol error: Target.closeTarget");
  });
});
