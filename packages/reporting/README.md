# `@difmp/reporting`

The `Reporter` implementations: `result.json`, `junit.xml` and a standalone `report.html`.

All three are **pure functions of the persisted run directory**. `renderAll(input)` takes a
`ReportInput` — manifest, result, optional contract, artifact inventory, journal — and returns the
three documents. No model call, no browser, no replay, no configuration re-resolution. That is what
lets `difmp report <run-directory>` rebuild a report months later, from a machine that never had
the application under test.

## `report.html`

One self-contained file: inline CSS, inline data, relative links to the screenshots and snapshots
under `attempts/`. It opens offline and makes no network request. It shows the scenario, the frozen
criteria with their text and `model`/`code` method, each verdict with its `expected` / `observed`
and the evidence it cites, every **downgrade** the harness imposed on the evaluator's answer, the
budgets and the action count, the timeline, and the adapter that ran.

**Everything that reaches the HTML is escaped** — spec text, model text, page text, logs — in
`escape.ts`, applied at three levels (text, attributes, inline data). Page content is attacker-shaped
input; it is rendered as data and never as markup.

`report.html` carries no cost at all: there is no price table anywhere in the harness, and an
estimate presented as a number would be a fabrication. The live dashboard follows the same rule and
renders cost as the literal string `unavailable`.

## `junit.xml`

Product criterion failures become `<failure>`. Technical errors, indeterminate results **and
cancellations** become `<error>`, with the real status preserved in the message and in
`result.json`. An indeterminate result is never turned into a green `<skipped>`.

## When the contract was never frozen

`contract.json` is optional, and its absence *is* the information: `ReportInput.contract` is
`undefined`, the report carries no criteria, and both `junit.xml` and `report.html` are still
produced with one run-level `<error>` naming the infrastructure failure. An infrastructure failure
that reports nothing is indistinguishable, in CI, from a suite that never ran.

```sh
pnpm --filter @difmp/reporting build
npx vitest run packages/reporting
```
