# Effect v4 AI + Anthropic — implementation cheat-sheet

Versions read from disk: `effect@4.0.0-rc.113`, `@effect/ai-anthropic@4.0.0-rc.113`.
Sources: `node_modules/effect/src/unstable/ai/*.ts`, `node_modules/effect/ai-docs/src/71_ai/*.ts`,
`node_modules/@effect/ai-anthropic/src/*.ts`.

All snippets below were compiled with:
`npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck .recon/<f>.ts`
Files: `.recon/ai.ts` (full loop + verifier), `.recon/ai-probe2.ts`, `.recon/ai-probe3.ts`,
`.recon/ai-wiring.ts`, `.recon/ai-runtime.ts`, `.recon/ai-runtime2.ts` (last two also **executed** under `tsx`
against a fake LanguageModel — no network).
`ai-probe2.ts` / `ai-probe3.ts` are deliberate _type-reveal_ files: they assign to a bogus string literal so
`tsc` prints the inferred type. Their errors are expected output, not failures; `ai.ts`, `ai-wiring.ts`,
`ai-runtime.ts`, `ai-runtime2.ts` compile clean.

---

## 0. Repo gotcha — STALE, corrected by the critic pass

The broken-symlink situation is **fixed**: the root `package.json` now declares `effect`,
`@effect/platform-node` and `@effect/ai-anthropic`, and all of them resolve normally. Nothing needs
relinking. (If `pnpm install` ever produces two `vitest` copies again, see api-tooling.md §1.5.)

## 1. Imports

```ts
import {
  AiError,
  Chat,
  LanguageModel,
  Model,
  Prompt,
  Response,
  Tool,
  Toolkit,
} from "effect/unstable/ai";
import {
  AnthropicClient,
  AnthropicConfig,
  AnthropicLanguageModel,
  AnthropicTool,
} from "@effect/ai-anthropic";
import { FetchHttpClient } from "effect/unstable/http"; // or:
import { NodeHttpClient } from "@effect/platform-node"; // NodeHttpClient.layerUndici
```

`effect/unstable/ai` is a real subpath export. Sub-module deep imports also work
(`effect/unstable/ai/AnthropicStructuredOutput`).

## 2. LanguageModel

Service tag `LanguageModel.LanguageModel` (`Context.Service`). Module-level helpers
`LanguageModel.generateText / generateObject / streamText` add `LanguageModel` to `R`; the same three exist as
methods on the service value (no `LanguageModel` in `R`).

### Options (`GenerateTextOptions<Tools>`)

```ts
{
  prompt: Prompt.RawInput                  // string | Iterable<MessageEncoded> | Prompt
  toolkit?: Toolkit | Toolkit.WithHandler | Effect<Toolkit.WithHandler>
  toolChoice?: "auto" | "none" | "required" | { tool: Name } | { mode?: "auto"|"required"; oneOf: Name[] }
  concurrency?: Concurrency                // tool-call resolution concurrency
  disableToolCallResolution?: boolean
}
```

**There is NO `system` option.** The system prompt is a message inside the `Prompt`
(`{ role: "system", content: "..." }`, or `Prompt.setSystem/prependSystem/appendSystem`).
There is no `maxTokens`/`temperature`/`stopSequences` here either — those are **provider** config
(`AnthropicLanguageModel.Config`, see §7). The options object is checked with `NoExcessProperties`, so a typo'd
key is a compile error.

`generateObject` adds `{ schema: Schema.Top; objectName?: string }`.

### Return shape

```ts
class GenerateTextResponse<Tools, ParametersMode = "decoded"> {
  content: Array<Response.Part<Tools, ParametersMode>>;
  get text(): string; // all "text" parts joined
  get reasoning(): Array<Response.ReasoningPart>;
  get reasoningText(): string | undefined;
  get toolCalls(): Array<Response.ToolCallParts<Tools, ParametersMode>>;
  get toolResults(): Array<Response.ToolResultParts<Tools>>;
  get finishReason(): Response.FinishReason; // "unknown" when there is no finish part
  get usage(): Response.Usage; // all fields undefined when there is no finish part
}
class GenerateObjectResponse<Tools, A, ParametersMode> extends GenerateTextResponse {
  readonly value: A;
}
```

`FinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "pause" | "other" | "unknown"`.

`streamText` returns `Stream.Stream<Response.StreamPart<Tools, Mode>, ...>` — deltas
(`text-start/text-delta/text-end`, `reasoning-*`, `tool-params-start/delta/end`), then `tool-call`,
`tool-result`, `response-metadata`, `finish`, `error`. Note `StreamPart` has **no** `"text"` or `"reasoning"`
aggregate part; `GenerateTextResponse.content` (`Response.Part`) has no `*-delta` parts.

### Usage / tokens

```ts
class Response.Usage {
  inputTokens:  { uncached?: number; total?: number; cacheRead?: number; cacheWrite?: number }
  outputTokens: { total?: number; text?: number; reasoning?: number }
}
```

Every field is `Schema.optional(Schema.Int)` → `number | undefined`. Anthropic fills
`inputTokens.uncached = input_tokens`, `inputTokens.total = input + cache_creation + cache_read`,
`cacheRead`, `cacheWrite`, `outputTokens.total`; it leaves `outputTokens.text` and
`outputTokens.reasoning` `undefined`. Anything extra is under the finish part's
`metadata.anthropic` (`container`, `requestId`, …).

## 3. Tools — intercepting calls instead of executing them

`disableToolCallResolution: true` is the option you want. Verified consequences (type-level and at runtime):

|                        | resolution on (default)                 | `disableToolCallResolution: true`            |
| ---------------------- | --------------------------------------- | -------------------------------------------- |
| tool handlers          | run inside `generateText`               | **never run**                                |
| `R` from the toolkit   | `Tool.Handler<"name"> \| …` required    | **nothing** — only `LanguageModel`           |
| `E`                    | `AiError \| Tool.HandlerError<…>`       | **`AiError` only**                           |
| `call.params`          | `unknown` (`ParametersMode = "opaque"`) | `Tool.ParametersEncoded<Tool>` (`"encoded"`) |
| `response.toolResults` | populated                               | empty                                        |

Key point: you may pass the bare `Toolkit` (which is itself `Effect<WithHandler, never, HandlersFor<Tools>>`)
**without ever building a handler layer**. `Toolkit`'s `evaluate` only reads handler services lazily inside
`handle()`, which is never called when resolution is disabled — verified by running it with no handler layer
provided (`.recon/ai-runtime.ts`).

`params` are encoded, i.e. the _wire_ shape (`Schema.DateTimeUtcFromString` → `string`), not decoded.
Validate them yourself with `Schema.decodeUnknownEffect(ParamsSchema)`.

```ts
const ClickParams = Schema.Struct({
  selector: Schema.String,
  timeoutMs: Schema.optional(Schema.Int),
});

const Click = Tool.make("browser_click", {
  description: "Click an element",
  parameters: ClickParams, // default: Tool.EmptyParams (Record<string, never>)
  success: Schema.Struct({ ok: Schema.Boolean }), // default Schema.Void
  failure: Schema.Struct({ message: Schema.String }), // default Schema.Never
  failureMode: "error", // "error" (default) -> error channel | "return" -> tool result
  // also: dependencies?: Context.Key[], needsApproval?: boolean | fn
});

const Kit = Toolkit.make(Click, Finish); // Toolkit<{ browser_click: …, finish: … }>
// Toolkit.merge(kitA, kitB), Toolkit.empty also exist.
```

Handlers, only if you _do_ want auto-resolution:

```ts
const KitLayer = Kit.toLayer(
  Kit.of({
    // or Kit.toLayer(Effect.gen(...))
    browser_click: ({ selector }, ctx) => Effect.succeed({ ok: selector.length > 0 }),
    finish: () => Effect.void,
  }),
);
// Layer<Tool.HandlersFor<Tools>, EX, Exclude<RX, Scope>>; Kit.toHandlers(...) gives a Context instead.
// Handler ctx: { toolCallId?: string; preliminary(result): Effect<void> }
// Handler E may be Tool.Failure | AiError | AiError.AiErrorReason.
```

## 4. Prompt — multi-turn, manual tool results

```ts
type Prompt.RawInput = string | Iterable<Prompt.MessageEncoded> | Prompt.Prompt
Prompt.make(input)            // string -> one user message
Prompt.empty
Prompt.fromMessages(msgs)     // ReadonlyArray<Prompt.Message>
Prompt.fromResponseParts(response.content)   // assistant + tool messages out of a model response
Prompt.concat(a, b)           // dual: Prompt.concat(b)(a) works in .pipe
Prompt.setSystem / prependSystem / appendSystem (prompt, text)   // also dual
Prompt.makeMessage("system"|"user"|"assistant"|"tool", { content })
Prompt.makePart("text"|"file"|"tool-call"|"tool-result"|"tool-approval-request"|"tool-approval-response", {...})
Prompt.Prompt  // Schema.Codec<Prompt, PromptEncoded> — encode/decode for persistence
prompt.content // ReadonlyArray<Prompt.Message>
```

Encoded message literals are the easiest input (decoded eagerly, throws on bad shape):

```ts
const p = Prompt.make([
  { role: "system", content: "You drive a browser." },
  { role: "user", content: "log in" }, // string OR part array
  { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "t", params: { n: 5 } }] },
  {
    role: "tool",
    content: [{ type: "tool-result", id: "c1", name: "t", isFailure: false, result: "ok" }],
  },
]);
```

`Prompt.ToolCallPart` / `Prompt.ToolResultPart` (prompt-side) are **different types** from
`Response.ToolCallPart` / `Response.ToolResultPart`. Prompt-side `params`/`result` are `unknown`;
Response-side are generic in the tool. `Prompt.ToolResultPart` requires `{ id, name, isFailure, result,
providerExecuted }` (`providerExecuted` optional in the _Encoded_ form only).

Loop shape, verified: append the model's own parts, then your own tool message.

```ts
prompt = Prompt.concat(prompt, Prompt.fromResponseParts(response.content)); // assistant msg w/ tool-call
prompt = Prompt.concat(
  prompt,
  Prompt.fromMessages([
    Prompt.makeMessage("tool", {
      content: [
        Prompt.makePart("tool-result", {
          id: call.id,
          name: call.name,
          isFailure: false,
          result,
          providerExecuted: false,
        }),
      ],
    }),
  ]),
);
```

`Prompt.fromResponseParts` folds `*-delta` streams into whole text/reasoning parts, puts `tool-call` +
`tool-approval-request` in an assistant message and non-preliminary `tool-result`s in a tool message (using
their **encoded** result). With resolution disabled there are no tool-result parts, so it only ever produces
the assistant message — confirmed at runtime (`roles: user,assistant`).

## 5. Worked example — intercepting agent loop + separate verifier

Compiles clean (`.recon/ai.ts`). No network.

```ts
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Config, Effect, Layer, Schema } from "effect";
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";

export const AnthropicLayer: Layer.Layer<AnthropicClient.AnthropicClient, Config.ConfigError> =
  AnthropicClient.layerConfig({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") }).pipe(
    Layer.provide(FetchHttpClient.layer),
  );

export const modelLayer = (
  id: string,
): Layer.Layer<LanguageModel.LanguageModel, Config.ConfigError> =>
  AnthropicLanguageModel.layer({ model: id, config: { max_tokens: 4096 } }).pipe(
    Layer.provide(AnthropicLayer),
  );

const ClickParams = Schema.Struct({
  selector: Schema.String,
  timeoutMs: Schema.optional(Schema.Int),
});
export const Click = Tool.make("browser_click", {
  description: "Click an element",
  parameters: ClickParams,
  success: Schema.Struct({ ok: Schema.Boolean }),
  failure: Schema.Struct({ message: Schema.String }),
});
export const Finish = Tool.make("finish", {
  description: "End the run",
  parameters: Schema.Struct({ verdict: Schema.Literals(["pass", "fail"]) }),
  success: Schema.Void,
});
export const Kit = Toolkit.make(Click, Finish);

const decodeClick = Schema.decodeUnknownEffect(ClickParams);

export const loop = Effect.fn("loop")(function* (goal: string) {
  let prompt: Prompt.Prompt = Prompt.make([
    { role: "system", content: "You drive a browser." },
    { role: "user", content: goal },
  ]);

  for (let step = 0; step < 10; step++) {
    const response = yield* LanguageModel.generateText({
      prompt,
      toolkit: Kit, // no handler layer needed
      toolChoice: "auto",
      disableToolCallResolution: true, // params arrive ENCODED, nothing is executed
    });

    yield* Effect.log(
      `finish=${response.finishReason} in=${response.usage.inputTokens.total} out=${response.usage.outputTokens.total}`,
    );

    const calls = response.toolCalls;
    if (calls.length === 0) return response.text;

    prompt = Prompt.concat(prompt, Prompt.fromResponseParts(response.content));

    const resultParts: Array<Prompt.ToolResultPart> = [];
    for (const call of calls) {
      const id: string = call.id;
      const name: "browser_click" | "finish" = call.name; // literal union, narrowable
      if (name === "browser_click") {
        const params = yield* decodeClick(call.params); // OUR validation, OUR execution
        resultParts.push(
          Prompt.makePart("tool-result", {
            id,
            name,
            isFailure: false,
            result: { ok: params.selector.length > 0 },
            providerExecuted: false,
          }),
        );
      } else {
        resultParts.push(
          Prompt.makePart("tool-result", {
            id,
            name,
            isFailure: false,
            result: undefined,
            providerExecuted: false,
          }),
        );
      }
    }
    prompt = Prompt.concat(
      prompt,
      Prompt.fromMessages([Prompt.makeMessage("tool", { content: resultParts })]),
    );
  }
  return "max steps";
});

export class Verdict extends Schema.Class<Verdict>("Verdict")({
  passed: Schema.Boolean,
  confidence: Schema.Finite,
  reasons: Schema.Array(Schema.String),
}) {}

export const verify = Effect.fn("verify")(function* (transcript: string) {
  const res = yield* LanguageModel.generateObject({
    objectName: "verdict",
    schema: Verdict,
    prompt: Prompt.make([
      { role: "system", content: "You are a strict judge." },
      { role: "user", content: transcript },
    ]),
  });
  return res.value; // Verdict, already decoded
});

export const main: Effect.Effect<
  Verdict,
  AiError.AiError | Schema.SchemaError | Config.ConfigError
> = Effect.gen(function* () {
  const text = yield* loop("log in");
  return yield* verify(text);
}).pipe(Effect.provide(modelLayer("claude-sonnet-4-5")));
```

`E` of the whole program: `AiError` (from the model) `| Schema.SchemaError` (from our own
`decodeUnknownEffect`) `| Config.ConfigError` (from `layerConfig`).

## 6. generateObject notes

- `res.value` is the **decoded** schema type; `res.text` is the raw JSON string.
- `objectName` defaults to the schema's identifier (`Schema.Class`/`Schema.Struct` annotation) via
  `LanguageModel.getObjectName`; supply it explicitly for anonymous structs.
- The schema's `DecodingServices` land in `R`.
- Provider schema rewriting is `AnthropicStructuredOutput.toCodecAnthropic` (wired automatically).
  Gotchas from its docblock: tuples → objects with numeric-string keys, index signatures → `[k,v]` arrays,
  optional props → required-nullable, `oneOf` → `anyOf`, **recursive schemas throw**.
- On models without native structured output, `prepareTools` **replaces the entire tools array** with a single
  forced JSON tool. So `generateObject` + a real `toolkit` is mutually exclusive there. Native support is
  detected by model id: `claude-sonnet-4-5`, `claude-opus-4-5`, `claude-haiku-4-5`, `claude-opus-4-1`, and
  anything unrecognized → `true`; `claude-sonnet-4-0`, `claude-3-7-sonnet`, `claude-opus-4-0`,
  `claude-3-5-haiku`, `claude-3-*` → `false`.

## 7. @effect/ai-anthropic

```ts
AnthropicClient.layer(options): Layer<AnthropicClient, never, HttpClient>
AnthropicClient.layerConfig(options?): Layer<AnthropicClient, Config.ConfigError, HttpClient>
// Options: { apiKey?: Redacted<string>; apiUrl?: string; apiVersion?: string;
//            transformClient?: (c: HttpClient) => HttpClient }
// layerConfig takes Config<…> for each of apiKey / apiUrl / apiVersion.
```

There is **no implicit `ANTHROPIC_API_KEY` default** — you name the env var yourself:
`apiKey: Config.Redacted("ANTHROPIC_API_KEY")`. `apiKey` is optional (unauthenticated / proxy).
Defaults: `apiUrl = "https://api.anthropic.com"`, `apiVersion = "2023-06-01"`. The key goes in the
`x-api-key` header and is registered as a redacted header name.
You must supply an `HttpClient` layer yourself (`FetchHttpClient.layer` or `NodeHttpClient.layerUndici`).

```ts
AnthropicLanguageModel.layer({ model, config? }): Layer<LanguageModel, never, AnthropicClient>
AnthropicLanguageModel.make({ model, config? }): Effect<LanguageModel, never, AnthropicClient>
AnthropicLanguageModel.model(id, config?): Model.Model<"anthropic", LanguageModel, AnthropicClient>
AnthropicLanguageModel.withConfigOverride(effect, overrides)   // dual, scoped Config service
```

`model(id)` returns a `Model`, which **extends `Layer<LanguageModel | ProviderName | ModelName, never,
AnthropicClient>`** — use it with `Effect.provide` / `Layer.provide` directly. It also exposes
`.captureRequirements: Effect<Layer<…>, never, AnthropicClient>` to lift the client requirement out to the
enclosing service. It is _not_ an `Effect<LanguageModel>`.

Runtime model selection:

```ts
export const withRuntimeModel = Effect.gen(function* () {
  const id = yield* Config.String("AGENT_MODEL").pipe(Config.withDefault("claude-sonnet-4-5"));
  const model = yield* AnthropicLanguageModel.model(id, { max_tokens: 8192, temperature: 0 })
    .captureRequirements;
  const provider = yield* Effect.provide(Effect.service(Model.ProviderName), model); // "anthropic"
  const name = yield* Effect.provide(Effect.service(Model.ModelName), model); // the id
  return { model, provider, name };
});
```

`model` accepts `(string & {}) | AnthropicLanguageModel.Model` — arbitrary strings are allowed, so a config
value needs no cast. Known literals (`Generated.Model`): `claude-sonnet-5`, `claude-fable-5`,
`claude-mythos-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-mythos-preview`, `claude-opus-4-6`,
`claude-sonnet-4-6`, `claude-haiku-4-5(-20251001)`, `claude-opus-4-5(-20251101)`,
`claude-sonnet-4-5(-20250929)`, `claude-opus-4-1(-20250805)`.

`AnthropicLanguageModel.Config` (also a `Context.Service` for scoped overrides) = `Partial<BetaCreateMessageParams
minus messages/output_config/tools/tool_choice/stream>` — so `max_tokens`, `temperature`, `top_p`, `top_k`,
`stop_sequences`, `system`, `thinking`, `metadata`, `service_tier` … plus
`output_config.effort?: "low"|"medium"|"high"|null`, `disableParallelToolCalls?`, `structuredOutputs?`
(override capability detection), `strictJsonSchema?`.

`max_tokens` is **not required**: it defaults to the model's `maxOutputTokens`
(64000 for sonnet/opus/haiku-4-5, 32000 for opus-4-1, 8192 for 3-5-haiku, 4096 for claude-3-*, 128000 for
unrecognized ids). Set it explicitly for cost control.

`AnthropicConfig.AnthropicConfig` / `AnthropicConfig.withClientTransform` let you transform requests
(e.g. add headers) at the client level. Provider-defined tools: `AnthropicTool.*` (bash, computer, text editor,
web search …) — these are executed server-side and do **not** get handlers.

## 8. Cancellation

**Yes — interrupting the Effect aborts the underlying HTTP request.** Verified in
`effect/src/unstable/http/HttpClient.ts` (`make`, ~L788-880): every non-scoped request runs under
`Effect.uninterruptibleMask`; on `onFailure` it checks `Cause.hasInterrupts(cause)` and calls
`controller.abort()`, where `controller.signal` is what `FetchHttpClient` passes to `fetch`. Successful
responses are wrapped in an `InterruptibleResponse` that aborts the controller if the _body stream_ is
interrupted, and a `FinalizationRegistry` + 5s timer aborts responses whose body is never read.
`AnthropicClient` is built on `HttpClient` for both `createMessage` and `createMessageStream`, so
`Effect.timeout`, `Effect.race`, fiber interrupt and scope closure all propagate to the socket.

```ts
export const guarded: Effect.Effect<string, AiError.AiError, LanguageModel.LanguageModel> =
  LanguageModel.generateText({ prompt: "hi" }).pipe(
    Effect.map((r) => r.text),
    Effect.timeout("30 seconds"),
    Effect.catchTag("TimeoutError", () => Effect.succeed("timed out")),
  );
```

## 9. Errors

Single error class `AiError.AiError` (`_tag: "AiError"`, a `Schema.Error`) with
`{ module: string; method: string; reason: AiErrorReason }`, plus getters `isRetryable: boolean`,
`retryAfter: Duration | undefined`, `message = "${module}.${method}: ${reason.message}"`, and
`cause === reason`. **Catch with `Effect.catchTag("AiError", …)` then switch on `error.reason._tag`.**

`AiErrorReason` (`AiError.AiErrorReason` is a `Schema.Union`, usable directly inside your own
`Schema.TaggedError`) — 18 variants:

`RateLimitError` (`retryAfter?: Duration`, retryable) · `QuotaExhaustedError` · `AuthenticationError` ·
`ContentPolicyError` · `InvalidRequestError` · `InternalProviderError` · `NetworkError` · `InvalidOutputError` ·
`StructuredOutputError` · `UnsupportedSchemaError` · `UnknownError` · `ToolNotFoundError` ·
`ToolParameterValidationError` · `InvalidToolResultError` · `ToolResultEncodingError` ·
`ToolConfigurationError` · `ToolkitRequiredError` · `InvalidUserInputError`.

Each carries `metadata` (provider metadata record) and most carry `http?: AiError.HttpContext`
(request/response details). `AiError.make({ module, method, reason })`, `AiError.isAiError`,
`AiError.isAiErrorReason`, `AiError.reasonFromHttpStatus({ status, body })`.

## 10. Chat (optional)

`Chat.empty` / `Chat.fromPrompt(raw)` / `Chat.fromJson` / `Chat.fromExport` / `Chat.makePersisted` /
`Chat.layerPersisted`. A `Chat` holds `history: Ref<Prompt>` and mirrors `generateText/generateObject/
streamText` (same options, including `disableToolCallResolution`), concatenating
`Prompt.fromResponseParts(response.content)` into history under a 1-permit semaphore, plus
`export`/`exportJson`.
**Gotcha for our use case:** with resolution disabled, `Chat` records the assistant tool-call message but
never the tool results — you must `Ref.update(chat.history, …)` with your own tool message yourself. For a
loop we fully control, a plain `let prompt: Prompt.Prompt` (as in §5) is simpler.

## 11. Misc facts

- `Response.Part<Tools, Mode>` (non-stream) has no delta parts; `Response.StreamPart<Tools, Mode>` has no
  aggregate `text`/`reasoning` parts. `Response.AnyPart` is the untyped superset of everything.
- `Response.makePart("tool-call", {...})` / `Prompt.makePart(...)` attach a hidden `~effect/…/Part` brand —
  do **not** hand-build part objects as plain literals when a `Part` (not `PartEncoded`) is expected.
  Plain literals ARE accepted wherever `MessageEncoded`/`PartEncoded` is the input (e.g. `Prompt.make([...])`).
- Tool names on `response.toolCalls[i].name` are a literal union of the toolkit's tool names — `switch`/`if`
  narrows `params` per tool.
- `LanguageModel.make({ generateText, streamText })` builds a fake model layer for tests: the hooks return
  `AnyPartEncoded[]` / `Stream<AnyPartEncoded>` and the framework decodes + resolves. Used in
  `.recon/ai-runtime*.ts`; this is the cheapest way to unit-test a loop with no network.
- Provider hook receives `LanguageModel.ProviderOptions`: `{ prompt, tools, responseFormat, toolChoice, span,
previousResponseId, incrementalPrompt }` — handy for asserting on what we sent in tests.
- `ExecutionPlan.make({ provide: Model, attempts }, …)` + `Effect.withExecutionPlan` gives multi-provider
  fallback; `plan.captureRequirements` lifts client requirements into a Layer. UNVERIFIED: not compiled here
  (single-provider setup), but it is the pattern in `ai-docs/src/71_ai/10_language-model.ts`.

---

# APPENDIX (critic pass) — gaps no lane answered

Compiled: `.recon/critic-ai.ts`, `.recon/critic-scripted.ts`, `.recon/critic-tooljson.ts`,
`.recon/critic-emptyparams.ts`. The last three were **executed**; output below is real.

Re-verified from §3/§5: with `disableToolCallResolution: true` the effect's type is exactly
`Effect<…, AiError.AiError, LanguageModel.LanguageModel>` — **no handler layer, no `Tool.Handler`
in `R`** — and `call.params` is the _encoded_ shape (`c.params.selector` is `string`).

## B1. `Tool.getJsonSchema(tool)` — how to get a tool definition for a custom `ModelProvider`

`design-contracts.md` §10 declares `tools?: ToolDefinition[]` "JSON-Schema derived from Effect
Schema". You do **not** need to re-derive it — every `Tool` exposes its parts:

```ts
import { Tool, Toolkit } from "effect/unstable/ai";

tool.name; // literal union member, e.g. "browser_click"
tool.description; // string | undefined
tool.parametersSchema; // the Schema you passed (or Tool.EmptyParams)
tool.successSchema; // Schema.Void by default
tool.failureSchema; // Schema.Never by default
Tool.getJsonSchema(tool); // JsonSchema.JsonSchema  <- feed this to a provider
Tool.getJsonSchemaFromSchema(anySchema); // same for a bare Schema (e.g. the verifier's response)
Object.entries(kit.tools); // Toolkit -> Record<name, Tool.Any>
```

**GOTCHA 1 — `getJsonSchema` emits `additionalProperties: true`.** It calls
`Schema.toJsonSchemaDocument` with _default_ options (`onExcessProperty: "ignore"`). Executed:

```
Tool.make("browser_click", { parameters: Schema.Struct({observationId, ref, intent?}) })
 -> {"type":"object","properties":{…},"required":["observationId","ref"],"additionalProperties":true}
```

Anthropic strict tools / `strictJsonSchema` want `false`. Emit it yourself when you need closed
objects: `Schema.toJsonSchemaDocument(tool.parametersSchema, { onExcessProperty: "error",
referencePolicy: () => undefined }).schema`.

**GOTCHA 2 — it can emit `$ref` + a nested `$defs`.** Any field schema carrying an `identifier`
annotation is hoisted:

```
parameters: Schema.Struct({ criterionId: Schema.String.annotate({ identifier: "CriterionId" }) })
 -> {"type":"object","properties":{"criterionId":{"$ref":"#/$defs/CriterionId"}},…,
     "$defs":{"CriterionId":{"type":"string"}}}
```

Not every provider follows `$defs` in a tool's `input_schema`. Pass
`referencePolicy: () => undefined` to force everything inline, or simply do not put `identifier`
annotations on tool-parameter field schemas.

**GOTCHA 3 — inconsistent `additionalProperties` for a no-params tool.** `Tool.make("observe", {})`
(i.e. `Tool.EmptyParams`) emits `{"type":"object","additionalProperties":false}` — `false`, not
`true`. Don't assume uniformity; normalise in your own emitter.

`Tool.dynamic(...)` also exists: it takes a **raw JSON Schema** instead of an Effect Schema
(`tool.jsonSchema` is then populated and `getJsonSchema` returns it verbatim). Useful if you ever
need a tool shape Effect Schema cannot express — not needed for the eight MVP tools.

## B2. The SCRIPTED adapter — a deterministic `LanguageModel` layer (MVP-critical, was undocumented)

Spec §3 requires "un adaptateur scripté déterministe pour tester le harness sans appel externe",
and §13 requires scripted **verifier** responses too. The right seam is `LanguageModel.make` —
then the _same_ agent loop, the same `Toolkit`, the same `Prompt` plumbing run against it, and only
the layer changes. Exact signature from `src/unstable/ai/LanguageModel.ts:790`:

```ts
LanguageModel.make(params: {
  readonly generateText: (options: ProviderOptions) =>
    Effect.Effect<Array<Response.PartEncoded>, AiError.AiError, IdGenerator>
  readonly streamText: (options: ProviderOptions) =>
    Stream.Stream<Response.StreamPartEncoded, AiError.AiError, IdGenerator>
  readonly codecTransformer?: CodecTransformer | undefined
}): Effect.Effect<LanguageModel>

interface ProviderOptions {       // what your fake RECEIVES — assert on it in tests
  readonly prompt: Prompt.Prompt
  readonly tools: ReadonlyArray<Tool.Any>
  readonly responseFormat: { type: "text" } | { type: "json"; objectName: string; schema: Schema.Top }
  readonly toolChoice: …; readonly span: …; readonly previousResponseId: …; readonly incrementalPrompt: …
}
```

You return **encoded** parts; the framework decodes them and applies the toolkit typing.

```ts
import { Effect, Layer, Ref, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";

type Turn = ReadonlyArray<Response.PartEncoded>;

const finishPart = (reason: "stop" | "tool-calls"): Response.PartEncoded => ({
  type: "finish",
  reason,
  usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
});

export const scriptedLayer = (
  script: ReadonlyArray<Turn>,
  seen?: Array<LanguageModel.ProviderOptions>, // optional spy for assertions
): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const cursor = yield* Ref.make(0);
      return yield* LanguageModel.make({
        generateText: (options) =>
          Effect.gen(function* () {
            seen?.push(options);
            const i = yield* Ref.getAndUpdate(cursor, (n) => n + 1);
            return [...(script[i] ?? [finishPart("stop")])];
          }),
        streamText: (options) =>
          Stream.unwrap(
            Effect.gen(function* () {
              seen?.push(options);
              const i = yield* Ref.getAndUpdate(cursor, (n) => n + 1);
              return Stream.fromIterable(
                (script[i] ?? [finishPart("stop")]) as ReadonlyArray<Response.StreamPartEncoded>,
              );
            }),
          ),
      });
    }),
  );
```

Encoded part shapes you need (from `src/unstable/ai/Response.ts`):

```ts
{ type: "text",      text: string }
{ type: "tool-call", id: string, name: string, params: unknown, providerExecuted?: boolean }
{ type: "finish",    reason: FinishReason, usage: { inputTokens: {...}, outputTokens: {...} } }
```

Executed against the §5 loop with `disableToolCallResolution: true`:

```
step 0: finish=tool-calls text="clicking the button" in=10 out=5
   call call_1 browser_click {"observationId":"obs_1","ref":"e7"}
step 1: finish=tool-calls text="" in=10 out=5
   call call_2 finish {"summary":"done"}
tools the provider actually received: [['browser_click','finish'], ['browser_click','finish']]
responseFormat: {"type":"text"}
roles in final prompt: user,assistant,tool,assistant,tool
```

Notes:

- `usage` flows straight through — a scripted run can therefore exercise the **token budget**
  and `verifierReserveTokens` logic without any network.
- For the **scripted verifier**, reuse the same layer and script a single
  `{ type: "text", text: JSON.stringify(verdict) }` turn; `generateObject` sets
  `responseFormat: { type: "json", objectName, schema }`, which your fake can read from
  `options.responseFormat` to pick the right canned verdict. Mark the result
  `evaluator.kind === "scripted-model"` per design-contracts §8.
- `Layer.fresh(scriptedLayer(...))` per attempt if you don't want the cursor shared.
- `options.tools` / `options.prompt` are the assertion surface for "secrets never reach the model"
  and "the contract text is never re-sent from the page".
