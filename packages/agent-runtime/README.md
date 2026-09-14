# `@difmp/agent-runtime`

The model seam: the two `ModelProvider` implementations, the prompts, and the `Verifier`.

## One provider implementation, shared LanguageModel layer

`anthropic` and `opencode-go` are the same code path: `makeLanguageModelProvider` on top of
`LanguageModel` from `effect/unstable/ai`. Only the client defaults differ — Anthropic's API vs
OpenCode Go's Messages gateway (`OPENCODE_API_KEY`, `https://opencode.ai/zen/go`, required
`x-opencode-session` + User-Agent). The scripted double uses a `LanguageModel.make({ generateText })`
stand-in. Prompt plumbing, tool derivation, usage accounting and error mapping are therefore shared.

`effect/unstable/ai` ships inside `effect`, so `@difmp/core` declaring the seam over it does not
make core depend on a model SDK.

**`disableToolCallResolution: true` on every `generateText`.** Tool handlers never run inside the
provider: tool calls come back to the harness in wire shape, and the harness increments the action
counter, validates the parameters against the Effect Schema that produced the JSON Schema, applies
the origin allow-list, journals the action, executes it and journals the result. A tool executed
inside the SDK would bypass all of that at once.

The Anthropic key is read as `Config.Redacted` from the environment. It never reaches the config, a
prompt, `manifest.json` or a report, and `providerOptions` is strictly decoded for that adapter so an
`apiKey` key is _rejected_ rather than carried. Interrupting a generation aborts the in-flight HTTP
request (`withAbort` in `provider.ts`), so a cancelled run leaves nothing in flight.

For `claude-sonnet-5` and dated ids in that family, `temperature`, `topP` and `topK` are rejected by
local provider preflight because the current Messages API requires those sampling controls to be
omitted. The recorded-transport suite exercises the production adapter without network access; the
separate scheduled/manual CI smoke is the only test lane that makes paid provider calls.

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
harness then _polices_: unknown or unpersisted artifact ids are stripped and the criterion forced to
`inconclusive`; a `passed` with no accepted evidence is refused; the absence branch the evaluator
claims is re-derived by the runner from what the driver reported. The verifier may answer
`needsEvidence`, at most `budgets.maxEvidenceRequests` times per criterion.

Screenshot evidence is genuinely multimodal: the verifier adds the PNG bytes as a native image
part immediately after a text marker naming its `artifactId`. A screenshot without non-empty image
bytes is omitted from both the prompt and the citable evidence allow-list; the model never gets
credit for inspecting a label. Bytes remain in memory for the evaluator call and are not copied into
the textual prompt, journal or JSON inventory.

`method: "code"` criteria are **not** evaluated here — the runner owns the only code-check path, so
the hash-binding guard, the evidence-integrity rule and the persistence rule apply identically to
`code` and `model`. A `code` criterion arriving here is refused explicitly rather than handled
twice.

```sh
pnpm --filter @difmp/agent-runtime build
```
