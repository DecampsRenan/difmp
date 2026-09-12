import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Artifacts } from "../src/components/Artifacts.js";
import type { UiRuntimeConfig } from "../src/runtime/config.js";
import { artifact, criterion, criterionResult } from "./factories.js";

const config: UiRuntimeConfig = {
  eventsUrl: "events",
  cancelUrl: "cancel",
  contractUrl: "contract",
  artifactBaseUrl: "artifacts/",
};

// A relative artifact base resolves against the page's own URL; deriving the origin keeps this
// file independent of whichever URL the jsdom environment is configured with.
const pageOrigin = new URL(globalThis.location.href).origin;

const linkCellOf = (id: string): HTMLElement => {
  const cells = within(screen.getByTestId(`artifact-${id}`)).getAllByRole("cell");
  const last = cells.at(-1);
  if (last === undefined) throw new Error(`no cells for ${id}`);
  return last;
};

describe("Artifacts — empty", () => {
  it("says no artifact was recorded", () => {
    render(<Artifacts artifacts={[]} criteria={[]} config={config} />);
    expect(screen.getByText("No artifact recorded.")).toBeInTheDocument();
    expect(screen.queryByTestId("artifacts-table")).toBeNull();
  });
});

describe("Artifacts — state", () => {
  it("links a present artifact, opening it away from the dashboard", () => {
    render(<Artifacts artifacts={[artifact()]} criteria={[]} config={config} />);
    const link = within(screen.getByTestId("artifact-shot-1")).getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("artifacts/screenshots/shot-1.png"),
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("keeps a failed capture listed, with its reason, instead of hiding it", () => {
    render(
      <Artifacts
        artifacts={[
          artifact({
            artifactId: "shot-2",
            state: "failed",
            path: undefined,
            reason: "the page navigated during the capture",
          }),
        ]}
        criteria={[]}
        config={config}
      />,
    );
    const row = screen.getByTestId("artifact-shot-2");
    expect(within(row).getByText("failed")).toHaveClass("badge-bad");
    expect(row).toHaveTextContent("the page navigated during the capture");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(linkCellOf("shot-2")).toHaveTextContent("—");
  });

  it("marks an expected-but-missing artifact", () => {
    render(
      <Artifacts
        artifacts={[
          artifact({
            artifactId: "trace-1",
            kind: "trace",
            state: "missing",
            path: undefined,
            reason: "capture disabled",
          }),
        ]}
        criteria={[]}
        config={config}
      />,
    );
    const row = screen.getByTestId("artifact-trace-1");
    expect(within(row).getByText("missing")).toHaveClass("badge-warn");
    // An expected artifact that is absent stays listed WITH its reason; a bare "missing" row
    // would leave the reader with no explanation at all.
    expect(row).toHaveTextContent("capture disabled");
  });

  it("falls back to a neutral tone for a state the harness may add later", () => {
    render(
      <Artifacts
        artifacts={[
          artifact({ artifactId: "trace-2", state: "pending" as never, path: undefined }),
        ]}
        criteria={[]}
        config={config}
      />,
    );
    const badge = within(screen.getByTestId("artifact-trace-2")).getByText("pending");
    expect(badge).toHaveClass("badge-neutral");
  });

  it("refuses to link a path that is recorded but not servable", () => {
    render(
      <Artifacts
        artifacts={[
          artifact({ artifactId: "shot-3", state: "missing", path: "screenshots/shot-3.png" }),
        ]}
        criteria={[]}
        config={config}
      />,
    );
    expect(linkCellOf("shot-3")).toHaveTextContent("not servable");
    expect(within(screen.getByTestId("artifact-shot-3")).queryByRole("link")).toBeNull();
  });
});

describe("Artifacts — journal paths are never trusted as URLs", () => {
  it.each([
    ["javascript:alert(1)", "a scheme"],
    ["data:text/html,<script>", "a data URI"],
    ["/etc/passwd", "an absolute path"],
    ["../../etc/passwd", "a traversal"],
    ["screenshots/../../secret.png", "a traversal in the middle"],
    ["//evil.example.com/x.png", "a protocol-relative URL"],
    ["", "an empty path"],
  ])("does not link %s (%s)", (path) => {
    render(
      <Artifacts
        artifacts={[artifact({ artifactId: "hostile", path })]}
        criteria={[]}
        config={config}
      />,
    );
    expect(within(screen.getByTestId("artifact-hostile")).queryByRole("link")).toBeNull();
  });

  it("escapes a path that is merely awkward rather than dropping it", () => {
    render(
      <Artifacts
        artifacts={[artifact({ artifactId: "odd", path: "screenshots/a b&c.png" })]}
        criteria={[]}
        config={config}
      />,
    );
    const link = within(screen.getByTestId("artifact-odd")).getByRole("link");
    expect(link).toHaveAttribute("href", expect.stringContaining("a%20b%26c.png"));
    // The human-readable path is still what the cell shows.
    expect(link).toHaveTextContent("screenshots/a b&c.png");
  });

  it("honours an artifact base the CLI moved elsewhere", () => {
    render(
      <Artifacts
        artifacts={[artifact()]}
        criteria={[]}
        config={{ ...config, artifactBaseUrl: "/runs/run-1/artifacts/" }}
      />,
    );
    expect(within(screen.getByTestId("artifact-shot-1")).getByRole("link")).toHaveAttribute(
      "href",
      `${pageOrigin}/runs/run-1/artifacts/screenshots/shot-1.png`,
    );
  });
});

describe("Artifacts — evidence back-references", () => {
  it("shows which criteria cited an artifact, including several", () => {
    render(
      <Artifacts
        artifacts={[artifact({ artifactId: "shot-1" }), artifact({ artifactId: "shot-2" })]}
        criteria={[
          criterion({ id: "c1", result: criterionResult({ evidence: ["shot-1"] }) }),
          criterion({ id: "c2", result: criterionResult({ evidence: ["shot-1", "shot-2"] }) }),
        ]}
        config={config}
      />,
    );
    const first = screen.getByTestId("artifact-shot-1");
    expect(within(first).getByText("c1")).toBeInTheDocument();
    expect(within(first).getByText("c2")).toBeInTheDocument();
    expect(within(screen.getByTestId("artifact-shot-2")).getByText("c2")).toBeInTheDocument();
  });

  it("dashes an artifact nothing cited", () => {
    render(
      <Artifacts
        artifacts={[artifact()]}
        criteria={[criterion({ id: "c1", result: criterionResult({ evidence: [] }) })]}
        config={config}
      />,
    );
    const cells = within(screen.getByTestId("artifact-shot-1")).getAllByRole("cell");
    expect(cells[4]).toHaveTextContent("—");
  });

  it("ignores criteria that have not been evaluated yet", () => {
    render(
      <Artifacts artifacts={[artifact()]} criteria={[criterion({ id: "c1" })]} config={config} />,
    );
    expect(screen.getByTestId("artifacts-table")).toBeInTheDocument();
    expect(within(screen.getByTestId("artifact-shot-1")).queryByText("c1")).toBeNull();
  });

  it("counts the artifacts in the panel header", () => {
    render(
      <Artifacts
        artifacts={[artifact({ artifactId: "a" }), artifact({ artifactId: "b" })]}
        criteria={[]}
        config={config}
      />,
    );
    expect(within(screen.getByTestId("artifacts-panel")).getByText("2")).toBeInTheDocument();
  });
});
