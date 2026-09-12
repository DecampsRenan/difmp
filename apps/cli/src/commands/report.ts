import { Console, Effect, FileSystem, Path } from "effect";
import type { ExecutionError } from "../errors.js";
import { loadReportInput } from "../reportInput.js";
import { renderRunLines, writeReportFiles } from "../reporters.js";

/**
 * `difmp report <run-directory>` rebuilds `report.html` (and `result.json` / `junit.xml`) from
 * the PERSISTED data alone: no model call, no browser, no replay, and no configuration
 * re-resolution — `manifest.json` is the sole source of "which adapter was used".
 */
export const reportHandler = (options: {
  readonly directory: string;
}): Effect.Effect<void, ExecutionError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const input = yield* loadReportInput(options.directory);
    const outputs = yield* writeReportFiles(input);
    for (const line of renderRunLines({ result: input.result, report: input }))
      yield* Console.log(line);
    for (const output of outputs) {
      if (output.path !== undefined) yield* Console.log(`  ${output.kind.padEnd(6)}${output.path}`);
    }
    if (!input.finalized) {
      yield* Console.error(
        "  ! this run was not finalised — the journal ends on a truncated line, so the report is what survived",
      );
    }
  });
