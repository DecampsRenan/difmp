#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { CliConfig, Command, GlobalFlag } from "effect/unstable/cli"
import { cli, cliVersion, reportFailures, teardown } from "../cli.js"

cli.pipe(
  Command.run({ version: cliVersion }),
  reportFailures,
  Effect.provide(NodeServices.layer),
  // No wizard and no shell completions in the MVP; `--help`, `--version` and `--log-level` stay.
  Effect.provide(CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.LogLevel] })),
  NodeRuntime.runMain({ teardown })
)
