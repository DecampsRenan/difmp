---
version: 1
id: books-search
tags: [smoke, books, search, demo-start-ui]
timeout: 240s
maxActions: 80
verification: |
  - The Books manager page is open (Books heading and a Search field).
  - After searching for Dracula, the filtered list includes a book titled Dracula.
---

# Search the seeded books list

Sign in with the public **Demo mode** shortcuts on the login page (`admin`, then **Login with
email**, then **000000**).

Open **Books** from the manager sidebar. In the **Search...** field, search for `Dracula` — a
title present in the demo's seeded catalog.

Wait for the filtered results. Do not create, edit, or delete books: this scenario is read-only
against the shared public demo.

The expected results are described in verification.
