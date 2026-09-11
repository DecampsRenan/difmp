/**
 * Resolve a journal-relative artifact path against the artifact base.
 * Returns `undefined` for anything that is absolute, escapes the base, or resolves to a
 * non-http(s) scheme.
 */
export declare const artifactHref: (base: string, path: string) => string | undefined;
/** For a URL that came from the page under test (observation url). Display-only; never an href. */
export declare const safeExternalHref: (raw: string) => string | undefined;
//# sourceMappingURL=urls.d.ts.map