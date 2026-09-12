---
version: 1
id: project-create-checked
tags: [projects, invariant]
fixture: authenticated-workspace
timeout: 90s
maxActions: 25
inputs:
  projectName: "Project {{ run.id }}"
checks:
  c3: project-unique-in-storage
verification: |
  - The project {{ projectName }} appears in the project list after it is created.
  - The project {{ projectName }} is still present in the project list after a full page reload.
  - Exactly one project named {{ projectName }} was recorded server-side for this attempt.
---

# Create a project, with an invariant verified by a TS check

Advanced variant of `project-create`. The journey is identical: from the home page of the
{{ fixture.workspaceName }} workspace, create a project named {{ projectName }}, then reload the
page.

The difference is in how the expectations are evaluated. The first two stay textual: they are judged
from the evidence collected, and that evaluation is probabilistic. The third is bound, through
`checks`, to the TS check `project-unique-in-storage`: its verdict is authoritative and is reported
with `method: code`.

That check queries a reserved server-side probe, which is not exposed to the browsing agent. It
therefore establishes something the displayed list cannot: how many projects were actually persisted
under that name, independently of the interface's filtering and pagination.

An ordinary scenario has no need for this extension; `project-create` does without it.

The expected results are described in verification.
