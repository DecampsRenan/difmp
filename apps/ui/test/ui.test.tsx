import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, Empty, Gauge, Panel, durationOf, timeOf } from "../src/components/ui.js";

describe("Panel", () => {
  it("renders the title, the test id and the children", () => {
    render(
      <Panel title="Blocking budgets" testId="p">
        <span>body</span>
      </Panel>,
    );
    expect(screen.getByTestId("p")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Blocking budgets" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("omits the note paragraph entirely when there is no note", () => {
    const { container, rerender } = render(
      <Panel title="t" testId="p">
        x
      </Panel>,
    );
    expect(container.querySelector(".panel-note")).toBeNull();

    rerender(
      <Panel title="t" testId="p" note="a note" aside={<span>aside</span>}>
        x
      </Panel>,
    );
    expect(screen.getByText("a note")).toBeInTheDocument();
    expect(screen.getByText("aside")).toBeInTheDocument();
  });
});

describe("Badge", () => {
  it("carries its tone in the class name so the status is styleable and greppable", () => {
    render(<Badge tone="bad">failed</Badge>);
    expect(screen.getByText("failed")).toHaveClass("badge", "badge-bad");
  });
});

describe("Empty", () => {
  it("renders its message", () => {
    render(<Empty>nothing here</Empty>);
    expect(screen.getByText("nothing here")).toHaveClass("empty");
  });
});

const fillOf = (container: HTMLElement): string =>
  (container.querySelector(".gauge-fill") as HTMLElement).style.width;

describe("Gauge", () => {
  it("renders a proportional fill and the remaining amount", () => {
    const { container } = render(
      <Gauge kind="blocking" label="Tokens" used={50_000} limit={200_000} testId="g" />,
    );
    expect(fillOf(container)).toBe("25%");
    expect(screen.getByText("50,000 / 200,000")).toBeInTheDocument();
    expect(screen.getByText("150,000 left")).toBeInTheDocument();
  });

  it("clamps the fill at 100% and flags the overflow when the limit is passed", () => {
    const { container } = render(
      <Gauge kind="blocking" label="Tokens" used={300} limit={200} testId="g" />,
    );
    expect(fillOf(container)).toBe("100%");
    expect(container.querySelector(".gauge-track")).toHaveClass("is-over");
    // Never a negative remainder.
    expect(screen.getByText("0 left")).toBeInTheDocument();
  });

  it("does not divide by a zero limit", () => {
    const { container } = render(
      <Gauge kind="blocking" label="Calls" used={3} limit={0} testId="g" />,
    );
    expect(fillOf(container)).toBe("0%");
    expect(screen.getByText("3 / 0")).toBeInTheDocument();
  });

  it("marks an exhausted budget", () => {
    const { container } = render(
      <Gauge kind="blocking" label="Calls" used={30} limit={30} exhausted testId="g" />,
    );
    expect(container.querySelector(".gauge-track")).toHaveClass("is-exhausted");
  });

  it("words an indicative threshold as a threshold, never as a remaining allowance", () => {
    const { rerender } = render(
      <Gauge kind="indicative" label="Actions" used={10} limit={25} testId="g" />,
    );
    expect(screen.getByTestId("g")).toHaveClass("gauge-indicative");
    expect(screen.getByText("15 before the threshold")).toBeInTheDocument();
    expect(screen.queryByText(/left/)).toBeNull();

    rerender(<Gauge kind="indicative" label="Actions" used={31} limit={25} testId="g" />);
    expect(screen.getByText("6 past the threshold")).toBeInTheDocument();
  });

  it("applies a custom formatter to every number it prints", () => {
    render(
      <Gauge
        kind="blocking"
        label="Attempt timeout"
        used={30_000}
        limit={120_000}
        format={durationOf}
        testId="g"
      />,
    );
    expect(screen.getByText("30.0 s / 120.0 s")).toBeInTheDocument();
    expect(screen.getByText("90.0 s left")).toBeInTheDocument();
  });

  it("renders a footnote only when it is given one", () => {
    const { container, rerender } = render(
      <Gauge kind="blocking" label="Tokens" used={1} limit={2} testId="g" />,
    );
    expect(container.querySelector(".gauge-foot")).toBeNull();
    rerender(
      <Gauge kind="blocking" label="Tokens" used={1} limit={2} testId="g" footnote="reserve 20k" />,
    );
    expect(screen.getByText("reserve 20k")).toBeInTheDocument();
  });
});

describe("timeOf", () => {
  it("renders a wall-clock time with milliseconds", () => {
    // The instant is built from LOCAL components, so the expected reading holds in every
    // timezone: what is pinned is the clock value itself, not merely the shape of the digits.
    const local = new Date(2026, 8, 12, 10, 0, 5, 250);
    expect(timeOf(local.toISOString())).toBe("10:00:05.250");
  });

  it("returns an unparseable timestamp verbatim rather than printing 'Invalid Date'", () => {
    expect(timeOf("not-a-date")).toBe("not-a-date");
    expect(timeOf("")).toBe("");
  });
});

describe("durationOf", () => {
  it("stays in milliseconds below a second", () => {
    expect(durationOf(0)).toBe("0 ms");
    expect(durationOf(999)).toBe("999 ms");
  });

  it("switches to seconds with two decimals, then to one decimal past ten seconds", () => {
    expect(durationOf(1000)).toBe("1.00 s");
    expect(durationOf(9999)).toBe("10.00 s");
    expect(durationOf(10_000)).toBe("10.0 s");
    expect(durationOf(125_400)).toBe("125.4 s");
  });
});
