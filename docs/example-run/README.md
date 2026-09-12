# Example run — `project-create` against the `false-success` variant

A real, unedited run directory. Reproduce it with:

```sh
# `pnpm build` covers packages/* and apps/* only — the demo app lives in examples/*.
pnpm build
pnpm --filter @difmp/fixture-app build

node examples/fixture-app/dist/main.js \
  --port 0 --variant false-success --seed \
  --seed-email demo@example.test --seed-password demo-password   # note the URL + x-seed-token it prints

DIFMP_BASE_URL=<url> FIXTURE_APP_SEED_TOKEN=<token> FIXTURE_APP_VARIANT=false-success \
  node apps/cli/dist/bin/difmp.js run examples/scenarios/project-create.e2e.md \
       --config examples/support/difmp.config.ts
```

`FIXTURE_APP_VARIANT` is what tells the `auto` entry of the scripted adapter which walkthrough it is
about to meet; `--variant` alone only changes the application. Without it the adapter drives the
healthy journey and the run passes, which is not what this directory shows.

`--seed-email` / `--seed-password` fix the demo login, as the CI example job does. This scenario
never uses it: its `authenticated-workspace` fixture mints a workspace of its own through
`POST /__seed/workspace`, which is why the token matters and the credentials do not.

`runs/` is gitignored, so this is a copy. **One file was pruned: `attempts/a1/trace.zip`
(1.1 MB, 1,074,805 bytes).** It is still listed in `artifacts.json` as `art_9`, `state: "present"`
— that record describes the run as it happened, and editing it to hide the pruning would be a lie
about the evidence. Everything else is byte-for-byte what the harness wrote.

## What it shows

The `false-success` variant answers `201 Created` and the page optimistically adds the project to
the list — but nothing is written server-side. The verdicts split exactly where they should:

| criterion | status | why |
| --- | --- | --- |
| c1 — appears in the list after creation | `passed` | `art_2` (aria snapshot after submit) lists `Project r_tqyz6a2ucpgic` |
| c2 — still present after a full reload | `failed` | `art_5` (aria snapshot after the reload) says `No projects yet.` |
| c3 — exactly one entry with that name after the reload | `failed` | no entry of that name is visible at all |

Run verdict: `failed`, CLI exit code `1`. `attempts/a1/network.jsonl` carries the `201` that made
the UI believe the creation had worked, which is what makes the diagnosis legible.

Open `report.html` directly in a browser — it is standalone and offline, and the screenshots and
snapshots it links are the relative paths under `attempts/a1/`.

`manifest.json` names the adapter: `scripted`. A scripted run exercises the harness's decisions and
real Playwright against the demo app; it is never evidence that a model can navigate.

It also carries `"stage": "final"`. The harness writes `manifest.json` twice (design-contracts §9):
an `initial` one at spec §6 step 2, before the fixture and the freeze, and this `final` one with the
contract hashes once the freeze succeeded. A run that dies in infrastructure setup keeps only the
`initial` one — and is still reported, with a `junit.xml` carrying one run-level `<error>` and no
`contract.json` at all.
