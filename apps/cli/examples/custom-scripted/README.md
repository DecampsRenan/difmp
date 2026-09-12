# Custom scripted walkthrough

This is a complete consumer-side example shipped with `difmp`. It imports the public authoring API
from `difmp/scripted`; no private workspace package or repository checkout is required.

Copy `custom-script.ts` beside your `difmp.config.ts`, register its factory under `scripts`, and
select it with `providerOptions.script`. The scripted provider is a deterministic test double for
testing the harness and your fixed journey; its verdict is never presented as a real model judgment.
