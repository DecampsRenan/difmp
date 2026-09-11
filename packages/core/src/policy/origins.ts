import { Effect } from "effect"
import { PolicyError } from "../domain/errors.js"

const allowedSchemes = new Set(["http:", "https:"])

/**
 * Tool-level navigation policy. This is NOT network isolation — a page can still fetch
 * anything the browser can reach; run in a controlled CI environment.
 */
export const checkNavigationOrigin = (
  url: string,
  allowedOrigins: ReadonlyArray<string>
): Effect.Effect<string, PolicyError> =>
  Effect.suspend(() => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return Effect.fail(
        new PolicyError({ rule: "allowed-origins", reason: `${JSON.stringify(url)} is not an absolute URL` })
      )
    }
    if (!allowedSchemes.has(parsed.protocol)) {
      return Effect.fail(
        new PolicyError({
          rule: "allowed-origins",
          reason: `scheme ${parsed.protocol} is not allowed`,
          detail: "only http: and https: can be navigated to"
        })
      )
    }
    if (!allowedOrigins.includes(parsed.origin)) {
      return Effect.fail(
        new PolicyError({
          rule: "allowed-origins",
          reason: `origin ${parsed.origin} is not in the allow-list`,
          detail: `allowed: ${allowedOrigins.join(", ")}`
        })
      )
    }
    return Effect.succeed(parsed.toString())
  })

export const isOriginAllowed = (url: string, allowedOrigins: ReadonlyArray<string>): boolean => {
  try {
    const parsed = new URL(url)
    return allowedSchemes.has(parsed.protocol) && allowedOrigins.includes(parsed.origin)
  } catch {
    return false
  }
}
