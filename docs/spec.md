# Initialising a harness for E2E tests executed by agents

> **Translated from French.** This document is the owner's original implementation brief. It was
> written and committed in French; what follows is an English translation of that text, unchanged in
> substance. The French original is preserved in the git history: `git log --follow -p docs/spec.md`.

This document is the implementation brief to hand to a development agent. Build the project described here until you have a first functional slice that has been executed and verified. Do not stop at a skeleton of files or at an architecture proposal.

## 1. Objective

Build a TypeScript harness with Effect v4 that executes E2E scenarios written in Markdown with YAML frontmatter. An agent chooses the navigation actions; the harness controls the tools, the budgets, the verifications and the evidence collection.

The user must be able to launch a scenario locally or in CI, follow what is happening, then understand a failure from a report and its artifacts.

The first milestone is a "create a project then find it again after a reload" scenario that passes on a healthy application, detects a real regression and produces precise evidence.

## 2. Decisions taken

- Language: TypeScript in strict mode.
- Orchestration runtime: Effect v4, exact version pinned and lockfile committed. Verify the APIs of the installed version; do not copy Effect v3 examples.
- System runtime: Node.js, in an LTS version supported by the chosen dependencies and fixed in the repository and in CI. The runner, the CLI and the live server execute under Node.js. Declare the supported versions in `engines.node`.
- Repository package manager: pnpm, version fixed in `packageManager`, pnpm workspace and `pnpm-lock.yaml` committed. CI installation with `pnpm install --frozen-lockfile`. The distributed package must remain installable and usable with npm, pnpm or Yarn, without imposing pnpm on consumer projects.
- Distribution: a package installable in a third-party project, exposing a `harness` binary through the `bin` field, usable in `package.json` scripts like Vitest, Jest or Mocha. `harness` is a provisional name; check the available name before any eventual publication, which is out of scope.
- Spec format: `*.e2e.md` files, YAML frontmatter between `---`, free-form Markdown body.
- Contract validation: Effect Schema.
- Default verification: free-text expectations, evaluated from collected evidence. No mandatory TS profile. TS checks remain an optional extension for invariants that require deterministic proof.
- `inputs` and `fixture` are optional. `maxActions` is an indicator of the journey's length, never a blocking limit.
- MVP browser: Chromium through the Playwright library called directly from TypeScript.
- Interface: a local React/TypeScript web application, with live tracking over SSE and a standalone HTML report after execution.
- Initial storage: local files. No database service required.
- Initial execution: one scenario at a time, with browser context and data isolated per attempt.
- The agent acts through structured tools controlled by the harness. It has no terminal, no access to the application's sources and no arbitrary JavaScript execution tool.

These choices are the starting point. Resolve the ordinary details autonomously and document the decisions. Ask for a clarification only if an ambiguity genuinely prevents implementation.

## 3. MVP scope

Deliver a complete vertical slice: reading a spec, preparing the fixtures, the agent loop, browser actions, verifications, a durable journal, the live interface, the report and CI execution.

Include a configurable real model adapter, as well as a deterministic scripted adapter to test the harness without an external call. The report must explicitly identify the adapter used. A test with the scripted adapter does not constitute a validation of a model's ability to navigate.

Defer past the MVP: open exploration, compiling the text into assertion code, generating permanent Playwright tests, agent-browser/Playwright CLI drivers, distributed execution, several browsers, multi-agent, dashboard user accounts and resuming a browser session after a crash. Evaluating textual expectations is very much part of the MVP.

## 4. Scenario format

Reference example:

```markdown
---
version: 1
id: project-create
tags: [smoke, projects]
fixture: authenticated-workspace
timeout: 90s
maxActions: 25
inputs:
  projectName: "Project {{ run.id }}"
verification: |
  - The project {{ projectName }} appears in the list after creation.
  - The project is still present after reloading the page.
  - The list contains exactly one project with that name after the reload.
---

# Create a project

From the home page, create a project named {{ projectName }}
in the current workspace.

Use the journey offered to a standard user.

The expected results are described in verification.
```

### Parsing rules

- `version` and `id` are mandatory. The Markdown body must be non-empty.
- `tags`, `inputs`, `fixture`, `timeout`, `maxActions` and `checks` are optional. Execution parameters that are absent inherit from the project configuration.
- The expectations must be present in the `verification` field as a string, or in a `## Expected results` Markdown section. Reject the presence of both sources to avoid any ambiguity. No `verification.profile` is required or supported in this contract.
- Within the expectations, a top-level Markdown list defines one criterion per item; a paragraph with no list constitutes a single global criterion. Assign stable identifiers in the contract (`c1`, `c2`…) and preserve the texts, the order and the source positions. Structural validation makes no model call and invents no expectation.
- Reject unknown fields, duplicate YAML keys, duplicate scenario identifiers and unsupported versions.
- Use a YAML parser in data mode, with no executable tags, with size and alias limits.
- `timeout`, when supplied, must be a recognised positive duration; `maxActions`, when supplied, a strictly positive integer describing an indicative threshold.
- The names of the fixtures and of any TS checks resolve in project registries. They are never interpreted as code nor as free-form import paths.
- Errors must name the file, the field and, where possible, the line concerned.
- Keep the original text and the normalised contract in the artifacts.

### Inputs: the scenario's data

`inputs` declares the non-sensitive values the scenario uses: a project name, a search, a quantity, a product code or a demonstration role. They are optional: a scenario can simply write its values into its text. They avoid repetition and make it possible to run the same scenario with other data.

Example: `projectName: "Project {{ run.id }}"` supplies a unique name to use in the actions and the expectations. `run.id` and `attempt.id` are created by the harness, never asked of the user.

Accept scalar inputs in the MVP (string, number, boolean), serialised deterministically into the text. Allow default values in the configuration and overrides with `--input key=value` (string) or `--inputs-file <json>` (typed values). Precedence: configuration < spec < JSON file < CLI options. Reject CLI/file keys not declared in the configuration or the spec.

Implement data substitutions only, with no expression engine: `{{ run.id }}`, `{{ attempt.id }}`, the keys declared in `inputs` and, if a fixture exists, its public values under `{{ fixture.<key> }}`. Resolve the inputs first with the reserved variables, prepare the fixture with those inputs, then substitute the body and the expectations with the resolved inputs and the fixture's public values. Inputs cannot depend on fixture outputs; reject absent variables and cyclic dependencies. Do not recursively interpret arbitrary values.

Secrets are supplied to the fixtures through environment configuration. They must not become ordinary inputs nor appear in prompts or reports.

### Textual verifications and the frozen contract

The original text of the expectations is the contract. It is frozen and identified before navigation, after interpolation. The browser agent cannot modify it. It can request evidence collection through `check`, but it does not choose the verdict.

The `Verifier` service evaluates each criterion from the text and the raw timestamped observations. For the textual mode, use a dedicated model call with a context distinct from the navigation conversation; the same provider and model may be used. This is not a concurrent multi-agent system. The verifier receives the useful evidence and the criterion, not just the browser agent's summary.

The structured response contains `criterionId`, state, expected, observed, evidence references and any limitations. The harness verifies the schema, the existence of the references and their membership in the attempt. It aggregates the results without letting the browser rewrite them. A criterion without sufficient evidence stays `inconclusive`; vague wording must not be turned into an invented threshold.

The structural control of the references does not guarantee that the model's semantic judgement is correct. Identify `method: model` in the report. A textual evaluation is probabilistic and can produce false positives or negatives; do not present it as a deterministic assertion.

Where necessary, an author can add an optional `checks: { c3: project-unique-in-storage }` mapping. The name references a trusted TS check, associated with that criterion, which collects and verifies a business invariant. Its result is authoritative for that criterion and is marked `method: code`. No TS check is required for an ordinary scenario. Include the criterion's text in the check's contract or verify its hash so that reordering the expectations does not silently rebind the check to another criterion.

### Fixture: preparation and cleanup

A fixture is a reusable TS support function, registered in `harness.config.ts`, that the harness executes before the scenario. For example, `authenticated-workspace` creates an isolated workspace, prepares a signed-in user, then hands its session state to the browser. It can use a seed API or the project's test tooling; it is not decided by the agent.

Its contract provides the attempt identifiers, the resolved inputs and access to the secrets, then exposes separately some public values (for example `workspaceName`), a private browser state (for example `storageState`) and a scope-managed cleanup. The cleanup is registered as soon as each resource is acquired, to cover a partially failed preparation.

Without a `fixture`, open a blank browser context at the configured URL. The scenario can then test the login from the interface. With a signed-in fixture, it tests the business journey directly. Do not prepare in advance the very behaviour under test.

After success, failure or cancellation, clean up the attempt's resources with a bounded delay. Shared accounts or tenants do not constitute data isolation: use per-attempt resources as soon as a scenario modifies the application.

## 5. Architecture and organisation

Prefer a compact workspace:

```text
apps/
  cli/                   # Commands, local server and layer assembly
  ui/                    # React live tracking
packages/
  core/                  # Schemas, runner, services, policy and events
  browser-playwright/    # Browser driver and evidence acquisition
  agent-runtime/         # Agent loop, model adapter, scripted adapter
  reporting/             # JSON, JUnit and standalone HTML
examples/
  fixture-app/           # Demonstration application and injectable defects
  scenarios/             # Markdown specs
  support/               # Optional demonstration fixtures and TS checks
docs/
```

The names may evolve if that simplifies the repository. Avoid multiplying packages for tiny modules. The core must depend neither on React nor on the details of a model provider.

### Effect services

| Service | Responsibility |
| --- | --- |
| `SpecLoader` | Read, parse, normalise and validate the specs |
| `FixtureManager` | Prepare and clean up the data and the authentication |
| `AgentRuntime` | Obtain a next structured action from the model |
| `BrowserDriver` | Observe the browser and execute the permitted actions |
| `Verifier` | Evaluate the textual expectations or optional TS checks from the evidence |
| `RunStore` | Persist the manifest, the events, the results and the artifacts |
| `Reporter` | Produce the JSON, JUnit and HTML exports |

Use `Context.Service` and explicit layers in accordance with the installed Effect v4 version. Use scopes for resources, typed errors, structured concurrency and bounded timeouts.

Use the Node.js platform services compatible with the chosen Effect v4 version. Under the announced Node.js versions, verify the Playwright launch, the signals, the files, SSE and video finalisation. Do not introduce a dependency on an alternative runtime.

Promise SDKs must be wrapped with error translation. Interrupting an Effect does not guarantee cancellation of an underlying Promise: use the available cancellation mechanisms and close the resources to prevent late actions.

## 6. Execution loop

Expected order:

1. Validate the spec, the configuration, the registries and the required capabilities.
2. Create the run and attempt identifiers, then persist the initial manifest.
3. Prepare the optional fixture, resolve and freeze the expectations, then open an isolated browser context.
4. Start the captures, the console and network logs before the scenario's actions.
5. Give the agent the resolved scenario, the criteria, the tools, the indicative action threshold and the explicitly configured blocking budgets.
6. Observe, request a structured action, validate its policy, journal its start, execute it then journal its result.
7. Collect the evidence at the requested checkpoints and at the end; the `Verifier` evaluates the criteria through a dedicated model call or an optional TS check.
8. Compute the result from the criteria and the execution state.
9. Finalise the evidence, close the browser, clean up the fixtures and produce the reports.

A `finish` request from the model triggers the final verification; it is never enough on its own to declare success.

Plan for evidence at different moments: a persistence criterion needs an observation before and after the reload. The browser agent can carry out those steps and request a `check`. If the evidence is missing, the verifier returns a structured evidence request; the runner can continue navigating within the available budgets, without modifying the expectation. Any TS checks can perform controlled probes, all journalled as harness operations.

## 7. Tools and limits of the agent

Minimum tools: `observe`, `click`, `fill`, `press`, `scroll`, `screenshot`, `check` and `finish`. Add an explicit navigation if needed, subject to the origins policy.

- Each tool's arguments and results are validated by Schema.
- `observe` returns a compact representation of the page, its URL, an `observationId` and usable element references.
- A targeted action carries the `observationId` and the element reference. Reject stale or ambiguous references and request a new observation.
- Prefer roles, accessible names and stable locators. Do not expose the Playwright `Page` object to the model.
- `check` references an existing textual criterion and triggers its collection/evaluation; the browser agent cannot supply its own verdict.
- The application's content is observed data, never an instruction authorising new tools or a change of scenario.
- Record a short action intent if the model supplies one; do not ask for detailed internal reasoning.

`maxActions` is an indicative threshold, despite the name kept at the user's request. Count the agent's browser tool calls accepted for execution, including observations, captures and failed attempts; count model calls and verification operations separately. On the first time it is exceeded, emit `actionGuidanceExceeded`, display "28 actions / 25 suggested" and invite the agent to briefly reassess its approach. The run continues: no action is refused, no status is downgraded and no approval is required on that ground alone. A success in 40 actions stays `passed`. Do not introduce a hidden blocking limit derived from that threshold.

The blocking guard rails are distinct, explicit and configurable: global attempt timeout, per-operation timeout, maximum model calls and token budget. Include the verifier's calls in the consumption and reserve a margin for the final evaluation. Document the default values and display the resolved configuration before launch. Loop detection may emit an insufficient-progress signal; it does not turn exceeding `maxActions` into a forced stop.

The navigation origins and any permitted third-party services are defined in the harness configuration. A URL check at tool level is not full network isolation: document that limitation and use a controlled CI environment.

Never automatically repeat a mutating action on a mere timeout: a creation may have succeeded even if its response was lost. Verify the state before any retry. Transport retries must be bounded and reserved for the operations they are appropriate for.

## 8. Model and configuration

Define a provider interface that makes it possible to request a structured response with tools, to receive the available consumption information and to cancel a call when the provider allows it.

Implement a real adapter for a provider that has those capabilities. Choose and document that provider according to the SDKs and access available at initialisation time; do not freeze a model name into the business code. The provider, the model and the options are configurable.

The keys stay in environment variables. Supply a `.env.example` with no sensitive value. If no key is available, finish and test the slice with the scripted adapter, then state precisely the command that allows the real smoke test. Do not present that smoke test as having been carried out.

The project configuration `harness.config.ts` carries, among other things: `include`/`exclude` discovery, the base URL, the permitted origins, the default inputs, the optional fixtures and checks, the provider/model, the indicative action threshold, the blocking budgets, the capture policy and the results directory. Export a typed `defineConfig` helper. Load that TS module as trusted project code, never from an arbitrary name contained in a spec. Do not force the creation of a support registry if the scenario uses only text.

Persist the resolved non-sensitive parameters, the versions of the main dependencies, the model's identity, the hash of the prompts, of the spec and of the contract. Frozen parameters improve traceability without making an LLM deterministic.

## 9. Results and verifications

An attempt's result is a discriminated union:

| Status | Meaning |
| --- | --- |
| `passed` | Every mandatory criterion was verified with the required evidence |
| `failed` | An observation contradicts a mandatory product criterion |
| `inconclusive` | The evidence does not allow a conclusion, or a blocking budget is exhausted before a conclusion could be reached; exceeding `maxActions` is not a ground |
| `error` | Fixture, provider, browser, storage or infrastructure failure |
| `cancelled` | Explicit cancellation of the execution |

Each criterion has its own state: `pending`, `passed`, `failed`, `inconclusive` or `error`, as well as its method, `model` or `code`. A run can keep a failed criterion even if an infrastructure error occurs afterwards. Do not lose that information in the aggregated status. In the internal tests, also identify the scripted verifier's responses so as not to confuse them with a real model judgement.

MVP aggregation policy: explicit cancellation → `cancelled`; otherwise a blocking execution or mandatory-evidence error → `error`; otherwise a failed mandatory criterion → `failed`; otherwise an unresolved criterion → `inconclusive`; otherwise `passed`.

Separate in the reports: factual observations, textual expectations, evaluations and diagnostic hypotheses. The evaluating model may produce a supported semantic verdict, but the browser agent cannot modify it. The harness validates the structure and aggregates the results; it does not claim to make the evaluation of the text deterministic.

A missing locator after uncertain navigation generally produces `inconclusive`. An established absence at the checkpoint a criterion provides for can produce `failed`. Implement that difference explicitly.

## 10. Journal and artifacts

Target structure:

```text
runs/<run-id>/
  manifest.json
  spec.e2e.md
  contract.json
  events.jsonl
  result.json
  report.html
  junit.xml
  attempts/<attempt-id>/
    trace.zip
    screenshots/
    video.webm
    console.jsonl
    network.jsonl
```

Optional files that are absent are flagged in an artifact inventory with their state and the reason. A capture failure must never be concealed.

Every event has: `schemaVersion`, `runId`, `attemptId` where applicable, a `seq` increasing per run, a UTC timestamp, a monotonic duration where relevant, a type and a typed payload. Action events carry an `actionId`; verifications carry a `criterionId`; evidence is linked by `artifactId` and, where possible, by event number.

Minimum events: start, fixture ready where applicable, observation obtained, model call started/finished with the browser or verifier role, action started/finished, evidence request, verification finished, artifact available, `actionGuidanceExceeded`, blocking budget exhausted, error, cancellation requested and run finished.

The append-only journal is written before the live broadcast. Serialise the writes to maintain the order. Write the result files by atomic replacement. When reloading an interrupted run, tolerate a last incomplete JSONL line and signal that the execution was not finalised.

Record the trace from the first attempt, then apply the retention policy at the end. Playwright's `context.tracing` API does not automatically contain the harness's assertions: they must remain present in our journal and correlated with the verification actions.

The video is configurable and complementary. It must be finalised after the context is closed. Captures at the checkpoints and on failure take priority. The MVP's live view may display the last capture; a continuous screencast is not required.

The textual logs must exclude the known secrets. The traces, videos and DOM can contain sensitive data: use synthetic fixtures for the demonstration, document the retention and do not promise complete anonymisation of those formats.

## 11. Live interface and report

The interface must display:

- The scenario, its status, the current run and attempt.
- The success criteria and their states.
- The last capture, with its timestamp and its associated action.
- A timeline of the actions, observations, verifications and errors.
- The blocking budgets consumed and remaining, and separately the number of actions compared to the indicative threshold; cost only if computable, otherwise "unavailable".
- The evidence and the links to the available artifacts.
- A working cancel command.

Use SSE for the events, with resumption from a cursor/`Last-Event-ID` and replay from the journal. A reconnection must neither lose nor duplicate the displayed events. Bound the queues of slow clients without blocking the runner; the replay allows the events to be caught up.

The local server listens on loopback by default. No connection to the dashboard must be necessary for a run to progress. CI can work with no UI server.

The HTML report must open offline and display the verdict, the criteria, the facts, the timeline and the evidence references. Embed the summary and the data needed into the HTML; keep the large artifacts as relative files. Opening `trace.zip` in the Playwright Trace Viewer may remain a documented external action.

Escape the content coming from the scenario, the model, the pages and the logs. The MVP does not offer manual takeover of the browser.

## 12. CLI and CI

The CLI is the product's main interface. It must work from any consumer project after installation as a development dependency, without cloning the harness repository and without writing an orchestration script. The dashboard is an option of the runner.

Distribute a package containing a compiled JavaScript executable declared in `bin`, its Node.js shebang (`#!/usr/bin/env node`), its necessary dependencies and the UI/report assets. Supply the TypeScript declarations of the public APIs, notably `defineConfig`. Resolve those assets from the installed package and the specs/configurations from the consumer project. Do not depend on development workspace paths. Prepare the package and test it through a local archive; do not publish it.

Explicitly plan for loading `harness.config.ts` and the TS support modules under the supported Node.js versions: use a documented loading/transpilation mechanism whose dependencies are included at runtime. Do not assume that Node.js natively executes every TypeScript syntax, nor ask the consumer to install a global loader. Document the package's module format and test its use from ESM and CommonJS consumer projects; an ESM-compiled CLI is acceptable without imposing conversion on the consumer project.

Command contract to implement:

```text
harness [file-or-dir-or-glob...]
harness run [file-or-dir-or-glob...]
harness list [--tag smoke]
harness validate [file-or-dir-or-glob...]
harness report <run-directory>
harness --help
harness --version
```

`harness` alone is an alias of `harness run`: discovery of the `**/*.e2e.md`, exclusion of the dependencies and results, a single execution then exit. Honour `include`/`exclude` and the globs passed as arguments, including when they are quoted. Sort the specs to obtain a stable order. No automatic watch and no interactive prompt required in CI. A watch mode may be added after the MVP.

Minimum options for `run`: `--config`, `--tag`, repeatable `--input key=value`, `--inputs-file`, repeatable `--reporter` (`console`, `json`, `junit`), `--output`, `--ui`, `--provider`. Do not reinvent argument parsing if a Node.js/Effect-compatible library is suitable. The CLI execution options take precedence over the configuration; document the precedence.

In a consumer project, the target usage after installing the package is:

```json
{
  "scripts": {
    "test:e2e": "harness run",
    "test:e2e:ui": "harness run --ui"
  }
}
```

```sh
npm run test:e2e
npm run test:e2e -- --tag smoke
npx --no-install harness run tests/e2e
pnpm exec harness run tests/e2e
```

These commands assume the package is already installed locally as a development dependency. Adapt the name to the binary actually distributed. The npx example disables implicit installation to avoid executing an unverified public package of the same name. Also supply the equivalent installation and execution commands for npm, pnpm and Yarn in the README.

`validate` and `list` start neither a model nor a browser. `validate` checks the references of known variables without requiring the existence of fixture public values before setup, then validates those values after setup during `run`. `run` works with no interface by default. `report` rebuilds the HTML from the persisted data without replaying the scenario.

The console reporter must supply the scenarios' names, their states, durations, indicative thresholds exceeded, a global summary and the report's path. In non-TTY output, produce stable text with no animation. The JSON reporter mode must keep stdout machine-usable and send the technical diagnostics to stderr.

Exit codes: `0` if every selected scenario passes; `1` for a `failed` or `inconclusive` result; `2` for an invalid configuration or an execution error; `130` for a user interrupt. No spec selected must be an explicit error, never a silent success.

JUnit export: failed product criteria as failures; technical errors and indeterminate results as errors, with the real status preserved in the message and in the JSON. Document the treatment of cancellations. Do not turn an indeterminate result into a green skipped.

Supply a demonstration GitHub Actions workflow that installs the fixed Node.js and pnpm versions, then runs `pnpm install --frozen-lockfile`, the typecheck, the harness's tests and scenarios with the scripted adapter through the distributed CLI. Use Vitest for the project's internal tests; the harness keeps its own scenario runner and its own CLI. Install Chromium and its Linux dependencies with the project's Playwright version and verify the real journey under Node.js. Document any external system dependency needed. Publish the artifacts even after a failure, as far as the CI runner allows.

A real-model job must be optional, explicitly enabled and fed by CI secrets; it must not be required in order to contribute to the harness. No automatic scenario retry in the MVP. Prepare the attempt identifiers without prematurely implementing that feature.

## 13. Demonstration and meaningful tests

Build a small demonstration application with server-side persisted data, an isolated workspace and a project creation form. The demonstration authentication can be prepared by a fixture; the scenario does not test the login.

The demonstration scenario expresses its expectations in text: presence before the reload, presence after the reload and a single project of that name visible in the list. It must work without a `profile` and without a TS check. The exhaustiveness of the uniqueness evidence depends on the list (filtering, pagination); the model must not infer global uniqueness from a partial view.

Add a distinct advanced example with an optional TS check demonstrating exactly one persisted creation for the attempt's identifier. That evidence may use a server probe reserved for the check, documented as such. The browser agent has no access to that probe. Do not impose that extension on the base textual scenario.

Provide four reproducible variants:

1. Healthy application: the scenario passes.
2. Creation refused with an HTTP 500 response: the creation criterion fails with network evidence and UI state.
3. False visual success: the project appears locally but disappears after the reload; the persistence criterion fails.
4. Modified layout with the same functional possibilities: the journey remains achievable. That variant serves in particular to assess the real model's robustness when it is available.

Also test the harness's risky behaviours:

- An invalid spec rejected before the browser is launched.
- `finish` requested prematurely with no false positive.
- A mandatory criterion left unevaluated forbidding `passed`.
- A stale reference rejected without clicking on another element.
- Exceeding `maxActions` emitting a single warning and letting a longer journey succeed, with no tool refusal and no verdict downgrade.
- A distinct blocking budget being reached ending the loop, with no late requests or actions.
- Textual verification with no TS profile, with evidence belonging to the run; missing evidence or invented references never yielding `passed`.
- An omitted fixture working with a blank context; a fixture that is present prepared and cleaned up after success, failure or cancellation.
- Inputs overridden following the documented precedence, absent variables rejected and secrets not injected into the model.
- A cancellation with the resources closed and the available evidence retained.
- A failure to save a mandatory piece of evidence preventing a silent success.
- An SSE disconnection then reconnection with ordered resumption.
- The JUnit export and the exit codes preserving the product/infrastructure/indeterminate distinction.
- A report rebuilt without a model call.
- The package built then installed with npm in a temporary consumer directory outside the workspace: discovery, TS config, package.json scripts, the binary, the report assets and the exit codes work with no hidden transitive development dependencies. Also verify the pnpm and Yarn invocations, as well as loading the configurations from ESM and CommonJS projects.

Use the scripted adapter to test the harness's decisions reproducibly, with real Playwright calls against the demonstration application. Also supply scripted verifier responses to verify the contracts and the missing-evidence cases. Those tests do not validate the semantic quality of a real model: add an optional real smoke test on the variants and report its result separately. Reserve the unit assertions for the useful contracts and invariants. Do not write tests that merely copy out the implementation.

## 14. Implementation order

1. Initialise the workspace, the versions, TypeScript, the scripts and the schemas.
2. Implement spec validation, the registries and the configuration.
3. Build the fixture-app, the Playwright driver and the evidence-based textual verification contract.
4. Execute a complete slice with the scripted adapter, the journal and the JSON result.
5. Add the captures, the trace, the HTML report and JUnit.
6. Implement the real adapter, the dedicated textual evaluation and the model/tools loop with the indicative threshold and the blocking budgets kept separate.
7. Add the SSE server, the live interface and cancellation.
8. Build the CLI package, test it from a consumer project, verify the defective variants and the CI outputs, then document the usage.

Keep the repository executable between those steps. If an announced dependency does not exist or if an API has changed, check its official documentation, adapt the code and record the decision. Do not invent a library method.

## 15. Definition of done

The project is initialised when:

- An installation from a clean checkout follows the README with exact commands.
- Node.js is the verified runtime of the runner, the CLI and the live server, with an explicit range of supported versions.
- The CLI package is usable as a development dependency in a third-party project, with discovery and package.json scripts, without cloning the harness.
- The typecheck, the relevant tests and the demonstration workflow pass.
- A Markdown/YAML spec produces a complete run on the fixture-app.
- The standard journey uses text verifications, with no mandatory TS profile; inputs and fixture are genuinely optional.
- A run that exceeds `maxActions` can succeed and keeps its normal verdict.
- The healthy, HTTP 500 and false-success variants have the expected results, backed by evidence.
- A readable report explains precisely which criterion was contradicted and references its artifacts.
- The live interface follows an execution and can cancel it cleanly.
- No model provider and no secret is necessary for the project's reproducible tests.
- A real model adapter is implemented, with a smoke test procedure; its actual execution is reported honestly according to the available access.
- The known limitations and the decisions are described in `docs/architecture.md`.

In the implementation agent's final answer, supply the launch commands, the paths of the important files, the verifications actually carried out, an example of a run directory and any points that remain blocked. Do not claim that a test has been run if it has not.

## 16. Technical references

The capabilities below were consulted during the scoping of 11 September 2026. Verify the APIs of the installed version during implementation.

- [Effect v4 and publication status](https://effect.website/)
- [Effect v4 services migration](https://github.com/Effect-TS/effect/blob/main/migration/services.md)
- [Playwright trace API and the limitation regarding assertions](https://playwright.dev/docs/api/class-tracing)
- [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer)
- [Playwright in CI](https://playwright.dev/docs/ci)
- [Playwright CLI for agents, future option](https://playwright.dev/docs/getting-started-cli)
- [agent-browser dashboard, future option](https://agent-browser.dev/dashboard)
- [agent-browser video](https://agent-browser.dev/recording)
