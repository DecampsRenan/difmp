import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer, Result } from "effect";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer);

const here = dirname(fileURLToPath(import.meta.url));

export const fixturePath = (name: string): string => join(here, "fixtures", name);

export const readFixture = (name: string): string => readFileSync(fixturePath(name), "utf8");

/** Run an effect and assert it failed, returning the typed error. */
export const expectFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<E, never, R> =>
  Effect.result(effect).pipe(
    Effect.map((result) => {
      if (Result.isSuccess(result)) {
        throw new Error(`expected a failure, got: ${JSON.stringify(result.success)}`);
      }
      return result.failure;
    }),
  );

export const expectSuccess = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, never, R> =>
  Effect.result(effect).pipe(
    Effect.map((result) => {
      if (Result.isFailure(result)) {
        const failure = result.failure;
        const message = failure instanceof Error ? failure.message : JSON.stringify(failure);
        throw new Error(`expected a success, got failure: ${message}`);
      }
      return result.success;
    }),
  );
