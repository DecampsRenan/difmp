import type { UiRuntimeConfig } from "../runtime/config.js";
import type { RunModel } from "../state/model.js";
export declare const BlockingBudgets: (props: {
    readonly model: RunModel;
    readonly pricing: UiRuntimeConfig["pricing"];
    readonly elapsedMs: number;
}) => import("react").JSX.Element;
/**
 * Deliberately a SEPARATE panel from the blocking budgets. `maxActions` never refuses an action and
 * never degrades a status (design-contracts §7); merging it into the budget gauges would read as a
 * limit, which it is not.
 */
export declare const ActionGuidance: (props: {
    readonly model: RunModel;
}) => import("react").JSX.Element;
//# sourceMappingURL=Budgets.d.ts.map