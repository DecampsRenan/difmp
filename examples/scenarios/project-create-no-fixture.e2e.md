---
version: 1
id: project-create-no-fixture
tags: [projects, login]
timeout: 120s
maxActions: 35
verification: |
  - After signing in, the home page displays the workspace name of the signed-in user.
  - A project named Project without fixture appears in the project list after it is created.
  - That project is still present in the list after a full page reload.
---

# Sign in through the interface, then create a project

This scenario declares neither `fixture` nor `inputs`: both are optional. The harness therefore
opens a blank browser context on the configured URL, with no prepared session, and the scenario
writes down the values it needs itself.

The application then shows a sign-in form. Sign in with the address demo@example.test and the
password demo-password. These are synthetic demonstration data belonging to the local example
application, created explicitly before the run; they are not secrets, and a secret would never be
written in a spec.

Then create a project named Project without fixture, and fully reload the page.

Unlike `project-create`, this scenario really does test the login: it is the one case where
preparing it in advance would amount to not testing what is under examination.

The expected results are described in verification.
