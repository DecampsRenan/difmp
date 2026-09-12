import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Timeline } from "../src/components/Timeline.js";
import { timelineEntry } from "./factories.js";

const seqsOnScreen = (): ReadonlyArray<string> =>
  screen.getAllByTestId("timeline-entry").map((el) => el.dataset["seq"] ?? "");

const mixed = [
  timelineEntry({ seq: 1, kind: "lifecycle", label: "Run started" }),
  timelineEntry({ seq: 2, kind: "action", label: "a1 · click", outcome: "ok", durationMs: 420 }),
  timelineEntry({ seq: 3, kind: "observation", label: "Observation o1" }),
  timelineEntry({ seq: 4, kind: "verification", label: "Verification c1 — passed" }),
  timelineEntry({ seq: 5, kind: "evidence", label: "Evidence requested · c1" }),
  timelineEntry({ seq: 6, kind: "error", label: "Error (browser)" }),
  timelineEntry({ seq: 7, kind: "budget", label: "Blocking budget exhausted: maxTokens" }),
  timelineEntry({ seq: 8, kind: "guidance", label: "Indicative action threshold crossed" }),
  timelineEntry({ seq: 9, kind: "artifact", label: "Artifact shot-1 (screenshot) — present" }),
  timelineEntry({ seq: 10, kind: "model", label: "Model call (browser)" }),
];

describe("Timeline — empty states", () => {
  it("says nothing matched rather than showing an empty list", () => {
    render(<Timeline entries={[]} />);
    expect(screen.getByText("Nothing to show for this filter.")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-list")).toBeNull();
  });

  it("says the same thing when a filter excludes everything there is", async () => {
    const user = userEvent.setup();
    render(<Timeline entries={[timelineEntry({ seq: 1, kind: "lifecycle" })]} />);
    await user.click(screen.getByTestId("timeline-filter-actions"));
    expect(screen.getByText("Nothing to show for this filter.")).toBeInTheDocument();
  });
});

describe("Timeline — ordering", () => {
  it("shows the newest first by default, because that is where a live run is", () => {
    render(<Timeline entries={mixed} />);
    expect(seqsOnScreen()).toEqual(["10", "9", "8", "7", "6", "5", "4", "3", "2", "1"]);
    expect(screen.getByTestId("timeline-order")).toHaveTextContent("newest → oldest");
  });

  it("flips to chronological order and back", async () => {
    const user = userEvent.setup();
    render(<Timeline entries={mixed} />);
    await user.click(screen.getByTestId("timeline-order"));
    expect(seqsOnScreen()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(screen.getByTestId("timeline-order")).toHaveTextContent("oldest → newest");

    await user.click(screen.getByTestId("timeline-order"));
    expect(seqsOnScreen()[0]).toBe("10");
  });

  it("does not mutate the entries it was handed when reversing them", () => {
    const entries = [...mixed];
    render(<Timeline entries={entries} />);
    expect(entries.map((e) => e.seq)).toEqual(mixed.map((e) => e.seq));
  });
});

describe("Timeline — filters", () => {
  it("starts on 'all' with every kind visible", () => {
    render(<Timeline entries={mixed} />);
    expect(screen.getByTestId("timeline-filter-all")).toHaveClass("is-active");
    expect(seqsOnScreen()).toHaveLength(mixed.length);
  });

  it.each([
    ["actions", ["2"]],
    ["observations", ["3"]],
    // Verification is the verdict AND the evidence request that led to it.
    ["verifications", ["5", "4"]],
    // "Problems" deliberately groups errors, budgets and the indicative-threshold nudge.
    ["problems", ["8", "7", "6"]],
  ])("filter %s keeps exactly the right rows", async (filter, expected) => {
    const user = userEvent.setup();
    render(<Timeline entries={mixed} />);
    await user.click(screen.getByTestId(`timeline-filter-${filter}`));
    expect(seqsOnScreen()).toEqual(expected);
    expect(screen.getByTestId(`timeline-filter-${filter}`)).toHaveClass("is-active");
    expect(screen.getByTestId("timeline-filter-all")).not.toHaveClass("is-active");
  });

  it("goes back to everything when 'all' is selected again", async () => {
    const user = userEvent.setup();
    render(<Timeline entries={mixed} />);
    await user.click(screen.getByTestId("timeline-filter-actions"));
    await user.click(screen.getByTestId("timeline-filter-all"));
    expect(seqsOnScreen()).toHaveLength(mixed.length);
  });

  it("keeps the chosen order across a filter change", async () => {
    const user = userEvent.setup();
    render(<Timeline entries={mixed} />);
    await user.click(screen.getByTestId("timeline-order"));
    await user.click(screen.getByTestId("timeline-filter-problems"));
    expect(seqsOnScreen()).toEqual(["6", "7", "8"]);
  });
});

describe("Timeline — a row", () => {
  it("carries its seq, kind and tone, and prints its label and detail", () => {
    render(
      <Timeline
        entries={[
          timelineEntry({
            seq: 42,
            kind: "action",
            tone: "bad",
            label: "a3 · fill",
            detail: "ref=#email value=x@y.z",
            outcome: "error (invalid-params)",
            durationMs: 1500,
          }),
        ]}
      />,
    );
    const row = screen.getByTestId("timeline-entry");
    expect(row).toHaveAttribute("data-seq", "42");
    expect(row).toHaveAttribute("data-kind", "action");
    expect(row).toHaveClass("tl-action", "tone-bad");
    expect(row).toHaveTextContent("#42");
    expect(row).toHaveTextContent("a3 · fill");
    expect(row).toHaveTextContent("ref=#email value=x@y.z");
    expect(row).toHaveTextContent("error (invalid-params)");
    expect(row).toHaveTextContent("1.50 s");
  });

  it("marks an action that has not come back yet as in progress", () => {
    render(<Timeline entries={[timelineEntry({ seq: 1, kind: "action", label: "a1 · click" })]} />);
    expect(screen.getByText("in progress…")).toHaveClass("tl-outcome", "pending");
  });

  it("never invents an outcome for a row that has none and cannot get one", () => {
    const { container } = render(
      <Timeline
        entries={[timelineEntry({ seq: 1, kind: "observation", label: "Observation o1" })]}
      />,
    );
    expect(container.querySelector(".tl-outcome")).toBeNull();
  });

  it("leaves the duration column blank when nothing was timed", () => {
    const { container } = render(
      <Timeline entries={[timelineEntry({ seq: 1, kind: "lifecycle" })]} />,
    );
    expect(container.querySelector(".tl-dur")).toHaveTextContent("");
  });
});
