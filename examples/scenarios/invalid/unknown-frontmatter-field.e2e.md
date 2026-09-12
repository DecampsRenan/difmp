---
version: 1
id: invalid-unknown-frontmatter-field
retries: 3
verification: |
  - The project appears in the list after it is created.
---

# Unknown frontmatter field

`retries` does not exist in the frontmatter contract. An unknown key is rejected rather than
ignored: otherwise a typo on `maxActions` would go unnoticed.
