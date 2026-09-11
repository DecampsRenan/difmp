---
version: 1
id: invalid-unknown-frontmatter-field
retries: 3
verification: |
  - Le projet apparaît dans la liste après création.
---

# Champ de frontmatter inconnu

`retries` n'existe pas dans le contrat de frontmatter. Une clé inconnue est rejetée plutôt
qu'ignorée : sinon une faute de frappe sur `maxActions` passerait inaperçue.
