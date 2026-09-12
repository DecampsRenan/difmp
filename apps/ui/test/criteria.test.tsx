import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Criteria } from "../src/components/Criteria.js";
import { criterion, criterionResult } from "./factories.js";

describe("Criteria — before anything is known", () => {
  it("says the contract is not frozen rather than showing an empty list", () => {
    render(<Criteria criteria={[]} />);
    expect(screen.getByText("The contract is not frozen yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("criteria-list")).toBeNull();
    expect(within(screen.getByTestId("criteria-panel")).getByText("0")).toBeInTheDocument();
  });

  it("renders a criterion known by id alone, without inventing text or a method", () => {
    render(<Criteria criteria={[{ id: "c1", status: "pending", evidenceRequested: false }]} />);
    expect(screen.getByText("(criterion text unavailable)")).toBeInTheDocument();
    expect(screen.getByTestId("criterion-method-c1")).toHaveTextContent("unknown method");
    expect(screen.getByTestId("criterion-status-c1")).toHaveTextContent("pending");
  });
});

describe("Criteria — method", () => {
  it("names the deterministic check a code criterion runs", () => {
    render(<Criteria criteria={[criterion({ method: "code", checkName: "orderExists" })]} />);
    const method = screen.getByTestId("criterion-method-c1");
    expect(method).toHaveTextContent(/^code · orderExists$/);
    expect(method).toHaveClass("method-code");
  });

  it("shows a code criterion with no check name yet as plain 'code'", () => {
    render(<Criteria criteria={[criterion({ method: "code" })]} />);
    // Anchored: the suffix comes from a template literal, so a substring match would be happy
    // with "code · undefined" — exactly the regression this case exists to catch.
    expect(screen.getByTestId("criterion-method-c1")).toHaveTextContent(/^code$/);
  });

  it("marks a model criterion", () => {
    render(<Criteria criteria={[criterion({ method: "model" })]} />);
    expect(screen.getByTestId("criterion-method-c1")).toHaveClass("method-model");
  });
});

describe("Criteria — status", () => {
  it.each([
    ["pending", "badge-neutral"],
    ["passed", "badge-ok"],
    ["failed", "badge-bad"],
    ["inconclusive", "badge-warn"],
    ["error", "badge-bad"],
  ] as const)("renders the domain literal %s with the %s tone", (status, tone) => {
    render(<Criteria criteria={[criterion({ status })]} />);
    const el = screen.getByTestId("criterion-status-c1");
    expect(el).toHaveTextContent(status);
    expect(el.parentElement).toHaveClass(tone);
  });
});

describe("Criteria — evidence in flight", () => {
  it("says an evaluation is under way once evidence has been requested", () => {
    render(<Criteria criteria={[criterion({ evidenceRequested: true })]} />);
    expect(screen.getByText("Evidence requested, evaluation in progress…")).toBeInTheDocument();
  });

  it("drops that notice as soon as the result lands", () => {
    render(
      <Criteria
        criteria={[
          criterion({ evidenceRequested: true, status: "passed", result: criterionResult() }),
        ]}
      />,
    );
    expect(screen.queryByText("Evidence requested, evaluation in progress…")).toBeNull();
  });
});

describe("Criteria — result", () => {
  it("shows expected, observed and the cited evidence", () => {
    render(<Criteria criteria={[criterion({ status: "passed", result: criterionResult() })]} />);
    expect(screen.getByText("An order number is visible")).toBeInTheDocument();
    expect(
      screen.getByText("Order #4821 is visible in the confirmation panel"),
    ).toBeInTheDocument();
    expect(screen.getByText("shot-1")).toHaveClass("chip");
  });

  it("says 'none' when a result cites no evidence at all", () => {
    render(<Criteria criteria={[criterion({ result: criterionResult({ evidence: [] }) })]} />);
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it.each([
    [
      { kind: "model", provider: "anthropic", model: "claude-sonnet-5" },
      "model anthropic/claude-sonnet-5",
    ],
    [{ kind: "scripted-model" }, "scripted double (not a model judgement)"],
    [{ kind: "code", checkName: "orderExists" }, 'TS check "orderExists"'],
  ] as const)("names the evaluator: %o", (evaluator, label) => {
    render(<Criteria criteria={[criterion({ result: criterionResult({ evaluator }) })]} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("never presents the scripted double as a real model judgement", () => {
    render(
      <Criteria
        criteria={[
          criterion({ result: criterionResult({ evaluator: { kind: "scripted-model" } }) }),
        ]}
      />,
    );
    expect(screen.getByText(/not a model judgement/)).toBeInTheDocument();
  });

  it("explains which absence branch produced the verdict", () => {
    const { rerender } = render(
      <Criteria
        criteria={[
          criterion({
            status: "inconclusive",
            result: criterionResult({ status: "inconclusive", absence: "uncertain-navigation" }),
          }),
        ]}
      />,
    );
    expect(
      screen.getByText("absence after uncertain navigation → inconclusive"),
    ).toBeInTheDocument();

    rerender(
      <Criteria
        criteria={[
          criterion({
            status: "failed",
            result: criterionResult({ status: "failed", absence: "established-at-checkpoint" }),
          }),
        ]}
      />,
    );
    expect(screen.getByText("absence established at the checkpoint → failed")).toBeInTheDocument();
  });

  it("falls back to the raw absence branch if the harness ever adds one", () => {
    render(
      <Criteria
        criteria={[
          criterion({
            result: criterionResult({
              absence: "some-future-branch" as never,
            }),
          }),
        ]}
      />,
    );
    expect(screen.getByText("some-future-branch")).toBeInTheDocument();
  });

  it("shows declared limitations, and nothing when there are none", () => {
    const { rerender } = render(<Criteria criteria={[criterion({ result: criterionResult() })]} />);
    expect(screen.queryByText("Limitations")).toBeNull();

    rerender(
      <Criteria
        criteria={[criterion({ result: criterionResult({ limitations: "below the fold" }) })]}
      />,
    );
    expect(screen.getByText("below the fold")).toBeInTheDocument();
  });
});

describe("Criteria — the list", () => {
  it("keeps every criterion addressable by its own id and counts them", () => {
    render(
      <Criteria
        criteria={[
          criterion({ id: "c1", status: "passed" }),
          criterion({ id: "c2", status: "failed", text: "The cart is emptied" }),
          criterion({ id: "c3", status: "pending" }),
        ]}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByTestId("criterion-c2")).toHaveTextContent("The cart is emptied");
    expect(within(screen.getByTestId("criteria-panel")).getByText("3")).toBeInTheDocument();
  });
});
