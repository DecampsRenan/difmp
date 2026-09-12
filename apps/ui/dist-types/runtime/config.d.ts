/**
 * Endpoints the CLI's SSE server exposes. Defaults are RELATIVE so the page works wherever the CLI
 * mounts `apps/ui/dist` (vite `base: "./"`). The CLI may override them by injecting
 * `globalThis.__DIFMP_UI__ = { ... }` in a script tag before the bundle.
 */
export interface UiRuntimeConfig {
    /** SSE stream of `HarnessEvent`s, `id:` = event `seq`. Must honour `Last-Event-ID`. */
    readonly eventsUrl: string;
    /** POST here to request cancellation. */
    readonly cancelUrl: string;
    /** GET the frozen `contract.json` (criterion text + method). */
    readonly contractUrl: string;
    /** Base for artifact paths recorded in `artifactAvailable.path` (relative to the run directory). */
    readonly artifactBaseUrl: string;
    /**
     * Token prices, if the operator configured any. ABSENT is the normal case and the UI then shows
     * "unavailable" rather than inventing a number.
     */
    readonly pricing?: {
        readonly currency: string;
        readonly inputPerMillionTokens: number;
        readonly outputPerMillionTokens: number;
    };
}
export declare const readRuntimeConfig: () => UiRuntimeConfig;
//# sourceMappingURL=config.d.ts.map