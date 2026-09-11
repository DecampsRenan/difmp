import type { ContractView } from "../types/contract.js";
import type { HarnessEvent } from "../types/events.js";
import type { RunModel } from "./model.js";
export type RunAction = {
    readonly kind: "event";
    readonly event: HarnessEvent;
} | {
    readonly kind: "malformed";
} | {
    readonly kind: "contract";
    readonly contract: ContractView;
} | {
    readonly kind: "reset";
};
/**
 * Fold one journal event into the view model.
 *
 * DEDUPE CONTRACT: `seq` increases by exactly 1 per run (design-contracts §6) and SSE delivers in
 * order, so "apply iff `seq > lastSeq`" is both necessary and sufficient. A reconnect that replays
 * inclusively, or a server that re-sends a frame, is silently absorbed and counted in `duplicates`.
 */
export declare const runReducer: (model: RunModel, action: RunAction) => RunModel;
//# sourceMappingURL=reducer.d.ts.map