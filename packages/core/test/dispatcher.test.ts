import { describe, expect, it } from "@effect/vitest";
import { Crypto, Effect, FileSystem } from "effect";
import { RunStore, makeRedactor, readRunJournal } from "../src/index.js";
import type { ArtifactRecord } from "../src/domain/result.js";
import type { ObserveResult } from "../src/domain/tools.js";
import type { BrowserSession, CaptureOutcome } from "../src/services/browser.js";
import { makeDispatcher } from "../src/runner/dispatcher.js";
import type { DispatchResult, ToolDispatcher } from "../src/runner/dispatcher.js";
import { makeEvidenceRecorder } from "../src/runner/evidence.js";
import type { EvidenceRecorder } from "../src/runner/evidence.js";
import { platform } from "./helpers.js";

const runId = "r_abcdefghijklm";
const attemptId = "a1";

/**
 * Direct tests of the tool dispatcher (runner/dispatcher.ts). The extraction made the 8-case
 * switch testable without scripting a model: the harness hands it a recording fake browser and a
 * REAL RunStore on a temp directory, so the journal order and the artifact inventory are checked
 * on the path production writes. These are the six paths that decided the extraction — `press`,
 * `scroll`, the `fullPage` capture, the every-action capture, the reference refusals and the
 * interaction-navigation reset (issue #36).
 */

interface HarnessOptions {
  readonly screenshots?: "off" | "checkpoints" | "every-action";
  readonly elements?: ReadonlyArray<{
    readonly ref: string;
    readonly role: string;
    readonly name: string;
  }>;
  /** What `click`/`fill`/`press` report back — the interaction-driven-navigation rule. */
  readonly navigated?: boolean;
}

interface Handles {
  readonly dispatcher: ToolDispatcher;
  readonly recorder: EvidenceRecorder;
  readonly call: (
    name: string,
    params?: unknown,
  ) => Effect.Effect<DispatchResult, never, Crypto.Crypto>;
  readonly pageCalls: Array<{ op: string; params: unknown }>;
  readonly screenshotParams: Array<{ fileName: string; fullPage?: boolean }>;
  readonly verified: Array<string>;
  readonly journal: () => Effect.Effect<Array<{ type: string; detail: string }>>;
  readonly inventory: () => Effect.Effect<ReadonlyArray<ArtifactRecord>>;
}

const buildHandles = (
  store: RunStore["Service"],
  dir: string,
  fs: FileSystem.FileSystem["Service"],
  options: HarnessOptions,
): Handles => {
  const pageCalls: Array<{ op: string; params: unknown }> = [];
  const screenshotParams: Array<{ fileName: string; fullPage?: boolean }> = [];
  const elements = options.elements ?? [{ ref: "e1", role: "button", name: "Create" }];
  const session: BrowserSession = {
    observe: (observationId) =>
      Effect.sync((): ObserveResult => {
        pageCalls.push({ op: "observe", params: { observationId } });
        return {
          observationId,
          url: "http://localhost:3000/",
          title: "Fixture app",
          snapshot: elements.map((e) => `- ${e.role} "${e.name}" [ref=${e.ref}]`).join("\n"),
          elements,
        };
      }),
    navigate: ({ url }) =>
      Effect.sync(() => {
        pageCalls.push({ op: "navigate", params: { url } });
        return { url, settled: true };
      }),
    click: (params) =>
      Effect.sync(() => {
        pageCalls.push({ op: "click", params });
        return { performed: true as const, navigated: options.navigated ?? false };
      }),
    fill: (params) =>
      Effect.sync(() => {
        pageCalls.push({ op: "fill", params });
        return { performed: true as const, navigated: options.navigated ?? false };
      }),
    press: (params) =>
      Effect.sync(() => {
        pageCalls.push({ op: "press", params });
        return { performed: true as const, navigated: options.navigated ?? false };
      }),
    scroll: (params) =>
      Effect.sync(() => {
        pageCalls.push({ op: "scroll", params });
        return { performed: true as const, navigated: false };
      }),
    screenshot: (params) =>
      Effect.sync((): CaptureOutcome => {
        pageCalls.push({ op: "screenshot", params });
        screenshotParams.push({
          fileName: params.fileName,
          ...(params.fullPage === undefined ? {} : { fullPage: params.fullPage }),
        });
        return {
          kind: "screenshot",
          state: "present",
          path: `${dir}/shot.png`,
          bytes: 4,
          image: { mediaType: "image/png", data: new Uint8Array([137, 80, 78, 71]) },
        };
      }),
    currentUrl: Effect.succeed("http://localhost:3000/"),
    consoleEntries: Effect.succeed([]),
    networkEntries: Effect.succeed([]),
    finalize: () => Effect.succeed([]),
  };

  const emitEvent = (event: Parameters<RunStore["Service"]["emit"]>[0]) =>
    store.emit(event).pipe(Effect.ignore);
  const recorder = makeEvidenceRecorder({ store, attemptId, emitEvent });
  const verified: Array<string> = [];
  const dispatcher = makeDispatcher({
    attemptId,
    store,
    emitEvent,
    journalEvent: (event) => store.emit(event),
    redactor: makeRedactor([]),
    recorder,
    operationTimeoutMs: 5_000,
    maxActions: 40,
    allowedOrigins: ["http://localhost:3000"],
    screenshots: options.screenshots ?? "checkpoints",
    criterionIds: ["c1"],
    verifyCriterion: (_session, criterionId) =>
      Effect.sync(() => {
        verified.push(criterionId);
      }),
  });

  let turn = 0;
  const call = (name: string, params: unknown = {}) =>
    dispatcher.dispatch(session, { id: `tc_${(turn += 1)}`, name, params });

  return {
    dispatcher,
    recorder,
    call,
    pageCalls,
    screenshotParams,
    verified,
    journal: () =>
      Effect.map(readRunJournal(store.layout.events), (scan) =>
        scan.events.map((event) => {
          const record = event as unknown as Record<string, unknown>;
          const detail = [record["code"], record["kind"], record["label"], record["tool"]]
            .filter((v) => typeof v === "string")
            .join(":");
          return { type: event.type, detail };
        }),
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    inventory: () => Effect.map(store.inventory, (inv) => inv.artifacts),
  };
};

const run =
  (options: HarnessOptions) =>
  (use: (h: Handles) => Effect.Effect<void, never, Crypto.Crypto>): Effect.Effect<void> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs
        .makeTempDirectoryScoped({ prefix: "difmp-dispatcher-" })
        .pipe(Effect.orDie);
      const handles = yield* Effect.gen(function* () {
        const store = yield* RunStore;
        return buildHandles(store, dir, fs, options);
      }).pipe(Effect.provide(RunStore.layer({ runId, outputDir: dir })));
      yield* use(handles);
    }).pipe(Effect.scoped, Effect.provide(platform));

describe("tool dispatcher", () => {
  it.effect("press works without an observationId and forwards the key", () =>
    run({})((h) =>
      Effect.gen(function* () {
        const out = yield* h.call("press", { key: "Enter" });
        expect(out.isError).toBe(false);
        expect(out.result).toEqual({ performed: true, navigated: false });
        expect(h.pageCalls).toEqual([{ op: "press", params: { key: "Enter" } }]);
        // A browser tool counts against the guidance even when nothing is validated against it.
        expect(h.dispatcher.actionsUsed()).toBe(1);
      }),
    ),
  );

  it.effect("press with a stale observationId is refused WITHOUT touching the page", () =>
    run({})((h) =>
      Effect.gen(function* () {
        // Nothing observed yet: an observationId cannot resolve.
        const early = yield* h.call("press", { observationId: "obs_1", key: "Tab" });
        expect(early.isError).toBe(true);
        expect((early.result as { code: string; message: string }).code).toBe("stale-observation");
        expect((early.result as { message: string }).message).toBe(
          "no observation has been taken yet",
        );

        yield* h.call("observe");
        // The live observation is `obs_1` now; anything else is a stale reference.
        const wrong = yield* h.call("press", { observationId: "obs_99", key: "Tab" });
        expect(wrong.isError).toBe(true);
        expect((wrong.result as { code: string }).code).toBe("stale-observation");
        expect((wrong.result as { message: string }).message).toContain("is no longer live");
        // The page was never touched by either refusal.
        expect(h.pageCalls.map((c) => c.op)).toEqual(["observe"]);
      }),
    ),
  );

  it.effect("scroll forwards direction and amount to the driver", () =>
    run({})((h) =>
      Effect.gen(function* () {
        const out = yield* h.call("scroll", { direction: "down", amount: 400 });
        expect(out.isError).toBe(false);
        expect(out.result).toEqual({ performed: true, navigated: false });
        expect(h.pageCalls).toEqual([{ op: "scroll", params: { direction: "down", amount: 400 } }]);
        expect(h.dispatcher.actionsUsed()).toBe(1);
      }),
    ),
  );

  it.effect("screenshot forwards fullPage and records citable evidence", () =>
    run({})((h) =>
      Effect.gen(function* () {
        const out = yield* h.call("screenshot", { label: "full", fullPage: true });
        expect(out.isError).toBe(false);
        expect(h.screenshotParams).toEqual([
          { fileName: expect.stringMatching(/^art_1\.png$/), fullPage: true },
        ]);
        const artifacts = yield* h.inventory();
        expect(artifacts.map((a) => [a.kind, a.label, a.state])).toEqual([
          ["screenshot", "full", "present"],
        ]);
        const items = h.recorder.items();
        expect(items).toHaveLength(1);
        expect(items[0]?.summary).toBe('screenshot "full"');
        // The `checkpoints` policy takes exactly this one shot, not a per-action one.
        expect(h.pageCalls.filter((c) => c.op === "screenshot")).toHaveLength(1);
      }),
    ),
  );

  it.effect("every-action capture lands after the action's own journal close, on every path", () =>
    run({ screenshots: "every-action" })((h) =>
      Effect.gen(function* () {
        const observed = yield* h.call("observe");
        expect(observed.isError).toBe(false);
        const refused = yield* h.call("click", { observationId: "obs_1", ref: "zz" });
        expect(refused.isError).toBe(true);

        const artifacts = yield* h.inventory();
        // The capture follows even a REFUSED browser action — the loop always took it.
        expect(artifacts.map((a) => a.label)).toEqual(["obs_1", "after-observe", "after-click"]);

        const journal = yield* h.journal();
        expect(journal.map((e) => e.type)).toEqual([
          "actionStarted",
          "observationTaken",
          "artifactAvailable",
          "actionFinished",
          "artifactAvailable",
          "actionStarted",
          "actionFinished",
          "artifactAvailable",
        ]);
        // `check` is not a browser tool: it never triggers the capture.
        const check = yield* h.call("check", { criterionId: "c1" });
        expect(check.isError).toBe(false);
        expect(h.verified).toEqual(["c1"]);
        expect((yield* h.inventory()).filter((a) => a.kind === "screenshot")).toHaveLength(2);
      }),
    ),
  );

  it.effect("unknown and ambiguous references are refused without touching the page", () =>
    run({
      elements: [
        { ref: "e1", role: "button", name: "One" },
        { ref: "e1", role: "button", name: "Two" },
        { ref: "e2", role: "link", name: "Only" },
      ],
    })((h) =>
      Effect.gen(function* () {
        yield* h.call("observe");

        const unknown = yield* h.call("click", { observationId: "obs_1", ref: "zz" });
        expect(unknown.isError).toBe(true);
        expect((unknown.result as { code: string }).code).toBe("unknown-reference");
        expect((unknown.result as { message: string }).message).toBe(
          "reference zz is not in the current observation",
        );

        const ambiguous = yield* h.call("click", { observationId: "obs_1", ref: "e1" });
        expect(ambiguous.isError).toBe(true);
        expect((ambiguous.result as { code: string }).code).toBe("ambiguous-reference");

        // Both refusals are journalled as closed error actions — the pairing survives every path.
        const journal = yield* h.journal();
        expect(journal.map((e) => `${e.type}${e.detail === "" ? "" : ":" + e.detail}`)).toEqual([
          "actionStarted:observe",
          "observationTaken",
          "artifactAvailable:aria-snapshot",
          "actionFinished:observe",
          "actionStarted:click",
          "actionFinished:unknown-reference:click",
          "actionStarted:click",
          "actionFinished:ambiguous-reference:click",
        ]);
        // The page only ever saw the observation… until a VALID ref goes through.
        expect(h.pageCalls.map((c) => c.op)).toEqual(["observe"]);
        const valid = yield* h.call("click", { observationId: "obs_1", ref: "e2" });
        expect(valid.isError).toBe(false);
        expect(h.pageCalls.map((c) => c.op)).toEqual(["observe", "click"]);
      }),
    ),
  );

  it.effect("an interaction that navigates drops the observation and un-settles the page", () =>
    run({ navigated: true })((h) =>
      Effect.gen(function* () {
        h.dispatcher.noteNavigationSettled(true);
        yield* h.call("observe");
        expect(h.dispatcher.navigationSettled()).toBe(true);
        expect(h.dispatcher.currentObservation()).toBeDefined();

        const clicked = yield* h.call("click", { observationId: "obs_1", ref: "e1" });
        expect(clicked.isError).toBe(false);
        // The absence rule now treats what follows as uncertain until the page is observed again.
        expect(h.dispatcher.navigationSettled()).toBe(false);
        expect(h.dispatcher.currentObservation()).toBeUndefined();

        const stale = yield* h.call("fill", {
          observationId: "obs_1",
          ref: "e1",
          value: "x",
        });
        expect(stale.isError).toBe(true);
        expect((stale.result as { code: string }).code).toBe("stale-observation");
      }),
    ),
  );

  it.effect("refusals never end the run; only a schema-breaking driver result does", () =>
    run({})((h) =>
      Effect.gen(function* () {
        // A navigate against a disallowed origin is a refusal, not a contract violation.
        const blocked = yield* h.call("navigate", { url: "http://evil.example.com/" });
        expect(blocked.isError).toBe(true);
        expect((blocked.result as { code: string }).code).toBe("origin-not-allowed");
        expect(blocked.executionError).toBeUndefined();

        // Params that do not decode are handed back to the model as an invalid-params error.
        const bad = yield* h.call("scroll", { direction: "sideways" });
        expect(bad.isError).toBe(true);
        expect((bad.result as { code: string }).code).toBe("invalid-params");
        expect(bad.executionError).toBeUndefined();

        // Unknown tools are refused WITHOUT minting an action — nothing is journalled for them.
        const unknown = yield* h.call("teleport");
        expect((unknown.result as { code: string }).code).toBe("invalid-params");
        const started = (yield* h.journal()).filter((e) => e.type === "actionStarted");
        expect(started).toHaveLength(2);
      }),
    ),
  );
});
