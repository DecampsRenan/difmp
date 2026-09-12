/**
 * Artifact paths come from the run journal, which is written from model- and page-influenced data.
 * React escapes text, but an `href`/`src` is an injection site of its own (`javascript:`, `data:`),
 * so every URL rendered by this app goes through here first.
 */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Resolve a journal-relative artifact path against the artifact base.
 * Returns `undefined` for anything that is absolute, escapes the base, or resolves to a
 * non-http(s) scheme.
 */
export const artifactHref = (base: string, path: string): string | undefined => {
  if (path.length === 0) return undefined;
  // Reject absolute paths, protocol-relative URLs, anything carrying a scheme, and traversal.
  if (path.startsWith("/") || path.startsWith("\\")) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return undefined;
  const segments = path.split(/[/\\]+/);
  if (segments.some((s) => s === ".." || s === ".")) return undefined;
  if (segments.some((s) => s.length === 0)) return undefined;

  let pageOrigin: URL;
  try {
    pageOrigin = new URL(globalThis.location?.href ?? "http://127.0.0.1/");
  } catch {
    return undefined;
  }
  try {
    const baseUrl = new URL(base, pageOrigin);
    const resolved = new URL(segments.map((s) => encodeURIComponent(s)).join("/"), baseUrl);
    if (!SAFE_PROTOCOLS.has(resolved.protocol)) return undefined;
    // Never let a computed artifact URL leave the base directory.
    if (!resolved.pathname.startsWith(baseUrl.pathname)) return undefined;
    return resolved.href;
  } catch {
    return undefined;
  }
};

/** For a URL that came from the page under test (observation url). Display-only; never an href. */
export const safeExternalHref = (raw: string): string | undefined => {
  try {
    const url = new URL(raw, globalThis.location?.href ?? "http://127.0.0.1/");
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
};
