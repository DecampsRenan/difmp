---
version: 1
id: project-create
tags: [smoke, projects]
fixture: authenticated-workspace
timeout: 90s
maxActions: 25
inputs:
  projectName: "Projet {{ run.id }}"
verification: |
  - Le projet {{ projectName }} apparaît dans la liste après création.
  - Le projet reste présent après rechargement de la page.
  - La liste contient exactement un projet portant ce nom après rechargement.
---

# Créer un projet

Depuis l'accueil, créer un projet nommé {{ projectName }}
dans l'espace de travail courant.

Utiliser le parcours proposé à un utilisateur standard.

Les résultats attendus sont décrits dans verification.
