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
  - The project {{ projectName }} appears in the project list after it is created.
  - The project {{ projectName }} is still present in the project list after a full page reload.
  - After that reload, the displayed list contains exactly one entry named {{ projectName }}. This expectation is only about what the list displays: it says nothing about what is stored server-side, and a filtered or paginated list is not enough to infer global uniqueness from it.
---

# Create a project

From the home page of the {{ fixture.workspaceName }} workspace, create a project named
{{ projectName }}.

Use the journey offered to a standard user.

Then reload the page to observe the state the application actually kept.

The expected results are described in verification.
