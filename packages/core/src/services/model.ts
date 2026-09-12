import { Context, Effect, Schema } from "effect";
import type { ModelRole } from "../domain/events.js";

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  provider: Schema.String,
  reason: Schema.String,
  retryable: Schema.Boolean,
  status: Schema.optionalKey(Schema.Int),
}) {
  override get message(): string {
    return `${this.provider}: ${this.reason}${this.status === undefined ? "" : ` (status ${this.status})`}`;
  }
}

export type PromptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      /** Binary image input. Providers must encode this as a native multimodal prompt part. */
      readonly type: "image";
      readonly mediaType: string;
      readonly data: Uint8Array;
      readonly fileName?: string;
    }
  | {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly params: unknown;
    }
  | {
      readonly type: "toolResult";
      readonly id: string;
      readonly name: string;
      readonly result: unknown;
      readonly isError?: boolean;
    };

export interface PromptMessage {
  readonly role: "system" | "user" | "assistant";
  readonly parts: ReadonlyArray<PromptPart>;
}

/** The conversation so far. Page text inside it is DATA and can never grant tools. */
export interface Prompt {
  readonly messages: ReadonlyArray<PromptMessage>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema derived from the Effect Schema in domain/tools.ts. */
  readonly parameters: unknown;
}

export interface GenerateRequest {
  readonly role: ModelRole;
  readonly prompt: Prompt;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  /** Verifier only: ask for a structured object. */
  readonly responseSchema?: Schema.Top;
  readonly maxTokens?: number;
  /** Providers that support it must abort the in-flight request. */
  readonly signal?: AbortSignal;
}

export interface ProviderResponse {
  readonly text?: string;
  /** Returned to the harness, NEVER auto-executed by the provider. */
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly params: unknown;
  }>;
  readonly object?: unknown;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly finishReason?: string;
}

export class ModelProvider extends Context.Service<
  ModelProvider,
  {
    /** `"anthropic"` | `"scripted"` — surfaced in the manifest and the report. */
    readonly id: string;
    readonly modelId: string;
    readonly generate: (request: GenerateRequest) => Effect.Effect<ProviderResponse, ProviderError>;
  }
>()("@difmp/core/services/ModelProvider") {}
