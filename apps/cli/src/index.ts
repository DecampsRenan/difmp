/**
 * Public API of the `difmp` package, whose `bin` is `difmp`. A consumer writes:
 *
 * ```ts
 * import { defineConfig } from "@stylishedcoyote/difmp"
 * export default defineConfig({ baseUrl: "http://127.0.0.1:3000" })
 * ```
 */
export { defineConfig } from "@difmp/core";
export type {
  Budgets,
  CaptureConfig,
  Check,
  CheckContext,
  CheckCriterion,
  CheckResult,
  CookieLike,
  Criterion,
  CriterionResult,
  CriterionStatus,
  Evaluator,
  Fixture,
  FixtureContext,
  FixtureResult,
  HarnessConfigData,
  HarnessEvent,
  HarnessUserConfig,
  InputsRecord,
  InputValue,
  Manifest,
  OriginStateLike,
  ProviderName,
  ReporterName,
  ResolvedConfig,
  RunResult,
  RunStatus,
  ScenarioContract,
  StorageStateLike,
} from "@difmp/core";

export { cli, difmp, exitCodeOf, reportFailures, teardown } from "./cli.js";
export { harnessVersion } from "./version.js";
export { importConfigModule, findConfigUpwards, locateConfig } from "./loadConfig.js";
export { loadProject } from "./project.js";
export type { LoadedProject } from "./project.js";
export { selectSpecs, discoverPaths } from "./select.js";
export type { Selection, SelectOptions } from "./select.js";
export { loadReportInput } from "./reportInput.js";
export { makeRunBus } from "./server/bus.js";
export type { CurrentRun, RunBus, Subscription, UiMessage } from "./server/bus.js";
export {
  makeFrameEncoder,
  makeGapFillingEncoder,
  makeHarnessFrameEncoder,
  parseCursor,
  renderHarnessEvent,
  renderMessage,
} from "./server/sse.js";
export { openUiServer } from "./server/server.js";
