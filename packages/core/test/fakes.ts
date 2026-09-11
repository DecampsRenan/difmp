import { Effect, Layer } from "effect"
import type {
  BrowserSession,
  CaptureOutcome,
  CriterionResult,
  EvidenceItem,
  FixtureSession,
  ObserveResult,
  ProviderResponse,
  VerificationResponse
} from "../src/index.js"
import { BrowserDriver, FixtureManager, ModelProvider, Verifier } from "../src/index.js"

export interface ScriptedTurn {
  readonly text?: string
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly params: unknown }>
}

export interface FakeBrowserOptions {
  readonly elements?: ReadonlyArray<{ readonly ref: string; readonly role: string; readonly name: string }>
  readonly screenshotFails?: boolean
  /** `finalize` never returns — a trace that will not settle. Only a bound can end the run. */
  readonly finalizeHangs?: boolean
}

export const fakeBrowser = (options: FakeBrowserOptions = {}) => {
  const elements = options.elements ?? [{ ref: "e1", role: "button", name: "Créer" }]
  const captures: Array<CaptureOutcome> = []
  let url = "http://127.0.0.1:3000/"
  const session: BrowserSession = {
    observe: (observationId) =>
      Effect.succeed(
        {
          observationId,
          url,
          title: "Fixture app",
          snapshot: elements.map((e) => `- ${e.role} "${e.name}" [ref=${e.ref}]`).join("\n"),
          elements
        } satisfies ObserveResult
      ),
    navigate: ({ url: target }) =>
      Effect.sync(() => {
        url = target
        return { url: target, settled: true }
      }),
    click: () => Effect.succeed({ performed: true as const, navigated: false }),
    fill: () => Effect.succeed({ performed: true as const, navigated: false }),
    press: () => Effect.succeed({ performed: true as const, navigated: false }),
    scroll: () => Effect.succeed({ performed: true as const, navigated: false }),
    screenshot: ({ fileName, label }) =>
      Effect.sync(() => {
        const capture: CaptureOutcome = options.screenshotFails === true
          ? { kind: "screenshot", state: "failed", reason: "page closed before capture", ...(label === undefined ? {} : { label }) }
          : {
            kind: "screenshot",
            state: "present",
            path: `/tmp/${fileName}`,
            bytes: 128,
            ...(label === undefined ? {} : { label })
          }
        captures.push(capture)
        return capture
      }),
    currentUrl: Effect.sync(() => url),
    consoleEntries: Effect.succeed([]),
    networkEntries: Effect.succeed([]),
    finalize: () =>
      options.finalizeHangs === true
        ? Effect.never
        : Effect.succeed([{ kind: "trace", state: "present", path: "/tmp/trace.zip" } as CaptureOutcome])
  }
  return {
    captures,
    layer: Layer.succeed(BrowserDriver, BrowserDriver.of({ id: "fake", openContext: () => Effect.succeed(session) }))
  }
}

export const scriptedProvider = (turns: ReadonlyArray<ScriptedTurn>) => {
  let index = 0
  const generate = (): Effect.Effect<ProviderResponse, never> =>
    Effect.sync(() => {
      const turn = turns[index]
      index += 1
      if (turn === undefined) return { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
      return {
        ...(turn.text === undefined ? {} : { text: turn.text }),
        toolCalls: turn.toolCalls.map((call, i) => ({ id: `tc_${index}_${i}`, name: call.name, params: call.params })),
        usage: { inputTokens: 10, outputTokens: 5 }
      }
    })
  return Layer.succeed(
    ModelProvider,
    ModelProvider.of({ id: "scripted", modelId: "scripted-v1", generate })
  )
}

export interface ScriptedVerdict {
  readonly status: CriterionResult["status"]
  readonly observed?: string
  /** When false, the verifier answers with an evidence request instead of a verdict. */
  readonly verdict?: boolean
}

export const scriptedVerifier = (
  verdicts: Readonly<Record<string, ScriptedVerdict>> = {},
  fallback: ScriptedVerdict = { status: "passed" }
) =>
  Layer.succeed(
    Verifier,
    Verifier.of({
      id: "scripted-verifier",
      verify: (request) =>
        Effect.sync((): VerificationResponse => {
          const verdict = verdicts[request.criterion.id] ?? fallback
          if (verdict.verdict === false) {
            return {
              outcome: {
                _tag: "needsEvidence",
                criterionId: request.criterion.id,
                missing: ["post-reload observation"],
                hint: "reload the page and observe again"
              },
              usage: { inputTokens: 5, outputTokens: 2 }
            }
          }
          const evidence = request.evidence.map((e: EvidenceItem) => e.artifactId)
          return {
            outcome: {
              _tag: "verdict",
              result: {
                criterionId: request.criterion.id,
                criterionHash: request.criterionHash,
                status: verdict.status,
                method: "model",
                // The deterministic double is labelled so it is never read as a model judgement.
                evaluator: { kind: "scripted-model" },
                expected: request.criterion.text,
                observed: verdict.observed ?? "scripted observation",
                evidence,
                evaluatedAtSeq: request.seq
              }
            },
            usage: { inputTokens: 20, outputTokens: 10 }
          }
        })
    })
  )

export const fakeFixtures = (publicValues: Record<string, string> = { workspaceName: "Espace démo" }) => {
  const cleanups: Array<string> = []
  const layer = Layer.succeed(
    FixtureManager,
    FixtureManager.of({
      setup: (request) =>
        Effect.succeed(
          {
            fixtureName: request.fixtureName,
            publicValues,
            storageState: { cookies: [] },
            cleanup: () =>
              Effect.sync(() => {
                cleanups.push(request.fixtureName)
                return { cleanupsRun: 1, timedOut: false, errors: [] }
              })
          } satisfies FixtureSession
        )
    })
  )
  return { cleanups, layer }
}

/** A provider that DIES instead of failing — an SDK throwing where the seam declares a typed error. */
export const dyingProvider = (message: string): Layer.Layer<ModelProvider> =>
  Layer.succeed(
    ModelProvider,
    ModelProvider.of({
      id: "exploding",
      modelId: "exploding-v1",
      generate: () => Effect.die(new Error(message))
    })
  )
