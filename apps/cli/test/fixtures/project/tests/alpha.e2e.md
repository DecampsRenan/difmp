---
version: 1
id: alpha
tags: [smoke, fast]
inputs:
  projectName: from-spec
---

# Open the home page

Open the application and observe the home page of project {{ projectName }}.

## Expected results

- The project {{ projectName }} is visible, source {{ fromConfigOnly }}, retries {{ retries }}.
