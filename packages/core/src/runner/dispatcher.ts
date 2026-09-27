import { Crypto, Effect, Schema } from "effect";
import type { CaptureConfig } from "../domain/config.js";
import { strictQuietParseOptions } from "../domain/decode.js";
import type { StoreError } from "../domain/errors.js";
import type { RunStage } from "../domain/errors.js";
import type { HarnessEvent, HarnessEventInput } from "../domain/events.js";
import type { ActionId, AttemptId } from "../domain/ids.js";
import type { ObserveResult, ToolErrorCode, ToolErrorResult, ToolName } from "../domain/tools.js";
import { toolParamSchemas, toolResultSchemas } from "../domain/tools.js";
import { makeActionGuidance, recordAction } from "../policy/actions.js";
import { checkNavigationOrigin } from "../policy/origins.js";
import type { Redactor } from "../policy/redact.js";
import type { BrowserSession } from "../services/browser.js";
import type { RunStore } from "../store/runStore.js";
import type { EvidenceRecorder } from "./evidence.js";

/** What one dispatched tool call settled to, plus the run-ending error a driver caused. */
export interface DispatchResult {
  readonly result: unknown;
  readonly isError: boolean;
  /**
   * A tool RESULT that does not decode against its schema is a harness/driver contract
   * violation (spec §7): the run must end. The dispatcher names it; the loop decides where.
   */
  readonly executionError?: { readonly stage: RunStage; readonly reason: string };
}

/**
 * The attempt's tool dispatcher: the whole 8-case switch the browser agent calls into, plus the
 * memory that switch needs. It OWNS the live page state — `currentObservation` (it knows a
 * navigating click invalidates it) and `navigationSettled` (the input of the absence rule, §8) —
 * and the action bookkeeping: the guidance counter, the one-shot nudge, and the open
 * `actionStarted` that a cancellation must pair. The runner only CONSULTS these: at the
 * adjudication call site for the page facts, and at the loop edges for the nudge and the
 * interrupted action. It owns no verdicts — `check` runs through the injected `verifyCriterion`.
 *
 * Every tool crosses the same ritual, written exactly once here: mint + count, decode params
 * against the tool schema, journal `actionStarted`, run (operation-timeout bounded), schema-check
 * the RESULT (§7 — the driver is an untrusted boundary), journal `actionFinished`, and the
 * `every-action` capture when the config asks for it.
 */
export interface ToolDispatcher {
  readonly dispatch: (
    session: BrowserSession,
    call: { readonly id: string; readonly name: string; readonly params: unknown },
  ) => Effect.Effect<DispatchResult, never, Crypto.Crypto>;
  /** The observation refs and staleness are validated against; `observe` replaces it, a navigation drops it. */
  readonly currentObservation: () => ObserveResult | undefined;
  readonly navigationSettled: () => boolean;
  /** Seed the settling state from the runner's INITIAL navigation, before any tool call. */
  readonly noteNavigationSettled: (settled: boolean) => void;
  /** `finish` was called; the loop stops navigating and the final pass runs. */
  readonly finishRequested: () => boolean;
  /** Browser tool calls made so far. `check` and `finish` never count. */
  readonly actionsUsed: () => number;
  readonly guidanceExceeded: () => boolean;
  /** Read-once: the nudge to inject into the next turn after the indicative threshold. */
  readonly takePendingNudge: () => string | undefined;
  /** Pair the `actionStarted` an interrupt left open, so the journal never reads "still running". */
  readonly closeInterruptedAction: () => Effect.Effect<void>;
}

/** The browser tools count against the action guidance; `check` and `finish` are not browser tools. */
const browserTools = new Set<ToolName>([
  "observe",
  "navigate",
  "click",
  "fill",
  "press",
  "scroll",
  "screenshot",
]);

/** The shape every tool handler returns when the model asked for something it cannot have. */
const toolError = (
  code: ToolErrorCode,
  message: string,
  remedy: ToolErrorResult["remedy"],
): ToolErrorResult => ({
  error: true,
  code,
  message,
  remedy,
});

export const makeDispatcher = (options: {
  readonly attemptId: AttemptId;
  readonly store: RunStore["Service"];
  /** The runner's redacting, fire-and-forget emit. */
  readonly emitEvent: (event: HarnessEventInput) => Effect.Effect<void>;
  /** The runner's redacting journalling emit — dispatch needs the resulting `seq`. */
  readonly journalEvent: (event: HarnessEventInput) => Effect.Effect<HarnessEvent, StoreError>;
  readonly redactor: Redactor;
  readonly recorder: EvidenceRecorder;
  readonly operationTimeoutMs: number;
  readonly maxActions: number;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly screenshots: CaptureConfig["screenshots"];
  readonly criterionIds: ReadonlyArray<string>;
  readonly verifyCriterion: (
    session: BrowserSession,
    criterionId: string,
  ) => Effect.Effect<void, never, Crypto.Crypto>;
}): ToolDispatcher => {
  const {
    allowedOrigins,
    attemptId,
    criterionIds,
    emitEvent,
    journalEvent,
    maxActions,
    operationTimeoutMs,
    recorder,
    redactor,
    screenshots,
    store,
    verifyCriterion,
  } = options;

  let guidance = makeActionGuidance(maxActions);
  let currentObservation: ObserveResult | undefined;
  let navigationSettled = false;
  let finishRequested = false;
  /** One short nudge, injected into the next turn after the indicative threshold is crossed. */
  let pendingNudge: string | undefined;
  /**
   * The action whose `actionStarted` has been journalled and whose `actionFinished` has not.
   * A cancellation interrupts the action mid-flight, and an unpaired `actionStarted` would read
   * as "still running" forever in the journal and the live UI.
   */
  let inFlightAction: { readonly actionId: ActionId; readonly tool: ToolName } | undefined;

  const dispatch = (
    session: BrowserSession,
    call: { readonly id: string; readonly name: string; readonly params: unknown },
  ): Effect.Effect<DispatchResult, never, Crypto.Crypto> =>
    Effect.gen(function* () {
      const name = call.name as ToolName;
      if (!(name in toolParamSchemas)) {
        return {
          result: toolError(
            "invalid-params",
            `unknown tool "${call.name}"`,
            "choose-another-action",
          ),
          isError: true,
        };
      }
      const actionId = yield* store.mintActionId(attemptId);

      // The counter increments here, BEFORE policy validation: an observation, a screenshot,
      // a stale reference and a blocked navigation all count. `check` and `finish` are not
      // browser tools and never count. Nothing is ever refused because of this counter.
      if (browserTools.has(name)) {
        const step = recordAction(guidance);
        guidance = step.state;
        if (step.notice !== undefined) {
          yield* emitEvent({
            type: "actionGuidanceExceeded",
            attemptId,
            used: step.notice.used,
            guidance: step.notice.guidance,
            rendering: step.notice.rendering,
          });
          pendingNudge = step.notice.nudge;
        }
      }

      const decoded = yield* Schema.decodeUnknownEffect(
        toolParamSchemas[name],
        strictQuietParseOptions,
      )(call.params ?? {}).pipe(Effect.result);

      const intent =
        decoded._tag === "Success" && "intent" in decoded.success
          ? (decoded.success as { intent?: string }).intent
          : undefined;

      const started = yield* store
        .emit({
          type: "actionStarted",
          attemptId,
          actionId,
          tool: name,
          params: (typeof call.params === "object" && call.params !== null
            ? call.params
            : {}) as Record<string, unknown>,
          ...(intent === undefined ? {} : { intent }),
        })
        .pipe(Effect.result);
      /** The journal entry this action's evidence is linked back to (spec §10). */
      const actionSeq = started._tag === "Success" ? started.success.seq : undefined;
      inFlightAction = { actionId, tool: name };

      /**
       * spec.md §7: the tool RESULT is Schema-validated before it reaches the model. The driver
       * is another package behind the `BrowserSession` seam, so its return value is an untrusted
       * boundary; a payload that does not decode is a harness/driver contract violation, not a
       * modelling mistake, so it ends the run rather than being handed over as if it were fine.
       */
      const finishAction = (
        result: unknown,
        isError: boolean,
        code?: ToolErrorCode,
        message?: string,
      ) =>
        Effect.gen(function* () {
          let payload = result;
          let failed = isError;
          let outcomeCode = code;
          let outcomeMessage = message;
          let executionError: DispatchResult["executionError"];
          if (!isError) {
            const checked = yield* Schema.decodeUnknownEffect(
              toolResultSchemas[name],
              strictQuietParseOptions,
            )(result).pipe(Effect.result);
            if (checked._tag === "Failure") {
              const reason =
                `the \`${name}\` tool produced a result that does not match its declared ` +
                `schema: ${checked.failure.message}`;
              executionError = { stage: "browser", reason };
              yield* emitEvent({
                type: "error",
                attemptId,
                stage: "browser",
                reason,
                fatal: true,
              });
              const error = toolError("operation-failed", reason, "choose-another-action");
              payload = error;
              failed = true;
              outcomeCode = error.code;
              outcomeMessage = error.message;
            } else {
              payload = checked.success;
            }
          }
          inFlightAction = undefined;
          yield* emitEvent({
            type: "actionFinished",
            attemptId,
            actionId,
            tool: name,
            outcome: failed ? "error" : "ok",
            ...(outcomeCode === undefined ? {} : { code: outcomeCode }),
            ...(outcomeMessage === undefined ? {} : { message: outcomeMessage }),
          });
          // The after-action capture belongs to the action's own record: the journal order the
          // reader sees is `actionFinished` then `artifactAvailable`, on every path.
          if (screenshots === "every-action" && browserTools.has(name)) {
            yield* recorder.takeScreenshot(session, `after-${name}`);
          }
          return {
            result: payload,
            isError: failed,
            ...(executionError === undefined ? {} : { executionError }),
          };
        });

      if (decoded._tag === "Failure") {
        const error = toolError("invalid-params", decoded.failure.message, "choose-another-action");
        return yield* finishAction(error, true, error.code, error.message);
      }
      const params = decoded.success as Record<string, unknown>;

      const staleCheck = (observationId: unknown): ToolErrorResult | undefined => {
        if (observationId === undefined) return undefined;
        if (currentObservation === undefined) {
          return toolError("stale-observation", "no observation has been taken yet", "re-observe");
        }
        if (observationId !== currentObservation.observationId) {
          return toolError(
            "stale-observation",
            `observation ${String(observationId)} is no longer live (current: ${currentObservation.observationId})`,
            "re-observe",
          );
        }
        return undefined;
      };

      const refCheck = (ref: unknown): ToolErrorResult | undefined => {
        if (ref === undefined || currentObservation === undefined) return undefined;
        const matches = currentObservation.elements.filter((e) => e.ref === ref);
        if (matches.length === 0) {
          return toolError(
            "unknown-reference",
            `reference ${String(ref)} is not in the current observation`,
            "re-observe",
          );
        }
        if (matches.length > 1) {
          return toolError(
            "ambiguous-reference",
            `reference ${String(ref)} is ambiguous`,
            "re-observe",
          );
        }
        return undefined;
      };

      const operation = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: operationTimeoutMs,
            orElse: () => Effect.fail({ message: `${name} exceeded the per-operation timeout` }),
          }),
          Effect.result,
        );

      switch (name) {
        case "observe": {
          const observationId = yield* store.mintObservationId(attemptId);
          const observed = yield* operation(session.observe(observationId));
          if (observed._tag === "Failure") {
            const error = toolError(
              "operation-failed",
              observed.failure.message,
              "choose-another-action",
            );
            return yield* finishAction(error, true, error.code, error.message);
          }
          // Redact ONCE here: the same value is what the model sees, what is written next to the
          // attempt and what the verifier later reads as evidence.
          const observation = redactor.deep(observed.success);
          currentObservation = observation;
          const event = yield* journalEvent({
            type: "observationTaken",
            attemptId,
            observationId: observation.observationId,
            url: observation.url,
            title: observation.title,
            elementCount: observation.elements.length,
          }).pipe(Effect.result);
          yield* recorder.recordObservation(
            observation,
            event._tag === "Success" ? event.success.seq : 0,
          );
          return yield* finishAction(observation, false);
        }
        case "navigate": {
          const allowed = yield* checkNavigationOrigin(String(params["url"]), allowedOrigins).pipe(
            Effect.result,
          );
          if (allowed._tag === "Failure") {
            const error = toolError(
              "origin-not-allowed",
              allowed.failure.message,
              "choose-another-action",
            );
            return yield* finishAction(error, true, error.code, error.message);
          }
          const navigated = yield* operation(session.navigate({ url: allowed.success }));
          if (navigated._tag === "Failure") {
            const error = toolError(
              "operation-failed",
              navigated.failure.message,
              "choose-another-action",
            );
            return yield* finishAction(error, true, error.code, error.message);
          }
          currentObservation = undefined;
          navigationSettled = navigated.success.settled;
          return yield* finishAction(navigated.success, false);
        }
        case "click":
        case "fill": {
          const stale = staleCheck(params["observationId"]) ?? refCheck(params["ref"]);
          if (stale !== undefined)
            return yield* finishAction(stale, true, stale.code, stale.message);
          const acted = yield* operation(
            name === "click"
              ? session.click({
                  observationId: String(params["observationId"]),
                  ref: String(params["ref"]),
                })
              : session.fill({
                  observationId: String(params["observationId"]),
                  ref: String(params["ref"]),
                  value: String(params["value"]),
                }),
          );
          if (acted._tag === "Failure") {
            const error = toolError("operation-failed", acted.failure.message, "re-observe");
            return yield* finishAction(error, true, error.code, error.message);
          }
          if (acted.success.navigated) {
            currentObservation = undefined;
            // The driver reports no settling for an interaction-driven navigation, so the
            // absence rule must treat what follows as uncertain until the page is observed again.
            navigationSettled = false;
          }
          return yield* finishAction(acted.success, false);
        }
        case "press": {
          const stale =
            params["observationId"] === undefined
              ? undefined
              : (staleCheck(params["observationId"]) ?? refCheck(params["ref"]));
          if (stale !== undefined)
            return yield* finishAction(stale, true, stale.code, stale.message);
          const acted = yield* operation(
            session.press({
              ...(params["observationId"] === undefined
                ? {}
                : { observationId: String(params["observationId"]) }),
              ...(params["ref"] === undefined ? {} : { ref: String(params["ref"]) }),
              key: String(params["key"]),
            }),
          );
          if (acted._tag === "Failure") {
            const error = toolError("operation-failed", acted.failure.message, "re-observe");
            return yield* finishAction(error, true, error.code, error.message);
          }
          if (acted.success.navigated) {
            currentObservation = undefined;
            // The driver reports no settling for an interaction-driven navigation, so the
            // absence rule must treat what follows as uncertain until the page is observed again.
            navigationSettled = false;
          }
          return yield* finishAction(acted.success, false);
        }
        case "scroll": {
          const acted = yield* operation(
            session.scroll({
              direction: params["direction"] as "up" | "down",
              ...(params["amount"] === undefined ? {} : { amount: Number(params["amount"]) }),
            }),
          );
          if (acted._tag === "Failure") {
            const error = toolError(
              "operation-failed",
              acted.failure.message,
              "choose-another-action",
            );
            return yield* finishAction(error, true, error.code, error.message);
          }
          return yield* finishAction(acted.success, false);
        }
        case "screenshot": {
          const label = params["label"] === undefined ? "agent" : String(params["label"]);
          const shot = yield* recorder.takeScreenshot(session, label, {
            ...(params["fullPage"] === undefined ? {} : { fullPage: Boolean(params["fullPage"]) }),
            ...(actionSeq === undefined ? {} : { sourceSeq: actionSeq }),
          });
          if (shot.state !== "present") {
            const error = toolError(
              "operation-failed",
              shot.reason ?? "screenshot capture failed",
              "choose-another-action",
            );
            return yield* finishAction(error, true, error.code, error.message);
          }
          return yield* finishAction({ artifactId: shot.artifactId, label }, false);
        }
        case "check": {
          const criterionId = String(params["criterionId"]);
          if (!criterionIds.includes(criterionId)) {
            const error = toolError(
              "unknown-criterion",
              `${criterionId} is not a criterion of this contract (${criterionIds.join(", ")})`,
              "choose-another-action",
            );
            return yield* finishAction(error, true, error.code, error.message);
          }
          yield* verifyCriterion(session, criterionId);
          return yield* finishAction({ criterionId, accepted: true }, false);
        }
        case "finish": {
          finishRequested = true;
          return yield* finishAction(
            {
              accepted: true,
              note: "final verification will run; `finish` never decides the verdict",
            },
            false,
          );
        }
      }
    });

  return {
    dispatch,
    currentObservation: () => currentObservation,
    navigationSettled: () => navigationSettled,
    noteNavigationSettled: (settled) => {
      navigationSettled = settled;
    },
    finishRequested: () => finishRequested,
    actionsUsed: () => guidance.used,
    guidanceExceeded: () => guidance.used > guidance.guidance,
    takePendingNudge: () => {
      const nudge = pendingNudge;
      pendingNudge = undefined;
      return nudge;
    },
    closeInterruptedAction: () =>
      Effect.suspend(() => {
        const open = inFlightAction;
        if (open === undefined) return Effect.void;
        inFlightAction = undefined;
        return emitEvent({
          type: "actionFinished",
          attemptId,
          actionId: open.actionId,
          tool: open.tool,
          outcome: "error",
          code: "operation-failed",
          message: "the action was interrupted by a cancellation request",
        });
      }),
  };
};
