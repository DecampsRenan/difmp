import type { Prompt as HarnessPrompt, PromptMessage, PromptPart } from "@difmp/core";
import { Prompt } from "effect/unstable/ai";

/**
 * Core describes the conversation with its own provider-neutral shape (`system | user | assistant`
 * messages made of `text | toolCall | toolResult` parts). `effect/unstable/ai` wants a fourth
 * `tool` role. The mapping is mechanical but order-sensitive: a run of tool results inside a core
 * `user` message becomes its own `tool` message, placed exactly where it appeared.
 *
 * Nothing here ever re-reads the scenario from page text: it only re-encodes what core built.
 */
type MessageEncoded = Prompt.MessageEncoded;
type ToolResultPart = Extract<PromptPart, { readonly type: "toolResult" }>;

const textOf = (parts: ReadonlyArray<PromptPart>): string =>
  parts
    .filter((p): p is Extract<PromptPart, { readonly type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");

const toolMessage = (parts: ReadonlyArray<ToolResultPart>): MessageEncoded | undefined =>
  parts.length === 0
    ? undefined
    : {
        role: "tool",
        content: parts.map((p) => ({
          type: "tool-result" as const,
          id: p.id,
          name: p.name,
          isFailure: p.isError === true,
          // The harness executed the tool, not the provider.
          result: p.result === undefined ? null : p.result,
          providerExecuted: false,
        })),
      };

const userMessage = (parts: ReadonlyArray<PromptPart>): MessageEncoded | undefined => {
  const content: Array<Prompt.UserMessagePartEncoded> = [];
  for (const part of parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
  }
  return content.length === 0 ? undefined : { role: "user", content };
};

const assistantMessage = (parts: ReadonlyArray<PromptPart>): MessageEncoded | undefined => {
  const content: Array<Prompt.AssistantMessagePartEncoded> = [];
  for (const part of parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "toolCall") {
      content.push({ type: "tool-call", id: part.id, name: part.name, params: part.params });
    }
  }
  return content.length === 0 ? undefined : { role: "assistant", content };
};

const encodeMessage = (message: PromptMessage): ReadonlyArray<MessageEncoded> => {
  if (message.role === "system") {
    const text = textOf(message.parts);
    return text === "" ? [] : [{ role: "system", content: text }];
  }
  const role: "user" | "assistant" = message.role;
  const out: Array<MessageEncoded> = [];
  let pending: Array<PromptPart> = [];
  let pendingIsToolResult = false;

  const flush = () => {
    if (pending.length === 0) return;
    const encoded = pendingIsToolResult
      ? toolMessage(pending as ReadonlyArray<ToolResultPart>)
      : role === "user"
        ? userMessage(pending)
        : assistantMessage(pending);
    if (encoded !== undefined) out.push(encoded);
    pending = [];
  };

  for (const part of message.parts) {
    const isToolResult = part.type === "toolResult";
    if (pending.length > 0 && isToolResult !== pendingIsToolResult) flush();
    pendingIsToolResult = isToolResult;
    pending.push(part);
  }
  flush();
  return out;
};

export const encodeMessages = (prompt: HarnessPrompt): ReadonlyArray<MessageEncoded> =>
  prompt.messages.flatMap(encodeMessage);

/** Build the provider-side prompt. */
export const toAiPrompt = (prompt: HarnessPrompt): Prompt.Prompt =>
  Prompt.make([...encodeMessages(prompt)]);

/** Reverse direction — the scripted adapter reacts to the conversation it is handed. */
export const fromAiPrompt = (prompt: Prompt.Prompt): HarnessPrompt => ({
  messages: prompt.content.map((message): PromptMessage => {
    if (message.role === "system") {
      return { role: "system", parts: [{ type: "text", text: message.content }] };
    }
    if (message.role === "tool") {
      return {
        role: "user",
        parts: message.content.flatMap((part): ReadonlyArray<PromptPart> =>
          part.type === "tool-result"
            ? [
                {
                  type: "toolResult",
                  id: part.id,
                  name: part.name,
                  result: part.result,
                  isError: part.isFailure,
                },
              ]
            : [],
        ),
      };
    }
    const content = message.content;
    const parts: Array<PromptPart> = [];
    if (typeof content === "string") {
      parts.push({ type: "text", text: content });
    } else {
      for (const part of content) {
        if (part.type === "text") parts.push({ type: "text", text: part.text });
        else if (part.type === "tool-call") {
          parts.push({ type: "toolCall", id: part.id, name: part.name, params: part.params });
        }
      }
    }
    return { role: message.role === "assistant" ? "assistant" : "user", parts };
  }),
});
