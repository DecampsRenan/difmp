---
version: 1
id: manager-nav
tags: [smoke, navigation, demo-start-ui]
timeout: 240s
maxActions: 80
verification: |
  - After opening Books from the sidebar, the Books page heading is visible.
  - After opening Users from the sidebar, the Users page heading is visible.
  - After returning to Dashboard from the sidebar, the Dashboard page heading is visible.
---

# Walk the manager sidebar

Sign in with the public **Demo mode** shortcuts (`admin` → **Login with email** → **000000**).

From the manager chrome, open **Books**, then **Users**, then **Dashboard** again using the
sidebar links. Confirm each section's main heading appears. Do not mutate records.

The expected results are described in verification.
