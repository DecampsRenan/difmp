import type { ToolDefinition } from "@difmp/core";
import { toolDefinitions, toolJsonSchema } from "@difmp/core";
import type { JsonSchema } from "effect";
import { Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

export { toolDefinitions, toolJsonSchema };

/**
 * Tool definitions cross the `ModelProvider` boundary as plain JSON Schema, so the provider side
 * rebuilds them with `Tool.dynamic`: no handler is ever attached and `params` stay opaque. The
 * harness — not the provider — decodes them with the Effect Schema that produced the JSON Schema.
 */
export type HarnessTool = Tool.Tool<
  string,
  {
    readonly parameters: typeof Schema.Unknown;
    readonly success: typeof Schema.Unknown;
    readonly failure: typeof Schema.Never;
    readonly failureMode: "error";
  }
>;

/** No handler, no decoding services: the provider never needs anything from the environment. */
export type HarnessToolkit = Toolkit.Toolkit<Record<string, HarnessTool>>;

export const toToolkit = (definitions: ReadonlyArray<ToolDefinition>): HarnessToolkit => {
  const tools = definitions.map(
    (definition) =>
      Tool.dynamic(definition.name, {
        ...(definition.description === undefined ? {} : { description: definition.description }),
        parameters: definition.parameters as JsonSchema.JsonSchema,
      }) as unknown as HarnessTool,
  );
  return Toolkit.make(...tools) as HarnessToolkit;
};
