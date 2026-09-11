---
version: 1
id: invalid-duplicate-yaml-key
maxActions: 10
maxActions: 40
verification: |
  - Le projet apparaît dans la liste après création.
---

# Clé YAML dupliquée

`maxActions` est déclaré deux fois. Le parseur YAML fonctionne en mode données strict : la dernière
valeur ne gagne pas silencieusement, la spec est rejetée.
