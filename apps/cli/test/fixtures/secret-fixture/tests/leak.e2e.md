---
version: 1
id: secret-leak
fixture: leaky
verification: |
  - The page shows {{ fixture.harmless }} and the value {{ fixture.leaked }}.
---

Open the page and observe {{ fixture.leaked }}.
