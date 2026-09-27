import { DateTime, Effect } from "effect";
import type { ArtifactId, AttemptId } from "../domain/ids.js";
import type { ArtifactRecord } from "../domain/result.js";
import type { ObserveResult } from "../domain/tools.js";
import type { BrowserSession, CaptureOutcome } from "../services/browser.js";
import type { EvidenceItem } from "../services/verifier.js";
import type { RunStore } from "../store/runStore.js";

/** What a screenshot capture settled to: the artifact id plus its final state. */
export interface ScreenshotOutcome {
  readonly artifactId: ArtifactId;
  readonly state: CaptureOutcome["state"];
  readonly reason: string | undefined;
}

/** What a check's probe payload settled to: its id, plus the reason it is not citable. */
export interface CheckPayloadOutcome {
  readonly artifactId: ArtifactId;
  readonly failed?: string;
}

/**
 * The attempt's Preuve recorder: the ONLY place that turns a capture, an observation or a check
 * payload into a durable artifact. It owns the three things that used to be scattered through the
 * runner: the WRITE (mint the id, build the `ArtifactRecord`, persist it), the evidence INDEX (only
 * artifacts that really survived may be cited by an evaluator), and the list of MANDATORY failures
 * (what `runAttempt` turns into an attempt-level `error` at the end).
 *
 * The rule that binds them (spec §10, design-contracts §9): a failed capture is RECORDED as
 * failed, never swallowed. A record the store refused is not a known artifact — it never enters
 * the index, the failure is journalled as an `error` event, and the caller sees `failed(reason)`
 * so adjudication can demote the criterion that was counting on it.
 */
export interface EvidenceRecorder {
  /** Capture a screenshot through the session and record it. Never fails: state says all. */
  readonly takeScreenshot: (
    session: BrowserSession,
    label: string,
    options?: { readonly fullPage?: boolean; readonly sourceSeq?: number },
  ) => Effect.Effect<ScreenshotOutcome>;
  /** Record a `CaptureOutcome` the driver already produced (trace, video, finalizer captures). */
  readonly registerCapture: (capture: CaptureOutcome) => Effect.Effect<ArtifactId>;
  /** Record a taken observation as `aria-snapshot` evidence, linked to its journal `seq`. */
  readonly recordObservation: (
    observation: ObserveResult,
    seq: number,
  ) => Effect.Effect<ArtifactId>;
  /** Write and record a check's probe payload. `failed` names why it cannot be cited. */
  readonly recordCheckPayload: (options: {
    readonly label: string;
    readonly data: unknown;
    readonly seq: number;
  }) => Effect.Effect<CheckPayloadOutcome>;
  /** Everything that survived, as citable evidence for an evaluation. */
  readonly items: () => ReadonlyArray<EvidenceItem>;
  /** The artifact ids behind `result.json`'s `attempt.artifacts`. */
  readonly artifactIds: () => ReadonlyArray<ArtifactId>;
  /** Mandatory evidence this attempt could not persist. spec §13: these make the run an `error`. */
  readonly mandatoryFailures: ReadonlyArray<string>;
  /** Note that MANDATORY evidence could not be persisted, so the run cannot silently succeed. */
  readonly noteMandatoryFailure: (message: string) => void;
}

export const makeEvidenceRecorder = (options: {
  readonly store: RunStore["Service"];
  readonly attemptId: AttemptId;
  /** The runner's redacting emit: every journalled event goes through the redactor upstream. */
  readonly emitEvent: (event: Parameters<RunStore["Service"]["emit"]>[0]) => Effect.Effect<void>;
}): EvidenceRecorder => {
  const { attemptId, emitEvent, store } = options;
  const layout = store.layout;

  const evidenceIndex = new Map<ArtifactId, EvidenceItem>();
  const mandatoryFailures: Array<string> = [];

  /**
   * Persist one artifact record, and say so when the store could not.
   *
   * spec §10 forbids hiding a capture failure, and design-contracts §9 makes `artifacts.json`
   * the inventory of every artifact the run produced. A record the store refused therefore NOT
   * a known artifact: it never enters the evidence index (so no evaluator can cite it) and the
   * failure is journalled as an `error`.
   *
   * Returns the reason the record could not be persisted, or `undefined` on success.
   */
  const persistArtifact = (record: ArtifactRecord): Effect.Effect<string | undefined> =>
    store.recordArtifact(record).pipe(
      Effect.result,
      Effect.flatMap((written) => {
        if (written._tag === "Success") return Effect.succeed(undefined);
        const reason =
          `artifact ${record.artifactId} (${record.kind}) could not be recorded in ` +
          `the inventory: ${written.failure.message}`;
        return emitEvent({
          type: "error",
          attemptId,
          stage: "evidence",
          reason,
          fatal: false,
        }).pipe(Effect.as(reason));
      }),
    );

  const mintAndStamp = () =>
    Effect.gen(function* () {
      const id = yield* store.mintArtifactId(attemptId);
      return { id, now: DateTime.formatIso(yield* DateTime.now) };
    });

  const registerCapture = (capture: CaptureOutcome): Effect.Effect<ArtifactId> =>
    Effect.gen(function* () {
      const { id, now } = yield* mintAndStamp();
      const record: ArtifactRecord = {
        artifactId: id,
        attemptId,
        kind: capture.kind,
        ...(capture.label === undefined ? {} : { label: capture.label }),
        ...(capture.path === undefined ? {} : { path: layout.relative(capture.path) }),
        state: capture.state,
        ...(capture.reason === undefined ? {} : { reason: capture.reason }),
        ...(capture.bytes === undefined ? {} : { bytes: capture.bytes }),
        ts: now,
      };
      const notPersisted = yield* persistArtifact(record);
      if (capture.state === "present" && notPersisted === undefined) {
        evidenceIndex.set(id, {
          artifactId: id,
          kind: capture.kind,
          ...(capture.label === undefined ? {} : { label: capture.label }),
          capturedAt: now,
          summary: `${capture.kind} ${capture.label ?? ""}`.trim(),
        });
      }
      return id;
    });

  const takeScreenshot = (
    session: BrowserSession,
    label: string,
    screenshotOptions?: { readonly fullPage?: boolean; readonly sourceSeq?: number },
  ): Effect.Effect<ScreenshotOutcome> =>
    Effect.gen(function* () {
      const { id, now } = yield* mintAndStamp();
      const capture = yield* session.screenshot({
        fileName: `${id}.png`,
        label,
        ...(screenshotOptions?.fullPage === undefined
          ? {}
          : { fullPage: screenshotOptions.fullPage }),
      });
      const record: ArtifactRecord = {
        artifactId: id,
        attemptId,
        kind: "screenshot",
        label,
        ...(capture.path === undefined ? {} : { path: layout.relative(capture.path) }),
        state: capture.state,
        ...(capture.reason === undefined ? {} : { reason: capture.reason }),
        ...(capture.bytes === undefined ? {} : { bytes: capture.bytes }),
        ts: now,
        ...(screenshotOptions?.sourceSeq === undefined
          ? {}
          : { sourceSeq: screenshotOptions.sourceSeq }),
      };
      const notPersisted = yield* persistArtifact(record);
      if (capture.state === "present" && notPersisted === undefined) {
        evidenceIndex.set(id, {
          artifactId: id,
          kind: "screenshot",
          label,
          capturedAt: now,
          ...(screenshotOptions?.sourceSeq === undefined
            ? {}
            : { sourceSeq: screenshotOptions.sourceSeq }),
          summary: `screenshot "${label}"`,
          ...(capture.image === undefined ? {} : { image: capture.image }),
        });
      }
      // A capture nobody can look up is a failed capture, whatever the browser managed to
      // write: this is what makes a checkpoint whose record was lost demote its criterion
      // instead of passing it on evidence that is not in the inventory.
      return notPersisted === undefined
        ? { artifactId: id, state: capture.state, reason: capture.reason }
        : { artifactId: id, state: "failed" as const, reason: notPersisted };
    });

  const recordObservation = (observation: ObserveResult, seq: number): Effect.Effect<ArtifactId> =>
    Effect.gen(function* () {
      const { id, now } = yield* mintAndStamp();
      const relative = `attempts/${attemptId}/observations/${id}.txt`;
      const body = `url: ${observation.url}\ntitle: ${observation.title}\n\n${observation.snapshot}`;
      const written = yield* store.writeRunFile(relative, body).pipe(Effect.result);
      const failed = written._tag === "Failure";
      const record: ArtifactRecord = {
        artifactId: id,
        attemptId,
        kind: "aria-snapshot",
        label: observation.observationId,
        ...(failed ? {} : { path: relative }),
        state: failed ? "failed" : "present",
        ...(failed ? { reason: written.failure.message } : {}),
        ts: now,
        sourceSeq: seq,
      };
      const notPersisted = yield* persistArtifact(record);
      if (!failed && notPersisted === undefined) {
        evidenceIndex.set(id, {
          artifactId: id,
          kind: "aria-snapshot",
          label: observation.observationId,
          capturedAt: now,
          sourceSeq: seq,
          summary: `page observation ${observation.observationId} at ${observation.url} (${observation.title})\n${observation.snapshot}`,
          data: {
            url: observation.url,
            title: observation.title,
            elements: observation.elements,
          },
        });
      }
      return id;
    });

  /**
   * A check's probe output is journalled AND persisted: an artifact the report can cite must
   * have something behind it. The write belongs to the check's own scope (see the runner's
   * `codeCheckBody`), the RECORDING belongs here.
   */
  const recordCheckPayload = (payloadOptions: {
    readonly label: string;
    readonly data: unknown;
    readonly seq: number;
  }): Effect.Effect<CheckPayloadOutcome> =>
    Effect.gen(function* () {
      const { id, now } = yield* mintAndStamp();
      const relative = `attempts/${attemptId}/evidence/${id}.json`;
      const body = `${JSON.stringify({ label: payloadOptions.label, data: payloadOptions.data }, null, 2)}\n`;
      const written = yield* store.writeRunFile(relative, body).pipe(Effect.result);
      const failed = written._tag === "Failure";
      const record: ArtifactRecord = {
        artifactId: id,
        attemptId,
        kind: "check-evidence",
        label: payloadOptions.label,
        ...(failed ? {} : { path: relative }),
        state: failed ? "failed" : "present",
        ...(failed ? { reason: written.failure.message } : {}),
        ts: now,
        sourceSeq: payloadOptions.seq,
      };
      const notPersisted = yield* persistArtifact(record);
      if (failed || notPersisted !== undefined) {
        // A check's probe output is mandatory evidence for its own criterion: a citation the
        // report cannot open is not a proof. The payload not reaching `artifacts.json` counts
        // the same as the payload not reaching disk: either way nothing can be looked up
        // behind the id.
        const why = written._tag === "Failure" ? written.failure.message : notPersisted;
        return {
          artifactId: id,
          failed: `check evidence "${payloadOptions.label}" (${id}): ${why}`,
        };
      }
      evidenceIndex.set(id, {
        artifactId: id,
        kind: "check-evidence",
        label: payloadOptions.label,
        capturedAt: now,
        sourceSeq: payloadOptions.seq,
        summary: `check evidence "${payloadOptions.label}"`,
        data: payloadOptions.data,
      });
      return { artifactId: id };
    });

  return {
    takeScreenshot,
    registerCapture,
    recordObservation,
    recordCheckPayload,
    items: () => [...evidenceIndex.values()],
    artifactIds: () => [...evidenceIndex.keys()],
    mandatoryFailures,
    noteMandatoryFailure: (message) => {
      mandatoryFailures.push(message);
    },
  };
};
