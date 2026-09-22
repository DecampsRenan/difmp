---
version: 1
id: login-admin
tags: [smoke, login, demo-start-ui]
timeout: 180s
maxActions: 60
verification: |
  - After completing the demo login, the manager Dashboard page is visible (heading Dashboard and Welcome to Start UI content).
  - The signed-in chrome shows an account control for the demo admin user.
---

# Sign in with the public demo admin account

Open https://demo.start-ui.com (or the configured base URL). The site shows a login form with a
**Demo mode** hint.

Use the on-page demo shortcuts — do not invent credentials:

1. Click **admin** (fills the email with the public demo address).
2. Click **Login with email**.
3. On the verification page, click **000000** (the public demo OTP; it confirms the code).

You should land on the manager dashboard.

These shortcuts are public demo fixtures published on the site itself, not secrets.

The expected results are described in verification.
