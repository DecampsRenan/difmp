import type { ReactNode } from "react";
export declare const Panel: (props: {
    readonly title: string;
    readonly testId: string;
    readonly note?: string;
    readonly aside?: ReactNode;
    readonly children: ReactNode;
}) => import("react").JSX.Element;
export declare const Badge: (props: {
    readonly tone: string;
    readonly children: ReactNode;
    readonly title?: string;
}) => import("react").JSX.Element;
/**
 * A consumed/limit gauge. `kind` drives the visual language and is NOT cosmetic: `blocking` bars are
 * the ones that can end a run, `indicative` bars never are (design-contracts §7).
 */
export declare const Gauge: (props: {
    readonly label: string;
    readonly used: number;
    readonly limit: number;
    readonly kind: "blocking" | "indicative";
    readonly exhausted?: boolean;
    readonly testId?: string;
    readonly footnote?: string;
    /** How a raw number is rendered. Defaults to a grouped integer. */
    readonly format?: (n: number) => string;
}) => import("react").JSX.Element;
export declare const Empty: (props: {
    readonly children: ReactNode;
}) => import("react").JSX.Element;
export declare const timeOf: (iso: string) => string;
export declare const durationOf: (ms: number) => string;
//# sourceMappingURL=ui.d.ts.map