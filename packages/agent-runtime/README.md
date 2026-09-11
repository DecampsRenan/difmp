# `@harness/agent-runtime`

The model seam: the two `ModelProvider` implementations, the prompts, and the `Verifier`.

## One provider implementation, two layers

Both providers are the same code. `makeLanguageModelProvider` implements the core-declared
`ModelProvider` on top of `LanguageModel` from `effect/unstable/ai`; only the `LanguageModel` layer
differs — `AnthropicLanguageModel` for the real adapter, a `LanguageModel.make({ generateText })`
double for the scripted one. Prompt plumbing, tool derivation, usage accounting and error mapping are
therefore shared, and a bug in one is a bug in both.

`effect/unstable/ai` ships inside `effect`, so `@harness/core` declaring the seam over it does not
make core depend on a model SDK.

**`disableToolCallResolution: true` on every `generateText`.** Tool handlers never run inside the
provider: tool calls come back to the harness in wire shape, and the harness increments the action
counter, validates the parameters against the Effect Schema that produced the JSON Schema, applies
the origin allow-list, journals the action, executes it and journals the result. A tool executed
inside the SDK would bypass all of that at once.

The Anthropic key is read as `Config.Redacted` from the environment. It never reaches the config, a
prompt, `manifest.json` or a report, and `providerOptions` is strictly decoded for that adapter so an
`apiKey` key is *rejected* rather than carried. Interrupting a generation aborts the in-flight HTTP
request (`withAbort` in `provider.ts`), so a cancelled run leaves nothing in flight.

## The scripted adapter

A deterministic, network-free double, so every reproducible test in this repository runs without an
API key. Its verdicts are labelled `evaluator.kind: "scripted-model"` and can never be confused with
a model judgement.

Without a registered script it runs a generic walkthrough steered by `providerOptions`
(`scenario`, `fills`, `submit`, `verdict` — which defaults to `inconclusive`, because evidence is
never assumed). A real walkthrough comes from the config's `scripts` registry, by name; see
[`examples/support`](../../examples/support/README.md) for worked ones.

**A scripted run tests the harness, not a model's ability to navigate.** `manifest.json` and the
report name the adapter.

## The `Verifier`

It evaluates one criterion from the collected evidence and returns a structured verdict, which the
harness then *polices*: unknown or unpersisted artifact ids are stripped and the criterion forced to
`inconclusive`; a `passed` with no accepted evidence is refused; the absence branch the evaluator
claims is re-derived by the runner from what the driver reported. The verifier may answer
`needsEvidence`, at most `budgets.maxEvidenceRequests` times per criterion.

`method: "code"` criteria are **not** evaluated here — the runner owns the only code-check path, so
the hash-binding guard, the evidence-integrity rule and the persistence rule apply identically to
`code` and `model`. A `code` criterion arriving here is refused explicitly rather than handled
twice.

```sh
pnpm --filter @harness/agent-runtime build
```
