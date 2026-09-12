import { afterEach, describe, expect, it } from "vitest";
import { readRuntimeConfig } from "../src/runtime/config.js";
import { artifactHref, safeExternalHref } from "../src/runtime/urls.js";
import { readContract } from "../src/types/contract.js";

const slot = globalThis as { __DIFMP_UI__?: unknown };

const inject = (value: unknown): void => {
  slot.__DIFMP_UI__ = value;
};

// The injected global is process-wide: leaving it behind would leak into every later test.
afterEach(() => {
  delete slot.__DIFMP_UI__;
});

const defaults = {
  eventsUrl: "events",
  cancelUrl: "cancel",
  contractUrl: "contract",
  artifactBaseUrl: "artifacts/",
};

const urlKeys = ["eventsUrl", "cancelUrl", "contractUrl", "artifactBaseUrl"] as const;

describe("readRuntimeConfig — nothing injected", () => {
  it("serves the relative defaults so the page works wherever the CLI mounts it", () => {
    expect(readRuntimeConfig()).toStrictEqual(defaults);
  });

  it.each([
    { label: "a string", value: "eventsUrl=/events" },
    { label: "a number", value: 42 },
    { label: "null", value: null },
    { label: "a boolean", value: true },
    { label: "an explicit undefined", value: undefined },
  ])("falls back to the defaults when the global is $label", ({ value }) => {
    inject(value);
    expect(readRuntimeConfig()).toStrictEqual(defaults);
  });
});

describe("readRuntimeConfig — endpoints", () => {
  it.each(urlKeys)("honours %s without disturbing the other three", (key) => {
    inject({ [key]: "/run/7/custom" });
    expect(readRuntimeConfig()).toStrictEqual({ ...defaults, [key]: "/run/7/custom" });
  });

  it("honours all four at once", () => {
    inject({
      eventsUrl: "/run/7/events",
      cancelUrl: "/run/7/cancel",
      contractUrl: "/run/7/contract.json",
      artifactBaseUrl: "/run/7/artifacts/",
    });
    expect(readRuntimeConfig()).toStrictEqual({
      eventsUrl: "/run/7/events",
      cancelUrl: "/run/7/cancel",
      contractUrl: "/run/7/contract.json",
      artifactBaseUrl: "/run/7/artifacts/",
    });
  });

  it.each(
    urlKeys.flatMap((key) =>
      [
        { label: "an empty string", value: "" },
        { label: "a number", value: 8080 },
        { label: "null", value: null },
        { label: "an explicit undefined", value: undefined },
      ].map((bad) => ({ key, ...bad })),
    ),
  )("keeps the default for $key when it is $label", ({ key, value }) => {
    inject({ [key]: value });
    expect(readRuntimeConfig()).toStrictEqual(defaults);
  });
});

describe("readRuntimeConfig — pricing", () => {
  it.each([
    { label: "no pricing key at all", pricing: undefined },
    { label: "pricing is null", pricing: null },
    { label: "pricing is a string", pricing: "3/15" },
    { label: "pricing is a number", pricing: 3 },
    { label: "the input rate is missing", pricing: { outputPerMillionTokens: 15 } },
    { label: "the output rate is missing", pricing: { inputPerMillionTokens: 3 } },
    {
      label: "a rate is a string",
      pricing: { inputPerMillionTokens: "3", outputPerMillionTokens: 15 },
    },
    {
      label: "a rate is NaN",
      pricing: { inputPerMillionTokens: Number.NaN, outputPerMillionTokens: 15 },
    },
    {
      label: "a rate is Infinity",
      pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: Number.POSITIVE_INFINITY },
    },
  ])("omits the pricing key when $label", ({ pricing }) => {
    inject({ pricing });
    const config = readRuntimeConfig();
    // Absent, not zeroed: the Budgets panel prints the literal "unavailable" when the key is
    // missing, and a zero rate would make it invent a cost of 0 instead.
    expect(config).not.toHaveProperty("pricing");
    expect(config).toStrictEqual(defaults);
  });

  it("carries both rates once they are finite numbers", () => {
    inject({ pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 } });
    expect(readRuntimeConfig().pricing).toStrictEqual({
      currency: "USD",
      inputPerMillionTokens: 3,
      outputPerMillionTokens: 15,
    });
  });

  it("keeps a zero rate, which is a price and not an absent one", () => {
    inject({ pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 } });
    expect(readRuntimeConfig().pricing?.inputPerMillionTokens).toBe(0);
  });

  it.each([
    { label: "absent", currency: undefined },
    { label: "a number", currency: 978 },
    { label: "null", currency: null },
    { label: "an empty string", currency: "" },
  ])("defaults the currency to USD when it is $label", ({ currency }) => {
    inject({ pricing: { currency, inputPerMillionTokens: 3, outputPerMillionTokens: 15 } });
    expect(readRuntimeConfig().pricing?.currency).toBe("USD");
  });

  it("honours a currency the operator configured", () => {
    inject({ pricing: { currency: "EUR", inputPerMillionTokens: 3, outputPerMillionTokens: 15 } });
    expect(readRuntimeConfig().pricing?.currency).toBe("EUR");
  });

  it("reads pricing independently of the endpoints", () => {
    inject({
      eventsUrl: "/run/7/events",
      pricing: { inputPerMillionTokens: 1.5, outputPerMillionTokens: 7.5 },
    });
    expect(readRuntimeConfig()).toStrictEqual({
      ...defaults,
      eventsUrl: "/run/7/events",
      pricing: { currency: "USD", inputPerMillionTokens: 1.5, outputPerMillionTokens: 7.5 },
    });
  });
});

// Relative bases resolve against the page's own URL; jsdom serves this suite from
// http://localhost:3000/. The assertions below derive the expected origin rather than spelling it
// out, except where a cross-origin base is the point of the case.
const pageOrigin = new URL(globalThis.location.href).origin;

/** Assert the URL was produced AND that it stayed under the base's pathname. */
const accepted = (base: string, path: string): URL => {
  const href = artifactHref(base, path);
  if (href === undefined) throw new Error(`artifactHref rejected ${JSON.stringify(path)}`);
  const resolved = new URL(href);
  const baseUrl = new URL(base, globalThis.location.href);
  expect(resolved.pathname.startsWith(baseUrl.pathname)).toBe(true);
  return resolved;
};

describe("artifactHref — rejections", () => {
  it.each([
    { label: "an empty path", path: "" },
    { label: "an absolute path", path: "/etc/passwd" },
    { label: "a backslash-absolute path", path: "\\windows\\system32\\config" },
    { label: "a protocol-relative URL", path: "//evil.example/x.png" },
    { label: "a javascript: URL", path: "javascript:alert(1)" },
    { label: "a mixed-case javascript: URL", path: "JaVaScRiPt:alert(1)" },
    { label: "a data: URL", path: "data:text/html;base64,PHNjcmlwdD4=" },
    { label: "a file: URL", path: "file:///etc/passwd" },
    { label: "a vbscript: URL", path: "vbscript:msgbox(1)" },
    { label: "an http: URL", path: "http://evil.example/x.png" },
    { label: "a bare parent segment", path: ".." },
    { label: "a bare current segment", path: "." },
    { label: "a traversal segment in the middle", path: "screenshots/../../etc/passwd" },
    { label: "a current-dir segment in the middle", path: "screenshots/./shot.png" },
    { label: "a backslash traversal", path: "screenshots\\..\\..\\etc\\passwd" },
    { label: "a trailing empty segment", path: "screenshots/" },
  ])("refuses $label", ({ path }) => {
    expect(artifactHref("artifacts/", path)).toBeUndefined();
  });
});

describe("artifactHref — accepted paths", () => {
  it("resolves a plain relative path under the base", () => {
    expect(accepted("artifacts/", "shot-1.png").href).toBe(`${pageOrigin}/artifacts/shot-1.png`);
  });

  it("resolves a nested path under the base", () => {
    expect(accepted("artifacts/", "screenshots/step-3/shot.png").href).toBe(
      `${pageOrigin}/artifacts/screenshots/step-3/shot.png`,
    );
  });

  it("percent-encodes each segment so a name cannot introduce a query or a fragment", () => {
    const url = accepted("artifacts/", "run notes/a&b#c?d é.txt");
    expect(url.href).toBe(`${pageOrigin}/artifacts/run%20notes/a%26b%23c%3Fd%20%C3%A9.txt`);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  // The separator split is greedy, so a doubled slash collapses instead of producing the empty
  // segment the guard below it looks for. The result is still a child of the base.
  it("collapses a doubled separator rather than refusing it", () => {
    expect(accepted("artifacts/", "screenshots//shot.png").href).toBe(
      `${pageOrigin}/artifacts/screenshots/shot.png`,
    );
  });

  it("keeps a percent sign in a name from being read as an escape", () => {
    expect(accepted("artifacts/", "100%25.png").href).toBe(`${pageOrigin}/artifacts/100%2525.png`);
  });

  it("follows a base the CLI mounted on another path", () => {
    expect(accepted("/runs/2026-09-12/artifacts/", "trace.zip").href).toBe(
      `${pageOrigin}/runs/2026-09-12/artifacts/trace.zip`,
    );
  });

  it("follows a base the CLI mounted on another origin", () => {
    expect(accepted("http://127.0.0.1:4173/out/artifacts/", "trace.zip").href).toBe(
      "http://127.0.0.1:4173/out/artifacts/trace.zip",
    );
  });

  it("addresses an artifact in a retained run without trusting the artifact path", () => {
    const href = artifactHref("/api/artifacts/", "screenshots/shot.png", "r_first");
    expect(href).toBe(`${pageOrigin}/api/artifacts/screenshots/shot.png?runId=r_first`);
  });
});

describe("artifactHref — the base itself", () => {
  // A base without a trailing slash is not a directory to the URL parser: the last segment is
  // replaced, the result lands outside the base pathname, and the guard drops it. The CLI's
  // default carries the slash for this reason.
  it("produces nothing for a base with no trailing slash", () => {
    expect(artifactHref("artifacts", "shot-1.png")).toBeUndefined();
  });

  it("produces nothing for a base that is itself a rejected scheme", () => {
    expect(artifactHref("javascript:void 0", "shot-1.png")).toBeUndefined();
  });
});

describe("safeExternalHref", () => {
  it.each([
    { label: "an https URL", raw: "https://example.com/checkout?step=2" },
    { label: "an http URL", raw: "http://127.0.0.1:4173/cart" },
  ])("passes $label through", ({ raw }) => {
    expect(safeExternalHref(raw)).toBe(raw);
  });

  it("normalises the scheme and host casing", () => {
    expect(safeExternalHref("HTTPS://Example.COM/A")).toBe("https://example.com/A");
  });

  it.each([
    { label: "javascript:", raw: "javascript:alert(document.cookie)" },
    { label: "mixed-case javascript:", raw: "JaVaScRiPt:alert(1)" },
    { label: "data:", raw: "data:text/html;base64,PHNjcmlwdD4=" },
    { label: "file:", raw: "file:///etc/passwd" },
    { label: "vbscript:", raw: "vbscript:msgbox(1)" },
    { label: "mailto:", raw: "mailto:someone@example.com" },
    { label: "blob:", raw: "blob:https://example.com/9f1a" },
  ])("refuses $label", ({ raw }) => {
    expect(safeExternalHref(raw)).toBeUndefined();
  });

  it.each([
    { label: "a scheme with no host", raw: "http://" },
    { label: "an unterminated IPv6 host", raw: "http://[" },
  ])("refuses $label rather than throwing", ({ raw }) => {
    expect(safeExternalHref(raw)).toBeUndefined();
  });

  // Display-only by contract, and it is resolution rather than validation: anything without a
  // scheme becomes a page-relative URL, so it never reaches the caller as a rejection.
  it("resolves a relative observation URL against the page", () => {
    expect(safeExternalHref("dashboard/orders")).toBe(`${pageOrigin}/dashboard/orders`);
  });

  it("turns a string that is not a URL at all into a page-relative one", () => {
    expect(safeExternalHref("not a url")).toBe(`${pageOrigin}/not%20a%20url`);
  });

  it("resolves a protocol-relative URL to the page's scheme and another host", () => {
    expect(safeExternalHref("//evil.example/x")).toBe("http://evil.example/x");
  });
});

describe("readContract — inputs that are not a contract", () => {
  it.each([
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "a string", value: '{"criteria":[]}' },
    { label: "a number", value: 7 },
    { label: "a boolean", value: false },
  ])("returns undefined for $label", ({ value }) => {
    expect(readContract(value)).toBeUndefined();
  });

  // An array is `typeof "object"`, so it survives the guard and degrades to an empty contract
  // rather than to `undefined`. Either way the view renders; this pins which of the two it gets.
  it("degrades an array to an empty contract rather than to undefined", () => {
    expect(readContract([])).toStrictEqual({ criteria: [] });
  });
});

describe("readContract — the criteria array", () => {
  it.each([
    { label: "the key is missing", value: {} },
    { label: "it is null", value: { criteria: null } },
    { label: "it is an object", value: { criteria: { a: 1 } } },
    { label: "it is a string", value: { criteria: "a, b" } },
  ])("yields an empty criteria array when $label", ({ value }) => {
    expect(readContract(value)).toStrictEqual({ criteria: [] });
  });

  it.each([
    { label: "the id is missing", entry: { text: "the cart shows one line" } },
    { label: "the text is missing", entry: { id: "c2" } },
    { label: "the id is not a string", entry: { id: 2, text: "the cart shows one line" } },
    { label: "the text is not a string", entry: { id: "c2", text: ["a"] } },
    { label: "the entry is null", entry: null },
    { label: "the entry is a string", entry: "c2" },
    { label: "the entry is a number", entry: 2 },
    { label: "the entry is undefined", entry: undefined },
  ])("skips the entry when $label, keeping its well-formed siblings", ({ entry }) => {
    const view = readContract({
      criteria: [
        { id: "c1", text: "first", method: "model" },
        entry,
        {
          id: "c3",
          text: "third",
          method: "code",
          checkName: "cartHasOneLine",
        },
      ],
    });
    expect(view?.criteria).toStrictEqual([
      { id: "c1", text: "first", method: "model" },
      { id: "c3", text: "third", method: "code", checkName: "cartHasOneLine" },
    ]);
  });
});

const firstCriterion = (entry: Record<string, unknown>) =>
  readContract({ criteria: [entry] })?.criteria[0];

describe("readContract — criterion fields", () => {
  it.each([
    { label: "absent", method: undefined },
    { label: "an unknown string", method: "manual" },
    { label: "the wrong case", method: "Model" },
    { label: "a number", method: 1 },
    { label: "null", method: null },
  ])("defaults the method to model when it is $label", ({ method }) => {
    expect(firstCriterion({ id: "c1", text: "first", method })?.method).toBe("model");
  });

  it.each(["model", "code"] as const)("keeps the %s method", (method) => {
    expect(firstCriterion({ id: "c1", text: "first", method })?.method).toBe(method);
  });

  it("carries a string checkName", () => {
    expect(
      firstCriterion({ id: "c1", text: "first", method: "code", checkName: "hasOneLine" }),
    ).toStrictEqual({ id: "c1", text: "first", method: "code", checkName: "hasOneLine" });
  });

  it.each([
    { label: "absent", checkName: undefined },
    { label: "a number", checkName: 3 },
    { label: "null", checkName: null },
    { label: "an object", checkName: { name: "hasOneLine" } },
  ])("omits checkName entirely when it is $label", ({ checkName }) => {
    // `exactOptionalPropertyTypes` is on: an explicit `checkName: undefined` is a different shape
    // from an absent key, so the key must not be there at all.
    expect(
      firstCriterion({ id: "c1", text: "first", method: "code", checkName }),
    ).not.toHaveProperty("checkName");
  });

  // `line` and `column` are declared on ContractCriterion but the reader never transcribes them,
  // so a contract that carries them loses them here.
  it("drops line and column even when the contract provides them", () => {
    expect(
      firstCriterion({ id: "c1", text: "first", method: "model", line: 12, column: 4 }),
    ).toStrictEqual({
      id: "c1",
      text: "first",
      method: "model",
    });
  });
});

describe("readContract — contract-level fields", () => {
  it("carries specPath, id, fixtureName and maxActions when correctly typed", () => {
    expect(
      readContract({
        specPath: "specs/checkout.e2e.md",
        id: "checkout",
        fixtureName: "seeded-cart",
        maxActions: 40,
        criteria: [],
      }),
    ).toStrictEqual({
      specPath: "specs/checkout.e2e.md",
      id: "checkout",
      fixtureName: "seeded-cart",
      maxActions: 40,
      criteria: [],
    });
  });

  it.each([
    { label: "specPath", value: { specPath: 12 } },
    { label: "id", value: { id: ["checkout"] } },
    { label: "fixtureName", value: { fixtureName: null } },
    { label: "maxActions", value: { maxActions: "40" } },
    { label: "tags", value: { tags: "smoke" } },
  ])("omits $label when it is the wrong type", ({ label, value }) => {
    expect(readContract(value)).not.toHaveProperty(label);
  });

  it("keeps only the string entries of tags", () => {
    expect(readContract({ tags: ["smoke", 3, null, "checkout", { a: 1 }] })?.tags).toStrictEqual([
      "smoke",
      "checkout",
    ]);
  });

  it("keeps an empty tags array, which is not the same as an absent one", () => {
    expect(readContract({ tags: [] })).toStrictEqual({ criteria: [], tags: [] });
  });

  // Unlike the pricing rates in readRuntimeConfig, maxActions gets no finiteness check.
  it("carries a non-finite maxActions through unchecked", () => {
    expect(readContract({ maxActions: Number.NaN })?.maxActions).toBeNaN();
  });

  // `inputs` is declared on ContractView but the reader never populates it.
  it("never carries inputs, even when the contract supplies them", () => {
    expect(readContract({ inputs: { email: "a@b.test" }, criteria: [] })).not.toHaveProperty(
      "inputs",
    );
  });
});
