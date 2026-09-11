import type { ToolDefinition } from "@harness/core"
import { toolDefinitions, toolJsonSchema } from "@harness/core"
import type { JsonSchema } from "effect"
import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

export { toolDefinitions, toolJsonSchema }

/**
 * An LLM tool definition must be self-contained: several providers do not follow `$ref` inside a
 * tool's `input_schema`. Core emits with `referencePolicy: () => undefined`, which inlines
 * everything; this is the guard that proves it stayed that way.
 */
export const findSchemaReferences = (schema: unknown, path = "$"): ReadonlyArray<string> => {
  if (Array.isArray(schema)) return schema.flatMap((item, i) => findSchemaReferences(item, `${path}[${i}]`))
  if (typeof schema !== "object" || schema === null) return []
  const out: Array<string> = []
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "$ref" || key === "$defs" || key === "definitions") out.push(`${path}.${key}`)
    out.push(...findSchemaReferences(value, `${path}.${key}`))
  }
  return out
}

/**
 * Tool definitions cross the `ModelProvider` boundary as plain JSON Schema, so the provider side
 * rebuilds them with `Tool.dynamic`: no handler is ever attached and `params` stay opaque. The
 * harness — not the provider — decodes them with the Effect Schema that produced the JSON Schema.
 */
export type HarnessTool = Tool.Tool<string, {
  readonly parameters: typeof Schema.Unknown
  readonly success: typeof Schema.Unknown
  readonly failure: typeof Schema.Never
  readonly failureMode: "error"
}>

/** No handler, no decoding services: the provider never needs anything from the environment. */
export type HarnessToolkit = Toolkit.Toolkit<Record<string, HarnessTool>>

export const toToolkit = (definitions: ReadonlyArray<ToolDefinition>): HarnessToolkit => {
  const tools = definitions.map((definition) =>
    Tool.dynamic(definition.name, {
      ...(definition.description === undefined ? {} : { description: definition.description }),
      parameters: definition.parameters as JsonSchema.JsonSchema
    }) as unknown as HarnessTool
  )
  return Toolkit.make(...tools) as HarnessToolkit
}
