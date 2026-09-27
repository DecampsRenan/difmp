import { describe, expect, it } from "vitest";
import {
  collectSensitiveValues,
  isSensitiveKey,
  makeRedactor,
  recordingSecrets,
  REDACTED,
  sanitizeConfig,
} from "../src/index.js";
import type { ResolvedConfig } from "../src/index.js";

describe("redaction of known secrets", () => {
  it("is the identity when nothing is known, and never invents a redaction", () => {
    const redactor = makeRedactor([]);
    expect(redactor.active).toBe(false);
    expect(redactor.text("sk-live-1234")).toBe("sk-live-1234");
  });

  it("replaces every occurrence, at any depth, longest value first", () => {
    const redactor = makeRedactor(["sk-live-1234", "sk-live-1234-extended"]);
    expect(redactor.text("Authorization: Bearer sk-live-1234-extended!")).toBe(
      `Authorization: Bearer ${REDACTED}!`,
    );
    expect(redactor.deep({ a: ["x sk-live-1234 y"], b: { c: 3 } })).toEqual({
      a: [`x ${REDACTED} y`],
      b: { c: 3 },
    });
  });

  it("remembers what a fixture actually read, so the runner can strip exactly that", () => {
    const env: Record<string, string> = { SEED_TOKEN: "tok-abcdef", UNUSED: "not-read" };
    const recorder = recordingSecrets((name) => env[name]);
    expect(recorder.secrets("SEED_TOKEN")).toBe("tok-abcdef");
    expect(recorder.secrets("MISSING")).toBeUndefined();
    // Only what was read is known — nothing is guessed from the environment.
    expect(recorder.values()).toEqual(["tok-abcdef"]);
    expect(makeRedactor(recorder.values()).text("x-seed-token: tok-abcdef")).toBe(
      `x-seed-token: ${REDACTED}`,
    );
  });

  it("collects values parked under a sensitive key, and blanks them in the persisted config", () => {
    const config = {
      baseUrl: "http://127.0.0.1:3000",
      providerOptions: {
        apiKey: "sk-ant-secret",
        nested: { sessionId: "sid-999" },
        script: "healthy",
      },
    } as unknown as ResolvedConfig;
    expect([...collectSensitiveValues(config.providerOptions)].toSorted()).toEqual([
      "sid-999",
      "sk-ant-secret",
    ]);

    const safe = sanitizeConfig(
      config,
      makeRedactor(collectSensitiveValues(config.providerOptions)),
    );
    expect(safe.providerOptions).toEqual({
      apiKey: REDACTED,
      nested: { sessionId: REDACTED },
      script: "healthy",
    });
    expect(JSON.stringify(safe)).not.toContain("sk-ant-secret");
  });

  it("matches a key by WORD, so a token COUNT is not mistaken for a credential", () => {
    // A substring test blanked `maxTokens` and `verifierReserveTokens` in `manifest.json`, in the
    // `configResolved` event and therefore in the report — configuration hidden for nothing, while
    // no secret was protected by it.
    expect(isSensitiveKey("maxTokens")).toBe(false);
    expect(isSensitiveKey("verifierReserveTokens")).toBe(false);
    expect(isSensitiveKey("temperature")).toBe(false);
    expect(isSensitiveKey("script")).toBe(false);
    for (const key of [
      "token",
      "sessionToken",
      "apiKey",
      "api_key",
      "accessKey",
      "private_key",
      "sessionId",
      "Cookie",
      "AUTHORIZATION",
      "passphrase",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }

    const config = {
      baseUrl: "http://127.0.0.1:3000",
      providerOptions: { maxTokens: 2048, temperature: 0, sessionToken: "sk-live-1" },
    } as unknown as ResolvedConfig;
    const safe = sanitizeConfig(
      config,
      makeRedactor(collectSensitiveValues(config.providerOptions)),
    );
    expect(safe.providerOptions).toEqual({
      maxTokens: 2048,
      temperature: 0,
      sessionToken: REDACTED,
    });
  });
});
