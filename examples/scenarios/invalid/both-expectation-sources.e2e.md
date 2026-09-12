---
version: 1
id: invalid-both-expectation-sources
verification: |
  - The project appears in the list after it is created.
---

# Two expectation sources

This spec declares its expectations TWICE: in the `verification` field and in a Markdown section.
The loader must reject it, because nothing makes it possible to decide which one is the contract.

## Expected results

- The project appears in the list after it is created.
