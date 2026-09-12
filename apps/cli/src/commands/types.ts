import type { Command } from "effect/unstable/cli";
import type { runConfig, selectConfig } from "../flags.js";

/** The parsed shape of `difmp run` (and of the bare `difmp` alias, which shares its config). */
export type RunFlags = Command.Command.Config.Infer<typeof runConfig>;

/** The parsed shape of `difmp list` and `difmp validate`. */
export type SelectFlags = Command.Command.Config.Infer<typeof selectConfig>;
