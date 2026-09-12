import type { Path } from "effect";

/** The run directory layout of design-contracts §9. */
export interface RunLayout {
  readonly root: string;
  readonly manifest: string;
  readonly spec: string;
  readonly contract: string;
  readonly events: string;
  readonly result: string;
  readonly report: string;
  readonly junit: string;
  readonly artifacts: string;
  readonly attemptDir: (attemptId: string) => string;
  readonly screenshotsDir: (attemptId: string) => string;
  readonly trace: (attemptId: string) => string;
  readonly video: (attemptId: string) => string;
  readonly consoleLog: (attemptId: string) => string;
  readonly networkLog: (attemptId: string) => string;
  /** Path relative to the run root — what goes into `artifacts.json` and the HTML report. */
  readonly relative: (absolutePath: string) => string;
}

export const makeRunLayout = (path: Path.Path, outputDir: string, runId: string): RunLayout => {
  const root = path.join(outputDir, runId);
  const attemptDir = (attemptId: string) => path.join(root, "attempts", attemptId);
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    spec: path.join(root, "spec.e2e.md"),
    contract: path.join(root, "contract.json"),
    events: path.join(root, "events.jsonl"),
    result: path.join(root, "result.json"),
    report: path.join(root, "report.html"),
    junit: path.join(root, "junit.xml"),
    artifacts: path.join(root, "artifacts.json"),
    attemptDir,
    screenshotsDir: (attemptId) => path.join(attemptDir(attemptId), "screenshots"),
    trace: (attemptId) => path.join(attemptDir(attemptId), "trace.zip"),
    video: (attemptId) => path.join(attemptDir(attemptId), "video.webm"),
    consoleLog: (attemptId) => path.join(attemptDir(attemptId), "console.jsonl"),
    networkLog: (attemptId) => path.join(attemptDir(attemptId), "network.jsonl"),
    relative: (absolutePath) => path.relative(root, absolutePath),
  };
};
