import type { ConsoleEntry, NetworkEntry } from "@difmp/core";
import type { BrowserContext, ConsoleMessage, Request, Response, WebError } from "playwright";
import { stripAnsi } from "./errors.js";

/** One `console.jsonl` line. Shape follows api-playwright.md §7 (`msg.location()` fields). */
export interface ConsoleRecord {
  readonly ts: string;
  readonly type: string;
  readonly text: string;
  readonly url: string;
  readonly line: number;
  readonly column: number;
}

/** One `network.jsonl` line. `phase` distinguishes the three events of one exchange. */
export interface NetworkRecord {
  readonly ts: string;
  readonly phase: "request" | "response" | "requestfailed";
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly status?: number;
  readonly ok?: boolean;
  readonly isNavigation?: boolean;
  readonly failure?: string;
}

const MAX_TEXT = 4000;
const clamp = (value: string): string => {
  const clean = stripAnsi(value);
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean;
};

export interface Recorders {
  readonly console: ReadonlyArray<ConsoleRecord>;
  readonly network: ReadonlyArray<NetworkRecord>;
  readonly consoleEntries: () => ReadonlyArray<ConsoleEntry>;
  readonly networkEntries: () => ReadonlyArray<NetworkEntry>;
}

/**
 * Context-level listeners, so pages opened later (popups) are covered without re-wiring.
 * Console args are JSHandles and are deliberately never touched — `msg.text()` already formats them
 * and pulling the handles would leak them.
 */
const now = () => new Date().toISOString();

export const attachRecorders = (context: BrowserContext, limit: number): Recorders => {
  const consoleRecords: Array<ConsoleRecord> = [];
  const networkRecords: Array<NetworkRecord> = [];

  const pushConsole = (record: ConsoleRecord) => {
    if (consoleRecords.length < limit) consoleRecords.push(record);
  };
  const pushNetwork = (record: NetworkRecord) => {
    if (networkRecords.length < limit) networkRecords.push(record);
  };

  context.on("console", (message: ConsoleMessage) => {
    const location = message.location();
    pushConsole({
      ts: now(),
      type: message.type(),
      text: clamp(message.text()),
      url: location.url,
      line: location.lineNumber,
      column: location.columnNumber,
    });
  });

  // Context-level equivalent of page `pageerror`.
  context.on("weberror", (error: WebError) => {
    const cause = error.error();
    pushConsole({
      ts: now(),
      type: "pageerror",
      text: clamp(`${cause.name}: ${cause.message}`),
      url: error.page()?.url() ?? "",
      line: 0,
      column: 0,
    });
  });

  context.on("request", (request: Request) => {
    pushNetwork({
      ts: now(),
      phase: "request",
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      isNavigation: request.isNavigationRequest(),
    });
  });

  context.on("response", (response: Response) => {
    const request = response.request();
    pushNetwork({
      ts: now(),
      phase: "response",
      method: request.method(),
      url: response.url(),
      resourceType: request.resourceType(),
      status: response.status(),
      ok: response.ok(),
    });
  });

  context.on("requestfailed", (request: Request) => {
    pushNetwork({
      ts: now(),
      phase: "requestfailed",
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      ok: false,
      failure: request.failure()?.errorText ?? "request failed",
    });
  });

  return {
    get console() {
      return consoleRecords;
    },
    get network() {
      return networkRecords;
    },
    consoleEntries: () => consoleRecords.map((r) => ({ ts: r.ts, level: r.type, text: r.text })),
    networkEntries: () =>
      networkRecords
        .filter((r) => r.phase !== "request")
        .map((r) => ({
          ts: r.ts,
          method: r.method,
          url: r.url,
          ...(r.status === undefined ? {} : { status: r.status }),
          ...(r.failure === undefined ? {} : { failure: r.failure }),
        })),
  };
};

export const toJsonl = (records: ReadonlyArray<unknown>): string =>
  records.map((record) => JSON.stringify(record)).join("\n") + (records.length === 0 ? "" : "\n");
