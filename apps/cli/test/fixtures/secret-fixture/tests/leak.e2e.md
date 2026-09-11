---
version: 1
id: secret-leak
fixture: leaky
verification: |
  - La page affiche {{ fixture.harmless }} et la valeur {{ fixture.leaked }}.
---

Ouvrir la page et constater {{ fixture.leaked }}.
