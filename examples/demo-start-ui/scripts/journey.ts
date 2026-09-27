import type { AgentScript, ScriptedCall, ScriptedStep } from "@difmp/agent-runtime";
import {
  check,
  clickByName,
  fillByName,
  findElement,
  finish,
  observe,
  screenshot,
} from "@difmp/agent-runtime";

/**
 * Scripted walkthroughs for https://demo.start-ui.com.
 *
 * The demo login is OTP-style with public "Demo mode" shortcuts: click `admin` (fills the
 * email), `Login with email`, then `000000` (fills and confirms). Scenarios stay read-mostly
 * so a shared public demo is not polluted with writes.
 *
 * The Start UI demo is a client-rendered SPA: the first observe after navigation often sees an
 * empty shell. Poll helpers re-observe until the named control appears before interacting.
 */

const turn = (text: string, calls: ReadonlyArray<ScriptedCall>): ScriptedStep => ({ text, calls });

/**
 * Pause on the Node side before the next observe. The Start UI demo hydrates after `load`;
 * rapid scripted observes otherwise finish while the aria tree is still an empty shell.
 */
const pauseThenObserve =
  (ms: number, text: string): ScriptedStep =>
  () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return { text, calls: [observe()] };
  };

export interface JourneyOptions {
  readonly criterionIds: ReadonlyArray<string>;
  /** Seeded book title used by the search scenario. */
  readonly searchTerm?: string;
}

const criterionAt = (options: JourneyOptions, index: number): string => {
  const id = options.criterionIds[index];
  if (id === undefined) {
    throw new Error(`the demo-start-ui script needs a criterion at index ${index}`);
  }
  return id;
};

type NameMatch = { readonly name: string; readonly role?: string };

/**
 * Re-observe until `match` is in the live observation, then run `onReady` once.
 * Leftover poll slots keep observing (no empty idle turns) so SPA hydration / route transitions
 * do not race the scripted click/fill.
 */
const pollThen = (
  match: NameMatch,
  onReady: ScriptedCall | ReadonlyArray<ScriptedCall>,
  options?: { readonly label?: string; readonly maxPolls?: number },
): Array<ScriptedStep> => {
  let done = false;
  // Keep this small: leftover slots after an early hit still spend model turns observing.
  // Wall-clock hydration is handled by `pauseThenObserve`, not by long poll chains.
  const maxPolls = options?.maxPolls ?? 4;
  const label = options?.label ?? match.name;
  const callsOnReady = Array.isArray(onReady) ? onReady : [onReady];
  const steps: Array<ScriptedStep> = [];
  for (let i = 0; i < maxPolls; i++) {
    steps.push((ctx) => {
      if (done) {
        return { text: `(settled) ${label}`, calls: [observe()] };
      }
      if (findElement(ctx.observation, match) !== undefined) {
        done = true;
        return { text: label, calls: callsOnReady };
      }
      return {
        text: `waiting for ${JSON.stringify(match.name)} (${i + 1}/${maxPolls})`,
        calls: [observe()],
      };
    });
  }
  steps.push((ctx) => {
    if (!done) {
      const available = (ctx.observation?.elements ?? [])
        .map((element) => `${element.role}:${element.name ?? ""}`)
        .join(", ");
      throw new Error(
        `demo-start-ui: ${JSON.stringify(match.name)} never appeared after ${maxPolls} polls` +
          (available.length > 0 ? `; available: ${available}` : " (observation empty)"),
      );
    }
    return { text: `${label} ready`, calls: [observe()] };
  });
  return steps;
};

const pollThenClick = (
  name: string,
  options?: { readonly role?: string; readonly intent?: string; readonly maxPolls?: number },
): Array<ScriptedStep> =>
  pollThen(
    { name, ...(options?.role === undefined ? {} : { role: options.role }) },
    clickByName(name, options),
    {
      ...(options?.maxPolls === undefined ? {} : { maxPolls: options.maxPolls }),
      label: options?.intent ?? `activate ${name}`,
    },
  );

const pollThenFill = (
  name: string,
  value: string,
  options?: { readonly role?: string; readonly maxPolls?: number },
): Array<ScriptedStep> =>
  pollThen(
    { name, ...(options?.role === undefined ? {} : { role: options.role }) },
    fillByName(name, value, options),
    {
      ...(options?.maxPolls === undefined ? {} : { maxPolls: options.maxPolls }),
      label: `fill ${name}`,
    },
  );

/** Wait until present, then capture — never activate the control. */
const pollUntilPresent = (
  name: string,
  options?: { readonly role?: string; readonly maxPolls?: number; readonly screenshot?: string },
): Array<ScriptedStep> => {
  const capture: ScriptedCall[] = [observe()];
  if (options?.screenshot !== undefined) capture.push(screenshot(options.screenshot));
  return pollThen(
    { name, ...(options?.role === undefined ? {} : { role: options.role }) },
    capture,
    {
      ...(options?.maxPolls === undefined ? {} : { maxPolls: options.maxPolls }),
      label: `found ${name}`,
    },
  );
};

/** Extra observes so a debounced client filter (Books search) can apply. */
const settle = (label: string, count = 3): Array<ScriptedStep> =>
  Array.from({ length: count }, (_, i) => turn(`${label} (${i + 1}/${count})`, [observe()]));

/** Public demo OTP login via the on-page Demo mode shortcuts. */
export const loginSteps = (): Array<ScriptedStep> => [
  turn("I observe the login page", [observe()]),
  pauseThenObserve(2_500, "I wait for the login SPA to hydrate"),
  ...pollThenClick("admin", { intent: "fill the demo admin email", maxPolls: 6 }),
  pauseThenObserve(500, "I wait for the admin email to populate"),
  ...pollThenClick("Login with email", { intent: "send the demo login code", maxPolls: 4 }),
  pauseThenObserve(2_500, "I wait for the verification page"),
  ...pollUntilPresent("000000", { maxPolls: 8 }),
  ...pollThenClick("000000", { intent: "confirm the demo OTP", maxPolls: 4 }),
  pauseThenObserve(2_500, "I wait for the manager dashboard"),
  ...pollUntilPresent("Dashboard", {
    role: "link",
    maxPolls: 8,
    screenshot: "after-login",
  }),
];

/** Login only — lands on the manager dashboard. */
export const loginAdminScript = (options: JourneyOptions): AgentScript => ({
  id: "login-admin",
  description: "signs in with the public demo admin OTP shortcuts and lands on the dashboard",
  steps: [
    ...loginSteps(),
    turn("I evaluate the login criteria", [
      check(criterionAt(options, 0)),
      check(criterionAt(options, 1)),
    ]),
    turn("done", [finish("demo admin login completed")]),
  ],
});

/** Login, open Books, search a seeded title, capture the filtered list. */
export const booksSearchScript = (options: JourneyOptions): AgentScript => {
  const term = options.searchTerm ?? "Dracula";
  return {
    id: "books-search",
    description: `signs in, opens Books, searches for ${term}`,
    steps: [
      ...loginSteps(),
      ...pollThenClick("Books", { role: "link", intent: "open the books list", maxPolls: 4 }),
      pauseThenObserve(1_000, "I wait for the Books page"),
      ...pollThenFill("Search...", term, { maxPolls: 6 }),
      pauseThenObserve(1_200, "I wait for the search debounce"),
      ...settle("confirming filtered results", 2),
      ...pollUntilPresent("Dracula", { role: "link", maxPolls: 6 }),
      turn("I capture the filtered list", [screenshot("books-search-result")]),
      turn("I evaluate the search criteria", [
        check(criterionAt(options, 0)),
        check(criterionAt(options, 1)),
      ]),
      turn("done", [finish(`books search for ${term} completed`)]),
    ],
  };
};

/** Login, then walk Manager nav: Books → Users → Dashboard. */
export const managerNavScript = (options: JourneyOptions): AgentScript => ({
  id: "manager-nav",
  description: "signs in and walks the manager sidebar links",
  steps: [
    ...loginSteps(),
    ...pollThenClick("Books", { role: "link", intent: "open Books", maxPolls: 4 }),
    pauseThenObserve(1_000, "I wait for the Books page"),
    ...pollUntilPresent("New Book", { role: "link", screenshot: "nav-books", maxPolls: 6 }),
    ...pollThenClick("Users", { role: "link", intent: "open Users", maxPolls: 4 }),
    pauseThenObserve(1_000, "I wait for the Users page"),
    ...pollUntilPresent("New User", { role: "link", screenshot: "nav-users", maxPolls: 6 }),
    ...pollThenClick("Dashboard", { role: "link", intent: "open Dashboard", maxPolls: 4 }),
    pauseThenObserve(1_000, "I wait for the Dashboard"),
    ...pollUntilPresent("Welcome to Start UI [web]", { screenshot: "nav-dashboard", maxPolls: 6 }),
    turn("I evaluate the navigation criteria", [
      check(criterionAt(options, 0)),
      check(criterionAt(options, 1)),
      check(criterionAt(options, 2)),
    ]),
    turn("done", [finish("manager navigation completed")]),
  ],
});

/** Login, open New Book form, assert fields — do not submit (shared demo). */
export const newBookFormScript = (options: JourneyOptions): AgentScript => ({
  id: "new-book-form",
  description: "signs in and opens the New Book form without creating a book",
  steps: [
    ...loginSteps(),
    ...pollThenClick("Books", { role: "link", intent: "open Books", maxPolls: 4 }),
    pauseThenObserve(1_000, "I wait for the Books page"),
    ...pollThenClick("New Book", {
      role: "link",
      intent: "open the create-book form",
      maxPolls: 4,
    }),
    pauseThenObserve(1_000, "I wait for the New Book form"),
    ...pollUntilPresent("Title", { screenshot: "new-book-form", maxPolls: 6 }),
    ...pollUntilPresent("Author", { maxPolls: 4 }),
    ...pollUntilPresent("Publisher", { maxPolls: 4 }),
    turn("I evaluate the form criteria", [
      check(criterionAt(options, 0)),
      check(criterionAt(options, 1)),
    ]),
    turn("done", [finish("new book form inspected without submit")]),
  ],
});
