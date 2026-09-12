# `examples/scenarios` — the demo specs

Three `*.e2e.md` scenarios that run, and four that must be **rejected**. They target
[`examples/fixture-app`](../fixture-app/README.md) through
[`examples/support`](../support/README.md)'s `difmp.config.ts`.

The scenarios are written in French, like the spec. The harness itself is language-agnostic: the body
and the criteria are text handed to a model, and the frontmatter keys are the only fixed vocabulary.

| spec | shows |
| --- | --- |
| `project-create.e2e.md` | The standard journey. A fixture, three **textual** expectations, no TypeScript profile. This is the one run against all four app variants. |
| `project-create-checked.e2e.md` | The advanced extension: `checks: { c3: project-unique-in-storage }` binds the third criterion to a TS check whose verdict is authoritative and reported as `method: code`. |
| `project-create-no-fixture.e2e.md` | **`inputs` and `fixture` are genuinely optional.** No fixture, no declared inputs: the harness opens a clean context at `baseUrl` and the scenario signs in through the UI. |
| `invalid/*.e2e.md` | Four specs that must never reach a browser. |

## Why `project-create` is worded the way it is

Its third expectation says, in as many words, that it is about *what the list displays* and that a
filtered or paginated list cannot establish global uniqueness. That is not padding: a textual
expectation is judged from evidence, and "exactly one exists" is not something a screenshot of a list
can prove. `project-create-checked` is the scenario that makes the stronger claim, and it does so
through a server-side probe the browsing agent has no access to.

The project name is `Projet {{ run.id }}`, so two runs never collide in one workspace.

## The four invalid specs

`invalid/` holds one spec per rejection rule: both expectation sources at once, an unknown frontmatter
field, a duplicate YAML key, and a missing `version`. They are excluded from discovery
(`exclude: ["**/invalid/**"]`) because they are loader fixtures, not runs — but naming one explicitly
still reaches the loader, which is how the rejection is demonstrated:

```sh
node apps/cli/dist/bin/difmp.js run examples/scenarios/invalid/missing-version.e2e.md \
     --config examples/support/difmp.config.ts
```

```
ERROR
  …/invalid/missing-version.e2e.md:2:1 (field `version`): invalid frontmatter
  - version: Missing key
```

Exit `2`, no browser process started, no run directory created.

## Running them

See the [root README](../../README.md#run-the-demo) for the full sequence, and
[`examples/support`](../support/README.md) for the variant matrix and the scripted cases.
