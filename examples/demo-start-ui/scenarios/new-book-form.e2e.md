---
version: 1
id: new-book-form
tags: [smoke, forms, demo-start-ui]
timeout: 240s
maxActions: 80
verification: |
  - The New Book form page is open (New Book heading).
  - The form exposes Title, Author, Genre, and Publisher fields.
---

# Open the New Book form without submitting

Sign in with the public **Demo mode** shortcuts (`admin` → **Login with email** → **000000**).

Open **Books**, then **New Book**. Inspect the create form. Confirm the main fields are present.

**Do not click Create** and do not fill the form: this battery must not write to the shared public
demo.

The expected results are described in verification.
