import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActionGuidance, BlockingBudgets } from "../src/components/Budgets.js";
import { breach, budgets, resolvedConfig, runModel } from "./factories.js";

const pricing = { currency: "USD", inputPerMillionTokens: 3, outputPerMillionTokens: 15 };

const valueOf = (label: string): HTMLElement => {
  const dt = screen.getByText(label);
  const dd = dt.parentElement?.querySelector("dd");
  if (dd === null || dd === undefined) throw new Error(`no value for ${label}`);
  return dd as HTMLElement;
};

describe("BlockingBudgets — before the configuration is resolved", () => {
  it("admits the budgets are unknown instead of drawing empty gauges", () => {
    render(<BlockingBudgets model={runModel()} pricing={undefined} elapsedMs={0} />);
    expect(
      screen.getByText("Budgets unknown until the configuration is resolved."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("budget-maxTokens")).toBeNull();
  });
});

describe("BlockingBudgets — gauges", () => {
  const model = runModel({
    config: resolvedConfig(),
    model: {
      started: 6,
      finished: 6,
      inputTokens: 40_000,
      outputTokens: 10_000,
      verifierTokens: 8_000,
    },
  });

  it("states that these budgets are the only ones that can end a run", () => {
    render(<BlockingBudgets model={model} pricing={undefined} elapsedMs={0} />);
    expect(screen.getByTestId("blocking-budgets-panel")).toHaveTextContent(
      'Exhausting any one of these budgets stops the loop and makes the run "inconclusive". ' +
        "These are the only limits that block.",
    );
  });

  it("counts model calls against maxModelCalls", () => {
    render(<BlockingBudgets model={model} pricing={undefined} elapsedMs={0} />);
    const gauge = screen.getByTestId("budget-maxModelCalls");
    expect(within(gauge).getByText("6 / 30")).toBeInTheDocument();
    expect(within(gauge).getByText("24 left")).toBeInTheDocument();
  });

  it("sums input and output tokens, and footnotes the verifier share and its reserve", () => {
    render(<BlockingBudgets model={model} pricing={undefined} elapsedMs={0} />);
    const gauge = screen.getByTestId("budget-maxTokens");
    expect(within(gauge).getByText("50,000 / 200,000")).toBeInTheDocument();
    expect(within(gauge).getByText("of which 8,000 verifier · reserve 20,000")).toBeInTheDocument();
  });

  it("caps the attempt-timeout gauge at its limit so elapsed time never overflows it", () => {
    render(<BlockingBudgets model={model} pricing={undefined} elapsedMs={999_999} />);
    const gauge = screen.getByTestId("budget-attemptTimeout");
    expect(within(gauge).getByText("120.0 s / 120.0 s")).toBeInTheDocument();
    expect(within(gauge).getByText("0 ms left")).toBeInTheDocument();
  });

  it("prints the scalar timeouts that have no gauge, each under its own label", () => {
    render(<BlockingBudgets model={model} pricing={undefined} elapsedMs={0} />);
    // Read through the label: two swapped <dd>s would satisfy an unscoped text query while the
    // panel misreports both timeouts.
    expect(valueOf("Per-operation timeout")).toHaveTextContent(/^15\.0 s$/);
    expect(valueOf("Fixture cleanup timeout")).toHaveTextContent(/^5\.00 s$/);
  });

  // `budgets` is type-checked as `number` on the wire and nothing rejects Infinity or NaN, so the
  // panel used to print "Infinity s / Infinity s" — which reads like a configured budget.
  it("admits a non-finite attempt timeout instead of printing it as a budget", () => {
    const broken = runModel({
      config: resolvedConfig({
        budgets: { ...budgets, attemptTimeoutMs: Number.POSITIVE_INFINITY },
      }),
    });
    render(<BlockingBudgets model={broken} pricing={undefined} elapsedMs={5_000} />);
    const gauge = screen.getByTestId("budget-attemptTimeout");
    expect(gauge.textContent).not.toMatch(/∞|Infinity|NaN/);
    expect(within(gauge).getByText("5.00 s / —")).toBeInTheDocument();
    // The budgets that ARE finite keep rendering normally next to it.
    expect(
      within(screen.getByTestId("budget-maxModelCalls")).getByText("0 / 30"),
    ).toBeInTheDocument();
  });

  it("admits a non-finite scalar timeout in the same way", () => {
    const broken = runModel({
      config: resolvedConfig({
        budgets: { ...budgets, operationTimeoutMs: Number.NaN },
      }),
    });
    render(<BlockingBudgets model={broken} pricing={undefined} elapsedMs={0} />);
    expect(screen.getByTestId("blocking-budgets-panel").textContent).not.toMatch(/NaN|Infinity/);
  });

  it("marks the gauge of a budget that has actually been exhausted", () => {
    const exhausted = runModel({
      ...model,
      budgetBreaches: [breach({ budget: "maxTokens", used: 200_412 })],
    });
    render(<BlockingBudgets model={exhausted} pricing={undefined} elapsedMs={0} />);
    expect(screen.getByTestId("budget-maxTokens").querySelector(".gauge-track")).toHaveClass(
      "is-exhausted",
    );
    expect(
      screen.getByTestId("budget-maxModelCalls").querySelector(".gauge-track"),
    ).not.toHaveClass("is-exhausted");
  });
});

describe("BlockingBudgets — cost", () => {
  it("says 'unavailable' rather than inventing a number when no prices are declared", () => {
    const model = runModel({
      config: resolvedConfig(),
      model: {
        started: 1,
        finished: 1,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        verifierTokens: 0,
      },
    });
    render(<BlockingBudgets model={model} pricing={undefined} elapsedMs={0} />);
    expect(screen.getByTestId("cost-value")).toHaveTextContent("unavailable");
    expect(screen.getByTestId("cost-value")).not.toHaveTextContent("0");
  });

  it("computes the cost from the declared prices and the tokens actually used", () => {
    const model = runModel({
      config: resolvedConfig(),
      model: {
        started: 1,
        finished: 1,
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        verifierTokens: 0,
      },
    });
    render(<BlockingBudgets model={model} pricing={pricing} elapsedMs={0} />);
    // 1M input at 3 + 0.2M output at 15 = 3 + 3 = 6.
    expect(screen.getByTestId("cost-value")).toHaveTextContent("6.0000 USD");
  });

  it("says 'unavailable' rather than printing a non-finite figure", () => {
    // Token counts are copied from `modelCallFinished` unvalidated, so the finiteness guard is
    // reachable from the wire — and "never an estimate, never a zero" applies to it too.
    const model = runModel({
      config: resolvedConfig(),
      model: {
        started: 1,
        finished: 1,
        inputTokens: Number.POSITIVE_INFINITY,
        outputTokens: 0,
        verifierTokens: 0,
      },
    });
    render(<BlockingBudgets model={model} pricing={pricing} elapsedMs={0} />);
    expect(screen.getByTestId("cost-value")).toHaveTextContent("unavailable");
  });

  it("reports a zero cost as a real zero once prices are known", () => {
    render(
      <BlockingBudgets
        model={runModel({ config: resolvedConfig() })}
        pricing={pricing}
        elapsedMs={0}
      />,
    );
    expect(screen.getByTestId("cost-value")).toHaveTextContent("0.0000 USD");
  });
});

describe("BlockingBudgets — breaches", () => {
  it("lists nothing while no budget has been exhausted", () => {
    render(
      <BlockingBudgets
        model={runModel({ config: resolvedConfig() })}
        pricing={undefined}
        elapsedMs={0}
      />,
    );
    expect(screen.queryByTestId("budget-breaches")).toBeNull();
  });

  it("names each exhausted budget in prose, with its detail", () => {
    const model = runModel({
      config: resolvedConfig(),
      budgetBreaches: [
        breach({ budget: "maxModelCalls", limit: 30, used: 30 }),
        breach({
          budget: "attemptTimeout",
          limit: 120_000,
          used: 120_001,
          detail: "the agent loop was still running",
        }),
      ],
    });
    render(<BlockingBudgets model={model} pricing={undefined} elapsedMs={0} />);
    const list = screen.getByTestId("budget-breaches");
    const [calls, timeout] = within(list).getAllByRole("listitem");
    // Per row and anchored: asserting on the whole list cannot tell which row carries which
    // text, and would accept a stray " — undefined" on the breach that has no detail.
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(calls).toHaveTextContent(/^model calls exhausted — 30 \/ 30$/);
    expect(timeout).toHaveTextContent(
      /^attempt timeout exhausted — 120,001 \/ 120,000 — the agent loop was still running$/,
    );
  });

  it("falls back to the raw budget name if the harness ever adds one", () => {
    const model = runModel({
      config: resolvedConfig(),
      budgetBreaches: [breach({ budget: "someFutureBudget" as never, limit: 1, used: 2 })],
    });
    render(<BlockingBudgets model={model} pricing={undefined} elapsedMs={0} />);
    expect(screen.getByTestId("budget-breaches")).toHaveTextContent(
      /^someFutureBudget exhausted — 2 \/ 1$/,
    );
  });
});

describe("ActionGuidance", () => {
  it("is labelled indicative and states that crossing it degrades nothing", () => {
    render(<ActionGuidance model={runModel({ config: resolvedConfig() })} />);
    expect(screen.getByText("indicative")).toBeInTheDocument();
    expect(screen.getByTestId("action-guidance-panel")).toHaveTextContent(
      "A trajectory hint, not a limit.",
    );
    expect(screen.getByTestId("guidance-gauge")).toHaveClass("gauge-indicative");
  });

  it("counts accepted actions against the threshold", () => {
    render(<ActionGuidance model={runModel({ config: resolvedConfig(), actionCount: 12 })} />);
    expect(screen.getByTestId("action-count")).toHaveTextContent("12 / 25 suggested");
  });

  it("still counts actions when no threshold is known, and says so", () => {
    render(<ActionGuidance model={runModel({ actionCount: 4 })} />);
    expect(screen.getByTestId("action-count")).toHaveTextContent(
      "4 accepted action(s) — indicative threshold unknown",
    );
    expect(screen.queryByTestId("guidance-gauge")).toBeNull();
  });

  // `??` falls through on undefined only, so a non-finite threshold from the frozen contract or
  // from `configResolved` used to render as "0 / ∞ suggested". An unusable threshold is no
  // threshold: the panel must fall through to the branch that says so.
  it.each([
    ["contractMaxActions", { contractMaxActions: Number.POSITIVE_INFINITY }],
    ["a reported guidance", { guidance: { used: 1, guidance: Number.NaN, rendering: "?" } }],
  ])("treats a non-finite threshold from %s as no threshold at all", (_label, over) => {
    render(<ActionGuidance model={runModel({ actionCount: 3, ...over })} />);
    expect(screen.getByTestId("action-count")).toHaveTextContent(
      "3 accepted action(s) — indicative threshold unknown",
    );
    expect(screen.queryByTestId("guidance-gauge")).toBeNull();
  });

  it("falls back to the next threshold down when the one above it is unusable", () => {
    render(
      <ActionGuidance
        model={runModel({
          contractMaxActions: Number.POSITIVE_INFINITY,
          config: resolvedConfig({ maxActions: 25 }),
          actionCount: 3,
        })}
      />,
    );
    expect(screen.getByTestId("action-count")).toHaveTextContent("3 / 25 suggested");
  });

  it("prefers the scenario's own maxActions over the project default", () => {
    render(
      <ActionGuidance
        model={runModel({ config: resolvedConfig({ maxActions: 25 }), contractMaxActions: 8 })}
      />,
    );
    expect(screen.getByTestId("action-count")).toHaveTextContent("0 / 8 suggested");
  });

  it("prefers the threshold the harness actually reported over the resolved default", () => {
    render(
      <ActionGuidance
        model={runModel({
          config: resolvedConfig({ maxActions: 25 }),
          guidance: { used: 41, guidance: 40, rendering: "41 actions / 40 suggested" },
          actionCount: 41,
        })}
      />,
    );
    expect(screen.getByTestId("action-count")).toHaveTextContent("41 / 40 suggested");
  });

  it("reports a crossed threshold as a nudge, explicitly refusing nothing", () => {
    render(
      <ActionGuidance
        model={runModel({
          config: resolvedConfig(),
          actionCount: 26,
          guidance: { used: 26, guidance: 25, rendering: "26 actions / 25 suggested" },
        })}
      />,
    );
    const note = screen.getByTestId("guidance-exceeded");
    expect(note).toHaveTextContent("26 actions / 25 suggested");
    expect(note).toHaveTextContent("No action refused, no status degraded");
  });

  it("shows no crossing note until the harness reports one", () => {
    render(<ActionGuidance model={runModel({ config: resolvedConfig(), actionCount: 99 })} />);
    expect(screen.queryByTestId("guidance-exceeded")).toBeNull();
  });
});
