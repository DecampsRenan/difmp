import type { UiRuntimeConfig } from "../runtime/config.js";
import type { RunModel } from "./model.js";
export type ConnectionState = 
/** No stream open yet. */
"connecting"
/** Open and receiving. */
 | "live"
/** The link dropped; a resume with the cursor is pending. */
 | "reconnecting"
/** The run is over — we closed the stream on purpose. */
 | "closed"
/** We gave up retrying. The user can resume manually. */
 | "unavailable";
export interface CancelState {
    readonly pending: boolean;
    readonly requested: boolean;
    readonly error?: string;
}
export interface RunStream {
    readonly model: RunModel;
    readonly connection: ConnectionState;
    readonly attempts: number;
    readonly cancel: CancelState;
    readonly requestCancel: () => void;
    readonly reconnectNow: () => void;
}
export declare const useRunStream: (config: UiRuntimeConfig) => RunStream;
/** A 1 s tick, live only while the run is running, so elapsed-time gauges stay honest. */
export declare const useNow: (active: boolean) => number;
//# sourceMappingURL=useRunStream.d.ts.map