---
version: 1
id: invalid-both-expectation-sources
verification: |
  - Le projet apparaît dans la liste après création.
---

# Deux sources d'attentes

Cette spec déclare ses attentes DEUX fois : dans le champ `verification` et dans une section
Markdown. Le loader doit la rejeter, parce que rien ne permet de décider laquelle est le contrat.

## Résultats attendus

- Le projet apparaît dans la liste après création.
