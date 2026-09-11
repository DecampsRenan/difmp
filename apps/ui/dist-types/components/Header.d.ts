import type { ConnectionState } from "../state/useRunStream.js";
import type { CancelState } from "../state/useRunStream.js";
import type { RunModel } from "../state/model.js";
export declare const Header: (props: {
    readonly model: RunModel;
    readonly connection: ConnectionState;
    readonly attempts: number;
    readonly cancel: CancelState;
    readonly onCancel: () => void;
    readonly onReconnect: () => void;
    readonly elapsedMs: number;
}) => import("react").JSX.Element;
//# sourceMappingURL=Header.d.ts.map