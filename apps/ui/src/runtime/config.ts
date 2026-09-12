/**
 * Endpoints the CLI's SSE server exposes. Defaults are RELATIVE so the page works wherever the CLI
 * mounts `apps/ui/dist` (vite `base: "./"`). The CLI may override them by injecting
 * `globalThis.__DIFMP_UI__ = { ... }` in a script tag before the bundle.
 */
export interface UiRuntimeConfig {
  /** SSE stream of `HarnessEvent`s, `id:` = event `seq`. Must honour `Last-Event-ID`. */
  readonly eventsUrl: string
  /** POST here to request cancellation. */
  readonly cancelUrl: string
  /** GET the frozen `contract.json` (criterion text + method). */
  readonly contractUrl: string
  /** Base for artifact paths recorded in `artifactAvailable.path` (relative to the run directory). */
  readonly artifactBaseUrl: string
  /**
   * Token prices, if the operator configured any. ABSENT is the normal case and the UI then shows
   * "unavailable" rather than inventing a number.
   */
  readonly pricing?: {
    readonly currency: string
    readonly inputPerMillionTokens: number
    readonly outputPerMillionTokens: number
  }
}

const defaults: UiRuntimeConfig = {
  eventsUrl: "events",
  cancelUrl: "cancel",
  contractUrl: "contract",
  artifactBaseUrl: "artifacts/"
}

const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.length > 0 ? v : fallback)

const readPricing = (v: unknown): UiRuntimeConfig["pricing"] => {
  if (typeof v !== "object" || v === null) return undefined
  const p = v as Record<string, unknown>
  const input = p["inputPerMillionTokens"]
  const output = p["outputPerMillionTokens"]
  if (typeof input !== "number" || typeof output !== "number") return undefined
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined
  return {
    currency: str(p["currency"], "USD"),
    inputPerMillionTokens: input,
    outputPerMillionTokens: output
  }
}

export const readRuntimeConfig = (): UiRuntimeConfig => {
  const injected = (globalThis as { __DIFMP_UI__?: unknown }).__DIFMP_UI__
  if (typeof injected !== "object" || injected === null) return defaults
  const raw = injected as Record<string, unknown>
  const pricing = readPricing(raw["pricing"])
  const base: UiRuntimeConfig = {
    eventsUrl: str(raw["eventsUrl"], defaults.eventsUrl),
    cancelUrl: str(raw["cancelUrl"], defaults.cancelUrl),
    contractUrl: str(raw["contractUrl"], defaults.contractUrl),
    artifactBaseUrl: str(raw["artifactBaseUrl"], defaults.artifactBaseUrl)
  }
  return pricing === undefined ? base : { ...base, pricing }
}
