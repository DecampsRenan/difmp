import { BrowserError } from "@harness/core"
import { errors as playwrightErrors } from "playwright"

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

/** Playwright error messages embed ANSI escapes around the call log. Never feed those to a model. */
export const stripAnsi = (value: string): string => value.replace(ANSI_RE, "")

const MAX_REASON = 1200

export const describeCause = (cause: unknown): string => {
  const raw = cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : typeof cause === "string"
    ? cause
    : JSON.stringify(cause)
  const clean = stripAnsi(raw ?? "unknown error").trim()
  return clean.length > MAX_REASON ? `${clean.slice(0, MAX_REASON)}…` : clean
}

export type ErrorKind = BrowserError["kind"]

/**
 * `errors` exports only `TimeoutError`; a strict-mode violation is a plain error identified by its
 * message, and its runtime constructor name is minified — never branch on `constructor.name`.
 */
export const classify = (cause: unknown): ErrorKind => {
  if (cause instanceof playwrightErrors.TimeoutError) return "timeout"
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.includes("strict mode violation")) return "stale-reference"
  if (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("has been closed")
  ) {
    return "closed"
  }
  if (message.includes("net::") || message.includes("page.goto")) return "navigation"
  return "other"
}

export const browserError = (operation: string, kind: ErrorKind, reason: string): BrowserError =>
  new BrowserError({ operation, kind, reason })

export const fromCause = (operation: string, cause: unknown, kind?: ErrorKind): BrowserError =>
  new BrowserError({ operation, kind: kind ?? classify(cause), reason: describeCause(cause) })
