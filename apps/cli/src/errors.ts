import { Runtime, Schema } from "effect";

/**
 * Exit codes (design-contracts §12, spec §12):
 * `0` every selected scenario passed · `1` any `failed` or `inconclusive` ·
 * `2` invalid configuration or execution error · `130` user interrupt.
 *
 * `Runtime.errorExitCode` is the marker `Runtime.defaultTeardown` reads; `errorReported` stops
 * the runtime from logging the cause a second time on top of our own rendered message.
 */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
  /** The command already emitted the complete diagnostic (for example a JSON document). */
  reported: Schema.optionalKey(Schema.Boolean),
}) {
  override readonly [Runtime.errorExitCode] = 2;
  override readonly [Runtime.errorReported] = false;
}

/** An execution error: the harness itself could not complete the work. Exit 2. */
export class ExecutionError extends Schema.TaggedError<ExecutionError>()("ExecutionError", {
  message: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 2;
  override readonly [Runtime.errorReported] = false;
}

/** A product verdict: at least one scenario is `failed` or `inconclusive`. Exit 1. */
export class ScenariosNotPassing extends Schema.TaggedError<ScenariosNotPassing>()(
  "ScenariosNotPassing",
  {
    failed: Schema.Int,
    inconclusive: Schema.Int,
  },
) {
  override readonly [Runtime.errorExitCode] = 1;
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `${this.failed} failed, ${this.inconclusive} inconclusive`;
  }
}

/**
 * The run was cancelled on purpose — Ctrl-C, or the dashboard's cancel command. A SIGINT that
 * reaches the runtime already yields 130 through the interrupt branch of the teardown; this error
 * carries the same code for a cancellation that came in over HTTP.
 */
export class Cancelled extends Schema.TaggedError<Cancelled>()("Cancelled", {
  reason: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 130;
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `cancelled: ${this.reason}`;
  }
}

export type CliError = UsageError | ExecutionError | ScenariosNotPassing | Cancelled;
