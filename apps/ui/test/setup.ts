import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library's auto-cleanup only registers itself when the test globals are injected, and
// this workspace runs with `globals: false`. Unmounting by hand is what keeps one test's DOM — and
// its effects, intervals and EventSource — out of the next one.
afterEach(() => {
  cleanup();
});
