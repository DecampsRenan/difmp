---
version: 1
id: invalid-duplicate-yaml-key
maxActions: 10
maxActions: 40
verification: |
  - The project appears in the list after it is created.
---

# Duplicate YAML key

`maxActions` is declared twice. The YAML parser runs in strict data mode: the last value does not
silently win, the spec is rejected.
