import { Effect } from "effect";

enum FixtureInput {
  Value = "loaded-from-commonjs",
}

export default {
  include: ["tests/**/*.e2e.md"],
  inputs: {
    commonjsConfig: Effect.isEffect(Effect.void) ? FixtureInput.Value : "unreachable",
  },
};
