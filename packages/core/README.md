# `@difmp/core`

Everything the harness _decides_, with none of the I/O it decides about.

This package holds the schemas, the spec loader, interpolation, configuration, the registries, the
policy and budget rules, the event journal, the `RunStore` and the runner itself. It depends on
`effect`, `yaml` and `tinyglobby` — **no React, no Playwright, no model SDK**. The browser driver,
the model provider, the verifier, the fixture manager and the reporter are `Context.Service`
interfaces _declared here_ and implemented in the other packages.

That constraint is the point. The rules that matter — a stale element reference is refused without
touching the page, a verdict citing evidence that does not exist can never be `passed`, a blocking
budget yields `inconclusive` and never `failed`, a `failed` is not re-decided because the agent asked
again — are readable in one place and testable without a browser or a network. The test suite drives
the whole runner against fakes.

## What lives where

| directory      |                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `domain/`      | Every schema: config, budgets, spec frontmatter, tools, events, results, manifest. Identifier minting and hashing.                                           |
| `spec/`        | `SpecLoader`: frontmatter split, strict-data-mode YAML, body parsing, duration normalising, discovery. Errors name file, field and line.                     |
| `interpolate/` | `{{ run.id }}`, `{{ attempt.id }}`, declared inputs, `{{ fixture.<key> }}`. Data substitution only — there is no expression engine.                          |
| `config/`      | Resolving and validating `difmp.config.ts`, including input precedence and unknown-key rejection.                                                            |
| `registry/`    | `fixtures`, `checks` and `scripts` resolved **by name**, never by module path, plus the criterion↔check hash binding guard.                                  |
| `policy/`      | The decision rules: action guidance, blocking budgets, origin allow-list, evidence integrity, the absence branch, verdict admission, aggregation, redaction. |
| `store/`       | `RunStore`: the serialised JSONL journal, the artifact inventory, atomic result writes, the live fan-out.                                                    |
| `services/`    | The seam declarations: `BrowserDriver`, `ModelProvider`, `Verifier`, `FixtureManager`, `Reporter`.                                                           |
| `runner/`      | Contract freezing, the agent prompt, and the run loop that ties all of the above together.                                                                   |

## Public entrypoint

`@difmp/core` exports everything above from one entrypoint; there are no deep `src/` imports.
`defineConfig` is here (the CLI re-exports it), along with the public types a consumer touches:
`ResolvedConfig`, `Fixture`, `Check`, `ScriptFactory`, `RunResult`, `HarnessEvent`,
`ScenarioContract`, `Manifest`, `ArtifactInventory`.

## Reading further

The authoritative names and shapes are in
[`docs/internal/design-contracts.md`](../../docs/internal/design-contracts.md); the rationale and the
known limitations are in [`docs/architecture.md`](../../docs/architecture.md).

```sh
pnpm --filter @difmp/core build
npx vitest run packages/core
```
