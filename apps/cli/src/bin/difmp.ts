#!/usr/bin/env node
// Deep subpath imports, NOT the barrel: `@effect/platform-node`'s index re-exports `NodeRedis`,
// which eagerly imports `redis` — a NON-optional peer dependency of that package. npm and pnpm
// auto-install peers so the barrel happens to work there; Yarn does not, and the installed CLI
// died with ERR_MODULE_NOT_FOUND "redis" in a Yarn consumer. Subpaths pull in no Redis client.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
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
