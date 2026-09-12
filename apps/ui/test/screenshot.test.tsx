import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LatestScreenshot } from "../src/components/Screenshot.js";
import type { UiRuntimeConfig } from "../src/runtime/config.js";
import { artifact } from "./factories.js";

const config: UiRuntimeConfig = {
  eventsUrl: "events",
  cancelUrl: "cancel",
  contractUrl: "contract",
  artifactBaseUrl: "artifacts/",
};

describe("LatestScreenshot", () => {
  it("says so when nothing has been captured yet", () => {
    render(<LatestScreenshot artifacts={[]} config={config} />);
    expect(screen.getByText("No screenshot available yet.")).toBeInTheDocument();
  });

  it("ignores artifacts that are not screenshots", () => {
    render(
      <LatestScreenshot
        artifacts={[artifact({ artifactId: "trace-1", kind: "trace", path: "trace.zip" })]}
        config={config}
      />,
    );
    expect(screen.getByText("No screenshot available yet.")).toBeInTheDocument();
  });

  it("ignores a screenshot whose capture failed", () => {
    render(
      <LatestScreenshot
        artifacts={[artifact({ artifactId: "shot-1", state: "failed", path: undefined })]}
        config={config}
      />,
    );
    expect(screen.getByText("No screenshot available yet.")).toBeInTheDocument();
  });

  it("shows the most recent present screenshot, not the first one", () => {
    render(
      <LatestScreenshot
        artifacts={[
          artifact({ seq: 3, artifactId: "shot-1", path: "screenshots/shot-1.png" }),
          artifact({ seq: 7, artifactId: "shot-2", path: "screenshots/shot-2.png" }),
        ]}
        config={config}
      />,
    );
    const img = screen.getByTestId("screenshot-image");
    expect(img).toHaveAttribute("src", expect.stringContaining("shot-2.png"));
    expect(img).toHaveAccessibleName("Screenshot shot-2");
  });

  it("skips back over a later failed capture to the last one that exists", () => {
    render(
      <LatestScreenshot
        artifacts={[
          artifact({ seq: 3, artifactId: "shot-1", path: "screenshots/shot-1.png" }),
          artifact({ seq: 7, artifactId: "shot-2", state: "failed", path: undefined }),
        ]}
        config={config}
      />,
    );
    expect(screen.getByTestId("screenshot-image")).toHaveAttribute(
      "src",
      expect.stringContaining("shot-1.png"),
    );
  });

  it("captions the shot with its time, the action it belongs to and its id", () => {
    // Built from local components so the expected reading is the same in every timezone.
    const ts = new Date(2026, 8, 12, 10, 0, 5, 250).toISOString();
    render(
      <LatestScreenshot
        artifacts={[artifact({ ts, actionLabel: "a4 · click" })]}
        config={config}
      />,
    );
    expect(screen.getByTestId("screenshot-ts")).toHaveTextContent(/^10:00:05\.250$/);
    expect(screen.getByTestId("screenshot-action")).toHaveTextContent("a4 · click");
    expect(screen.getByText("shot-1")).toBeInTheDocument();
  });

  it("says the action is unknown rather than leaving the caption half-written", () => {
    render(<LatestScreenshot artifacts={[artifact()]} config={config} />);
    expect(screen.getByTestId("screenshot-action")).toHaveTextContent("unknown action");
  });

  it("refuses to render an img for a path that is not a safe relative artifact path", () => {
    render(
      <LatestScreenshot artifacts={[artifact({ path: "javascript:alert(1)" })]} config={config} />,
    );
    expect(screen.queryByTestId("screenshot-image")).toBeNull();
    expect(screen.getByTestId("screenshot-unavailable")).toHaveTextContent(
      "Screenshot shot-1 recorded, but its path is not servable.",
    );
  });

  it("does the same for a path that escapes the artifact base", () => {
    render(
      <LatestScreenshot artifacts={[artifact({ path: "../../../etc/shadow" })]} config={config} />,
    );
    expect(screen.queryByTestId("screenshot-image")).toBeNull();
    expect(screen.getByTestId("screenshot-unavailable")).toBeInTheDocument();
  });
});
