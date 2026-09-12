import { describe, expect, it } from "vitest"
import {
  admitVerdict,
  classifyAbsence,
  collectSensitiveValues,
  enforceAbsenceRule,
  enforceEvidenceIntegrity,
  enforceEvidencePersistence,
  isSensitiveKey,
  makeRedactor,
  recordingSecrets,
  REDACTED,
  sanitizeConfig
} from "../src/index.js"
import type { CriterionResult, CriterionStatus, ResolvedConfig } from "../src/index.js"

const result = (status: CriterionStatus, overrides: Partial<CriterionResult> = {}): CriterionResult => ({
  criterionId: "c1",
  criterionHash: "hash",
  status,
  method: "model",
  evaluator: { kind: "scripted-model" },
  expected: "the project appears",
  observed: "observed",
  evidence: ["art_1"],
  evaluatedAtSeq: 7,
  ...overrides
})

describe("admitVerdict — asking again never upgrades a verdict", () => {
  it("records the first verdict as-is", () => {
    const admission = admitVerdict({ current: undefined, incoming: result("failed"), requestedBy: "agent" })
    expect(admission.applied).toBe(true)
    expect(admission.result.status).toBe("failed")
    expect(admission.result.reChecks).toBeUndefined()
  })

  it("keeps a `failed` when a later agent evaluation says `passed`, and keeps the later answer", () => {
    const admission = admitVerdict({
      current: result("failed", { observed: "absent" }),
      incoming: result("passed", { observed: "present", evaluatedAtSeq: 11 }),
      requestedBy: "agent"
    })
    expect(admission.applied).toBe(false)
    expect(admission.result.status).toBe("failed")
    expect(admission.result.observed).toBe("absent")
    expect(admission.result.reChecks).toEqual([{
      status: "passed",
      observed: "present",
      evidence: ["art_1"],
      requestedBy: "agent",
      evaluatedAtSeq: 11,
      applied: false,
      note: expect.stringContaining("never upgrades") as unknown as string
    }])
  })

  it("lets a later evaluation make a `passed` criterion worse", () => {
    const admission = admitVerdict({
      current: result("passed"),
      incoming: result("failed", { observed: "disparu" }),
      requestedBy: "agent"
    })
    expect(admission.applied).toBe(true)
    expect(admission.result.status).toBe("failed")
    expect(admission.result.reChecks).toHaveLength(1)
    expect(admission.result.reChecks![0]!.applied).toBe(true)
  })

  it("treats `inconclusive` and `error` as not decided: they can still be settled", () => {
    for (const status of ["inconclusive", "error"] as const) {
      const admission = admitVerdict({
        current: result(status),
        incoming: result("passed"),
        requestedBy: "agent"
      })
      expect(admission.applied).toBe(true)
      expect(admission.result.status).toBe("passed")
    }
  })

  it("accumulates several later evaluations instead of keeping only the last", () => {
    const first = admitVerdict({
      current: result("failed"),
      incoming: result("passed", { evaluatedAtSeq: 9 }),
      requestedBy: "agent"
    })
    const second = admitVerdict({
      current: first.result,
      incoming: result("passed", { evaluatedAtSeq: 12 }),
      requestedBy: "agent"
    })
    expect(second.result.status).toBe("failed")
    expect(second.result.reChecks!.map((r) => r.evaluatedAtSeq)).toEqual([9, 12])
  })
})

describe("enforceAbsenceRule — the harness decides the branch, not the evaluator", () => {
  const settled = { navigationSettled: true, checkpointReached: true }

  it("does nothing when the verdict is not about an absence", () => {
    const verdict = result("failed")
    expect(enforceAbsenceRule({ result: verdict, facts: { navigationSettled: false, checkpointReached: false } }))
      .toEqual(verdict)
  })

  it("downgrades a failure the evaluator itself calls uncertain", () => {
    const out = enforceAbsenceRule({
      result: result("failed", { absence: "uncertain-navigation" }),
      facts: settled
    })
    expect(out.status).toBe("inconclusive")
    expect(out.absence).toBe("uncertain-navigation")
    expect(out.downgrades![0]!.reason).toBe("absence-uncertain-navigation")
    expect(out.limitations).toContain("cannot establish a failure")
  })

  it("rejects a claimed checkpoint branch when the navigation never settled", () => {
    const out = enforceAbsenceRule({
      result: result("failed", { absence: "established-at-checkpoint" }),
      facts: { navigationSettled: false, checkpointReached: true }
    })
    expect(out.status).toBe("inconclusive")
    expect(out.absence).toBe("uncertain-navigation")
  })

  it("rejects it when the checkpoint the criterion names was never reached", () => {
    const out = enforceAbsenceRule({
      result: result("failed", { absence: "established-at-checkpoint" }),
      facts: { navigationSettled: true, checkpointReached: false }
    })
    expect(out.status).toBe("inconclusive")
  })

  it("keeps a failure established at the checkpoint, and records that branch", () => {
    const out = enforceAbsenceRule({
      result: result("failed", { absence: "established-at-checkpoint" }),
      facts: settled
    })
    expect(out.status).toBe("failed")
    expect(out.absence).toBe("established-at-checkpoint")
    expect(out.downgrades).toBeUndefined()
    expect(classifyAbsence(settled).branch).toBe("established-at-checkpoint")
  })

  it("never upgrades: a passed verdict that mentions an absence is left alone", () => {
    const out = enforceAbsenceRule({
      result: result("passed", { absence: "uncertain-navigation" }),
      facts: { navigationSettled: false, checkpointReached: false }
    })
    expect(out.status).toBe("passed")
  })
})

describe("evidence rules apply to every evaluator", () => {
  it("rejects invented references and says so in a downgrade", () => {
    const out = enforceEvidenceIntegrity({
      result: result("passed", { evidence: ["art_1", "art_404"] }),
      attemptArtifacts: new Set(["art_1"])
    })
    expect(out.status).toBe("inconclusive")
    expect(out.evidence).toEqual(["art_1"])
    expect(out.downgrades![0]).toMatchObject({ reason: "rejected-evidence", from: "passed", to: "inconclusive" })
  })

  it("refuses a `passed` with no evidence at all", () => {
    const out = enforceEvidenceIntegrity({ result: result("passed", { evidence: [] }), attemptArtifacts: new Set() })
    expect(out.status).toBe("inconclusive")
    expect(out.downgrades).toHaveLength(1)
  })

  it("leaves a well-supported verdict untouched", () => {
    const verdict = result("passed")
    expect(enforceEvidenceIntegrity({ result: verdict, attemptArtifacts: new Set(["art_1"]) })).toEqual(verdict)
  })

  it("forbids `passed` when mandatory evidence could not be persisted", () => {
    const out = enforceEvidencePersistence({
      result: result("passed"),
      failures: ["checkpoint capture for c1 (art_3): disk full"]
    })
    expect(out.status).toBe("inconclusive")
    expect(out.downgrades![0]!.reason).toBe("evidence-persistence-failed")
    expect(out.limitations).toContain("disk full")
  })

  it("does not rewrite a failure, but records the missing capture", () => {
    const out = enforceEvidencePersistence({ result: result("failed"), failures: ["art_3: disk full"] })
    expect(out.status).toBe("failed")
    expect(out.downgrades).toBeUndefined()
    expect(out.limitations).toContain("disk full")
  })
})

describe("redaction of known secrets", () => {
  it("is the identity when nothing is known, and never invents a redaction", () => {
    const redactor = makeRedactor([])
    expect(redactor.active).toBe(false)
    expect(redactor.text("sk-live-1234")).toBe("sk-live-1234")
  })

  it("replaces every occurrence, at any depth, longest value first", () => {
    const redactor = makeRedactor(["sk-live-1234", "sk-live-1234-extended"])
    expect(redactor.text("Authorization: Bearer sk-live-1234-extended!")).toBe(
      `Authorization: Bearer ${REDACTED}!`
    )
    expect(redactor.deep({ a: ["x sk-live-1234 y"], b: { c: 3 } })).toEqual({
      a: [`x ${REDACTED} y`],
      b: { c: 3 }
    })
  })

  it("remembers what a fixture actually read, so the runner can strip exactly that", () => {
    const env: Record<string, string> = { SEED_TOKEN: "tok-abcdef", UNUSED: "not-read" }
    const recorder = recordingSecrets((name) => env[name])
    expect(recorder.secrets("SEED_TOKEN")).toBe("tok-abcdef")
    expect(recorder.secrets("MISSING")).toBeUndefined()
    // Only what was read is known — nothing is guessed from the environment.
    expect(recorder.values()).toEqual(["tok-abcdef"])
    expect(makeRedactor(recorder.values()).text("x-seed-token: tok-abcdef")).toBe(`x-seed-token: ${REDACTED}`)
  })

  it("collects values parked under a sensitive key, and blanks them in the persisted config", () => {
    const config = {
      baseUrl: "http://127.0.0.1:3000",
      providerOptions: { apiKey: "sk-ant-secret", nested: { sessionId: "sid-999" }, script: "healthy" }
    } as unknown as ResolvedConfig
    expect([...collectSensitiveValues(config.providerOptions)].sort()).toEqual(["sid-999", "sk-ant-secret"])

    const safe = sanitizeConfig(config, makeRedactor(collectSensitiveValues(config.providerOptions)))
    expect(safe.providerOptions).toEqual({
      apiKey: REDACTED,
      nested: { sessionId: REDACTED },
      script: "healthy"
    })
    expect(JSON.stringify(safe)).not.toContain("sk-ant-secret")
  })

  it("matches a key by WORD, so a token COUNT is not mistaken for a credential", () => {
    // A substring test blanked `maxTokens` and `verifierReserveTokens` in `manifest.json`, in the
    // `configResolved` event and therefore in the report — configuration hidden for nothing, while
    // no secret was protected by it.
    expect(isSensitiveKey("maxTokens")).toBe(false)
    expect(isSensitiveKey("verifierReserveTokens")).toBe(false)
    expect(isSensitiveKey("temperature")).toBe(false)
    expect(isSensitiveKey("script")).toBe(false)
    for (
      const key of ["token", "sessionToken", "apiKey", "api_key", "accessKey", "private_key", "sessionId", "Cookie", "AUTHORIZATION", "passphrase"]
    ) {
      expect(isSensitiveKey(key), key).toBe(true)
    }

    const config = {
      baseUrl: "http://127.0.0.1:3000",
      providerOptions: { maxTokens: 2048, temperature: 0, sessionToken: "sk-live-1" }
    } as unknown as ResolvedConfig
    const safe = sanitizeConfig(config, makeRedactor(collectSensitiveValues(config.providerOptions)))
    expect(safe.providerOptions).toEqual({ maxTokens: 2048, temperature: 0, sessionToken: REDACTED })
  })
})
