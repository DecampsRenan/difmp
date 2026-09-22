# `@difmp/example-demo-start-ui` — battery against https://demo.start-ui.com

Local, runnable scenarios for exercising real browser navigation (and optionally a real model /
Jev evaluator) against the public [Start UI](https://start-ui.com/) demo.

This package follows the same patterns as [`examples/support`](../support/README.md): a
`difmp.config.ts`, Markdown scenarios, and a `scripts/` registry for the deterministic
`scripted` provider. The site under test is remote and shared — scenarios stay **read-mostly**
(login + nav + search + open a form; no creates).

```
examples/demo-start-ui/
  difmp.config.ts          baseUrl → https://demo.start-ui.com, scripted by default
  scenarios/*.e2e.md       login, books search, manager nav, new-book form
  scripts/journey.ts       accessible-name walkthroughs for the demo UI
  scripts/registry.ts      auto + named script factories
  scripts/run-battery.sh   pnpm-friendly runner
```

## Prerequisites

| Need                 | Notes                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| Node.js `>= 22.12.0` | Same as the monorepo                                                      |
| Built CLI            | `pnpm build` from the repo root (produces `apps/cli/dist/bin/difmp.js`)   |
| Playwright Chromium  | `pnpm exec playwright install chromium` (add `--with-deps` on bare Linux) |
| Network              | Reachability of `https://demo.start-ui.com`                               |

No API key is required for the default **scripted** path.

## Run the battery (scripted — default)

From the repository root:

```bash
pnpm build
pnpm exec playwright install chromium   # once per machine
pnpm test:demo-start-ui
```

Or from this package:

```bash
pnpm --filter @difmp/example-demo-start-ui test
```

Equivalent direct CLI invocation:

```bash
node apps/cli/dist/bin/difmp.js run --config examples/demo-start-ui/difmp.config.ts
```

List discovered scenarios:

```bash
pnpm --filter @difmp/example-demo-start-ui test:list
```

Run a single scenario:

```bash
node apps/cli/dist/bin/difmp.js run examples/demo-start-ui/scenarios/login-admin.e2e.md \
  --config examples/demo-start-ui/difmp.config.ts
```

Reports land in `examples/demo-start-ui/runs/<run-id>/`.

## What is covered

| Scenario        | Exercises                                                                       |
| --------------- | ------------------------------------------------------------------------------- |
| `login-admin`   | Demo-mode OTP login (`admin` → Login with email → `000000`) → manager Dashboard |
| `books-search`  | Login → Books → search seeded title `Dracula`                                   |
| `manager-nav`   | Login → Books → Users → Dashboard via sidebar                                   |
| `new-book-form` | Login → Books → New Book form fields (no submit)                                |

## Demo credentials (public)

The login page advertises **Demo mode** shortcuts. Specs and scripts use those controls — they
are not secrets:

- Click **admin** (fills `admin@admin.com`)
- Click **Login with email**
- Click **000000** on the verification page (demo OTP; auto-confirms)

## Real model (optional)

Needs `ANTHROPIC_API_KEY`. The scripted registry is unused; the model drives tools from the
Markdown journey text.

```bash
export ANTHROPIC_API_KEY=…
DIFMP_PROVIDER=anthropic pnpm test:demo-start-ui
# or:
node apps/cli/dist/bin/difmp.js run --config examples/demo-start-ui/difmp.config.ts \
  --provider anthropic --model claude-sonnet-5
```

Claude Sonnet 5 must omit `temperature` / `topP` / `topK` (difmp rejects them in preflight).

## Jev evaluator (optional)

Navigation can stay `scripted` while criteria are judged by Jev (`evaluator` in config). This
package enables that via env without editing the file:

```bash
# keyless dry-run of the Jev client (verdicts still labelled evaluator.kind: "model")
DIFMP_EVALUATOR=jev DIFMP_JEV_BACKEND=mock pnpm test:demo-start-ui

# real Jev backend (TYPESAFE_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY)
DIFMP_EVALUATOR=jev DIFMP_JEV_BACKEND=typesafe DIFMP_JEV_MODEL=jev-1.13.0 \
  pnpm test:demo-start-ui
```

Scripted navigation + Jev judge is the useful local combo for trying #30 without paying for a
browsing model.

## Site quirks / stability notes

- **SPA hydration** — after `load`, the aria tree is briefly an empty shell. Scripted walkthroughs
  pause on the Node side (`Atomics.wait`) before interacting; a real model should re-observe until
  Demo mode controls appear.
- **Shared public demo** — do not create/edit/delete books or users from this battery.
- **OTP login** — always use the Demo mode buttons; inventing passwords will fail.
- **Books search is debounced** — the scripted walkthrough observes twice after fill so the
  filter can apply; a real model should wait for “Showing 1 of 1” / the filtered result.
- **Seeded catalog** — `Dracula` is present in the current demo seed; if the upstream demo
  reseeds without that title, update the scenario and script.
- **Admin display name** — the header label includes a generated suffix; criteria talk about an
  account control, not a fixed display string.
- **Not wired into CI `test:examples`** — that job packs the CLI and drives the local fixture
  app offline. This battery needs outbound HTTPS to the demo host; run it locally (or in a
  job that allows that egress).

## Switching scripted cases

```bash
DIFMP_SCRIPT=login-admin pnpm test:demo-start-ui
# auto (default) maps scenario id → walkthrough of the same name
```
