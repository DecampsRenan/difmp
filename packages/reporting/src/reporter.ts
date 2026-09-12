import type { ReportInput, ReportOutput, RunLayout } from "@difmp/core";
import { Reporter, ReporterError } from "@difmp/core";
import { Effect, FileSystem, Layer, Path } from "effect";
import { renderHtmlFromView } from "./html.js";
import { renderJsonReport } from "./json.js";
import { renderJUnitFromView } from "./junit.js";
import { buildReportView } from "./view.js";

export type FileReporterKind = "json" | "junit" | "html";

export const fileReporterKinds: ReadonlyArray<FileReporterKind> = ["json", "junit", "html"];

/** Where each output lands in the run directory of design-contracts §9. */
const targetOf = (layout: RunLayout, kind: FileReporterKind): string =>
  kind === "json" ? layout.result : kind === "junit" ? layout.junit : layout.report;

/** Everything is rebuilt from `input` alone — no model call, no replay, no config re-resolution. */
export const renderAll = (input: ReportInput): Record<FileReporterKind, string> => {
  const view = buildReportView(input);
  return {
    json: renderJsonReport(input),
    junit: renderJUnitFromView(view),
    html: renderHtmlFromView(view),
  };
};

const make = (kinds: ReadonlyArray<FileReporterKind>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const name = `file:${kinds.join("+")}`;
    let temps = 0;

    const fail = (reason: string) => new ReporterError({ reporter: name, reason });

    const writeAtomic = (target: string, content: string) =>
      Effect.gen(function* () {
        const temp = `${target}.tmp-report-${++temps}`;
        yield* fs
          .makeDirectory(path.dirname(target), { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              fail(`could not create ${path.dirname(target)}: ${cause.message}`),
            ),
          );
        yield* fs
          .writeFileString(temp, content)
          .pipe(Effect.mapError((cause) => fail(`could not write ${temp}: ${cause.message}`)));
        yield* fs
          .rename(temp, target)
          .pipe(Effect.mapError((cause) => fail(`could not replace ${target}: ${cause.message}`)));
      });

    const report = (
      input: ReportInput,
    ): Effect.Effect<ReadonlyArray<ReportOutput>, ReporterError> =>
      Effect.gen(function* () {
        const rendered = yield* Effect.try({
          try: () => renderAll(input),
          catch: (cause) =>
            fail(`rendering failed: ${cause instanceof Error ? cause.message : String(cause)}`),
        });
        const outputs: Array<ReportOutput> = [];
        for (const kind of kinds) {
          const target = targetOf(input.layout, kind);
          yield* writeAtomic(target, rendered[kind]);
          outputs.push({ kind, path: target });
        }
        return outputs;
      });

    return Reporter.of({ name, report });
  });

/**
 * One `Reporter` writing the requested files. `Reporter` is a single tag, so the CLI selects the
 * set of outputs here rather than composing several conflicting layers.
 */
export const fileReporterLayer = (
  kinds: ReadonlyArray<FileReporterKind> = fileReporterKinds,
): Layer.Layer<Reporter, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Reporter, make(kinds));

export const jsonReporterLayer: Layer.Layer<Reporter, never, FileSystem.FileSystem | Path.Path> =
  fileReporterLayer(["json"]);
export const junitReporterLayer: Layer.Layer<Reporter, never, FileSystem.FileSystem | Path.Path> =
  fileReporterLayer(["junit"]);
export const htmlReporterLayer: Layer.Layer<Reporter, never, FileSystem.FileSystem | Path.Path> =
  fileReporterLayer(["html"]);
