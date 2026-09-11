import type { Command } from "effect/unstable/cli"
import type { runConfig, selectConfig } from "../flags.js"

/** The parsed shape of `harness run` (and of the bare `harness` alias, which shares its config). */
export type RunFlags = Command.Command.Config.Infer<typeof runConfig>

/** The parsed shape of `harness list` and `harness validate`. */
export type SelectFlags = Command.Command.Config.Infer<typeof selectConfig>
