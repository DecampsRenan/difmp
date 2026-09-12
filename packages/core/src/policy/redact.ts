import type { ResolvedConfig } from "../domain/config.js";

/** What replaces a redacted value everywhere it is found. */
export const REDACTED = "[redacted]";

/**
 * Key names whose VALUE is never safe to persist or to show a model. `providerOptions` is an open
 * record (`Record<string, unknown>`), so a project can park anything in it; design-contracts §3/§9
 * promise that what reaches `manifest.json` and the journal is "resolved NON-SENSITIVE config",
 * and this is what enforces that promise instead of trusting the project.
 */
const secretWords: ReadonlySet<string> = new Set([
  "key",
  "keys",
  "apikey",
  "token",
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "cookies",
  "session",
]);

/** `apiKeyEnvVar` -> ["api","key","env","var"]; `api_key` -> ["api","key"]. */
const words = (key: string): ReadonlyArray<string> =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());

/**
 * Matching is per WORD, not per substring. A substring test blanked `maxTokens` and
 * `verifierReserveTokens` — plural, a count of units, never a credential — which hid ordinary
 * configuration from `manifest.json` and from the report while protecting nothing. `token`,
 * `sessionToken`, `apiKey`, `api_key`, `accessKey`, `privateKey` and `sessionId` still redact.
 */
export const isSensitiveKey = (key: string): boolean =>
  words(key).some((word) => secretWords.has(word));

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface Redactor {
  /** Replace every known secret value inside a string. Identity when nothing is registered. */
  readonly text: (value: string) => string;
  /** Walk a JSON-shaped value and redact every string inside it. */
  readonly deep: <A>(value: A) => A;
  /** True when at least one secret value is known — lets callers skip the walk entirely. */
  readonly active: boolean;
}

const identity: Redactor = { text: (value) => value, deep: (value) => value, active: false };

/**
 * A redactor over KNOWN secret values. design-contracts §13 requires that known secrets are
 * stripped from textual logs and prompts; that can only be done against values the harness was
 * actually told about (what a fixture read through `ctx.secrets`, plus anything sitting under a
 * sensitive key in the resolved config), so this never pretends to find unknown secrets. Traces,
 * videos and DOM dumps are explicitly out of reach — documented as a limitation, not papered over.
 */
export const makeRedactor = (values: Iterable<string>): Redactor => {
  const secrets = [...new Set(values)]
    .filter((value) => typeof value === "string" && value.trim().length >= 4)
    .toSorted((a, b) => b.length - a.length);
  if (secrets.length === 0) return identity;

  const pattern = new RegExp(secrets.map(escapeRegExp).join("|"), "g");
  const text = (value: string): string => {
    pattern.lastIndex = 0;
    return value.replace(pattern, REDACTED);
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>))
        out[key] = walk(item);
      return out;
    }
    return value;
  };

  return { text, deep: <A>(value: A): A => walk(value) as A, active: true };
};

/**
 * Wrap a secret accessor (typically `(name) => process.env[name]`) so that every value a fixture
 * actually reads is remembered. A `FixtureManager` implementation passes `read` to the fixture as
 * `ctx.secrets` and reports `values()` back on `FixtureSession.secretValues`; the runner then knows
 * exactly what to strip from prompts, journal and report. Values are collected, never logged.
 */
export const recordingSecrets = (
  read: (name: string) => string | undefined,
): {
  readonly secrets: (name: string) => string | undefined;
  readonly values: () => ReadonlyArray<string>;
} => {
  const seen = new Set<string>();
  return {
    secrets: (name) => {
      const value = read(name);
      if (typeof value === "string" && value.length > 0) seen.add(value);
      return value;
    },
    values: () => [...seen],
  };
};

/** Every string value parked under a sensitive key, at any depth — the config's own secrets. */
export const collectSensitiveValues = (
  value: unknown,
  out: Array<string> = [],
): ReadonlyArray<string> => {
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveValues(item, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key) && typeof item === "string" && item.length > 0) out.push(item);
      else collectSensitiveValues(item, out);
    }
  }
  return out;
};

const sanitizeUnknown = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : sanitizeUnknown(item);
    }
    return out;
  }
  return value;
};

/**
 * The configuration as it may be written to `manifest.json` and to the `configResolved` event:
 * anything under a sensitive key inside the open `providerOptions` record is replaced by
 * `[redacted]`, and every known secret value is stripped from what remains.
 *
 * Keys are NOT dropped — a reader still sees that an option was set, only never its value.
 */
export const sanitizeConfig = (
  config: ResolvedConfig,
  redactor: Redactor = identity,
): ResolvedConfig => {
  const providerOptions = sanitizeUnknown(config.providerOptions) as Record<string, unknown>;
  return redactor.deep({ ...config, providerOptions });
};
