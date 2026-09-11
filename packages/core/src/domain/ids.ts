import { Crypto, Effect, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"

export const RunId = Schema.String.check(Schema.isPattern(/^r_[a-z2-7]{13}$/)).annotate({ identifier: "RunId" })
export const AttemptId = Schema.String.check(Schema.isPattern(/^a[1-9][0-9]*$/)).annotate({ identifier: "AttemptId" })
export const ActionId = Schema.String.check(Schema.isPattern(/^act_[0-9]+$/)).annotate({ identifier: "ActionId" })
export const ObservationId = Schema.String.check(Schema.isPattern(/^obs_[0-9]+$/)).annotate({
  identifier: "ObservationId"
})
export const ArtifactId = Schema.String.check(Schema.isPattern(/^art_[0-9]+$/)).annotate({ identifier: "ArtifactId" })
export const CriterionId = Schema.String.check(Schema.isPattern(/^c[1-9][0-9]*$/)).annotate({
  identifier: "CriterionId"
})

export type RunId = typeof RunId["Type"]
export type AttemptId = typeof AttemptId["Type"]
export type ActionId = typeof ActionId["Type"]
export type ObservationId = typeof ObservationId["Type"]
export type ArtifactId = typeof ArtifactId["Type"]
export type CriterionId = typeof CriterionId["Type"]

/** RFC4648 lowercase alphabet: url-safe, safe in a file path and in a project name. */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"

export const toBase32 = (bytes: Uint8Array): string => {
  let bits = 0
  let acc = 0
  let out = ""
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31]
  return out
}

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

/** `r_<base32 of 8 random bytes>` — 15 chars, stable length, safe inside a path. */
export const makeRunId: Effect.Effect<RunId, PlatformError, Crypto.Crypto> = Effect.gen(function*() {
  const crypto = yield* Crypto.Crypto
  const bytes = yield* crypto.randomBytes(8)
  return `r_${toBase32(bytes)}`
})

export const attemptId = (n: number): AttemptId => `a${n}`
export const actionId = (seq: number): ActionId => `act_${seq}`
export const observationId = (seq: number): ObservationId => `obs_${seq}`
export const artifactId = (seq: number): ArtifactId => `art_${seq}`
export const criterionId = (n: number): CriterionId => `c${n}`
