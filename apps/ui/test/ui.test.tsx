import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "../src/components/ui.js";

describe("Badge", () => {
  it("carries its tone in the class name so the status is styleable and greppable", () => {
    render(<Badge tone="bad">failed</Badge>);
    expect(screen.getByText("failed")).toHaveClass("badge", "badge-bad");
  });
});
