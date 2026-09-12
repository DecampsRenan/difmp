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
  - The project {{ projectName }} appears in the list after it is created.
  - The project is still present after the page is reloaded.
  - The list contains exactly one project with that name after the reload.
---

# Create a project

From the home page, create a project named {{ projectName }}
in the current workspace.

Use the journey offered to a standard user.

The expected results are described in verification.
