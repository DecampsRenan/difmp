import type { ScriptedProviderScript, VerdictScript, VerdictSpec } from "@difmp/agent-runtime";
import {
  booksSearchScript,
  loginAdminScript,
  managerNavScript,
  newBookFormScript,
  type JourneyOptions,
} from "./journey.js";

export * from "./journey.js";

const passed = (expected: string, observed: string): VerdictSpec => ({
  status: "passed",
  expected,
  observed,
  evidence: ["$all"],
});

const loginVerdicts: VerdictScript = {
  byCriterion: {
    c1: passed(
      "the manager dashboard is visible after login",
      "after the demo OTP, the page shows the Dashboard heading and Welcome to Start UI",
    ),
    c2: passed(
      "the signed-in admin account is available in the chrome",
      "the header shows an account control for the demo admin user",
    ),
  },
};

const booksSearchVerdicts: VerdictScript = {
  byCriterion: {
    c1: passed(
      "the Books page is open",
      "the Books heading and search field are visible after sidebar navigation",
    ),
    c2: passed(
      "the search results include the requested title",
      "the filtered books list shows Dracula after typing that title into Search",
    ),
  },
};

const managerNavVerdicts: VerdictScript = {
  byCriterion: {
    c1: passed(
      "Books is reachable from the sidebar",
      "the Books heading is visible after clicking the Books link",
    ),
    c2: passed(
      "Users is reachable from the sidebar",
      "the Users heading is visible after clicking the Users link",
    ),
    c3: passed(
      "Dashboard is reachable again from the sidebar",
      "the Dashboard heading is visible after returning via the Dashboard link",
    ),
  },
};

const newBookFormVerdicts: VerdictScript = {
  byCriterion: {
    c1: passed("the New Book form is open", "the New Book heading and Create control are visible"),
    c2: passed(
      "the main book fields are present",
      "Title, Author, Genre and Publisher controls are visible on the form",
    ),
  },
};

export interface DemoStartUiScriptOptions extends JourneyOptions {
  readonly searchTerm?: string;
}

/** Script names registered for this battery (stable; do not depend on criterion count). */
export const demoStartUiScriptNames = [
  "login-admin",
  "books-search",
  "manager-nav",
  "new-book-form",
] as const;

export type DemoStartUiScriptName = (typeof demoStartUiScriptNames)[number];

/** Build one scripted case. Only the requested walkthrough is constructed. */
export const buildDemoStartUiScript = (
  name: DemoStartUiScriptName,
  options: DemoStartUiScriptOptions,
): ScriptedProviderScript => {
  switch (name) {
    case "login-admin":
      return { agent: loginAdminScript(options), verdicts: loginVerdicts };
    case "books-search":
      return { agent: booksSearchScript(options), verdicts: booksSearchVerdicts };
    case "manager-nav":
      return { agent: managerNavScript(options), verdicts: managerNavVerdicts };
    case "new-book-form":
      return { agent: newBookFormScript(options), verdicts: newBookFormVerdicts };
  }
};
