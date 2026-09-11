import { Crypto, Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { toHex } from "./ids.js"

const encoder = new TextEncoder()

/** sha256 hex of a UTF-8 string. Full length in JSON, truncate only for display. */
export const sha256Hex = (text: string): Effect.Effect<string, PlatformError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    return toHex(yield* crypto.digest("SHA-256", encoder.encode(text)))
  })

/** Display form of a hash: first 16 hex chars. */
export const shortHash = (hash: string): string => hash.slice(0, 16)
