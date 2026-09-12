import { describe, expect, it } from "@effect/vitest";
import { parseAiSnapshot, refsOf } from "../src/index.js";

/** Verbatim `ariaSnapshot({ mode: "ai" })` output from Chromium 153 (.recon/bp-probe.mjs). */
const loginPage = `- main [ref=e2]:
  - heading "Sign in to Projects" [level=1] [ref=e3]
  - generic [ref=e4]:
    - generic [ref=e5]:
      - generic [ref=e6]: Email
      - textbox "Email" [ref=e7]
    - generic [ref=e8]:
      - generic [ref=e9]: Password
      - textbox "Password" [ref=e10]
    - button "Sign in" [ref=e12] [cursor=pointer]`;

/** Second document of the same page: every ref carries the `f1` frame-instance prefix. */
const afterNavigation = `- generic [active] [ref=f1e1]:
  - main [ref=f1e6]:
    - paragraph [ref=f1e8]:
      - text: "Workspace:"
      - strong [ref=f1e9]: Acme
    - textbox "Project name" [ref=f1e15]: Project Zephyr
    - alert [ref=f1e20]: "Could not create project (HTTP 500): The project could not be saved."`;

/** api-playwright.md §1b, covering properties, states and unreferenced children. */
const taskList = `- generic [active] [ref=e1]:
  - heading "Task list" [level=1] [ref=e2]
  - form "New task" [ref=e3]:
    - text: Title
    - textbox "Title" [ref=e4]:
      - /placeholder: What to do?
    - checkbox "Done" [checked] [ref=e5]
    - combobox "Priority" [ref=e6]:
      - option "Low"
      - option "High" [selected]
    - button "Add task" [ref=e7]
  - list "Tasks" [ref=e8]:
    - listitem [ref=e9]:
      - link "Alpha" [ref=e10] [cursor=pointer]:
        - /url: /a
  - paragraph [ref=e15]: Some static text.`;

describe("parseAiSnapshot", () => {
  it("keeps only referenced nodes, with role, name and level", () => {
    const elements = parseAiSnapshot(loginPage);
    expect(elements.map((e) => e.ref)).toEqual([
      "e2",
      "e3",
      "e4",
      "e5",
      "e6",
      "e7",
      "e8",
      "e9",
      "e10",
      "e12",
    ]);
    expect(elements[1]).toEqual({
      ref: "e3",
      role: "heading",
      name: "Sign in to Projects",
      level: 1,
    });
    expect(elements.find((e) => e.ref === "e7")).toEqual({
      ref: "e7",
      role: "textbox",
      name: "Email",
    });
  });

  it("parses frame-prefixed refs and inline text", () => {
    const elements = parseAiSnapshot(afterNavigation);
    expect(elements.map((e) => e.ref)).toEqual(["f1e1", "f1e6", "f1e8", "f1e9", "f1e15", "f1e20"]);
    expect(elements.find((e) => e.ref === "f1e15")?.text).toBe("Project Zephyr");
    expect(elements.find((e) => e.ref === "f1e20")?.text).toBe(
      `"Could not create project (HTTP 500): The project could not be saved."`,
    );
  });

  it("lifts /placeholder and /url onto their owner and decodes states", () => {
    const elements = parseAiSnapshot(taskList);
    expect(elements.find((e) => e.ref === "e4")).toEqual({
      ref: "e4",
      role: "textbox",
      name: "Title",
      placeholder: "What to do?",
    });
    expect(elements.find((e) => e.ref === "e5")?.checked).toBe(true);
    expect(elements.find((e) => e.ref === "e10")).toEqual({
      ref: "e10",
      role: "link",
      name: "Alpha",
      url: "/a",
    });
    // `option "High" [selected]` carries no ref, so the model can never target it.
    expect(elements.some((e) => e.role === "option")).toBe(false);
    expect(elements.find((e) => e.ref === "e15")?.text).toBe("Some static text.");
  });

  it("matches the refs the aria-ref engine will accept", () => {
    expect(refsOf(afterNavigation)).toEqual(parseAiSnapshot(afterNavigation).map((e) => e.ref));
    // The e\d+ form the cheat-sheet warns about matches nothing here.
    expect(afterNavigation.match(/\[ref=(e\d+)\]/g)).toBeNull();
  });
});
