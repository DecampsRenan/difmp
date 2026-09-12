---
version: 1
id: custom-scripted-project-create
inputs:
  projectName: "Project {{ run.id }}"
verification: |
  - The created project appears in the project list.
---

# Create a project

Enter the project name, create it, and inspect the resulting list.
