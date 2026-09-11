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
  - Le projet {{ projectName }} apparaît dans la liste des projets après sa création.
  - Le projet {{ projectName }} est toujours présent dans la liste des projets après un rechargement complet de la page.
  - Après ce rechargement, la liste affichée ne contient qu'une seule entrée portant le nom {{ projectName }}. Cette attente porte uniquement sur ce que la liste affiche : elle ne dit rien de ce qui est enregistré côté serveur, et une liste filtrée ou paginée ne permet pas d'en déduire une unicité globale.
---

# Créer un projet

Depuis l'accueil de l'espace de travail {{ fixture.workspaceName }}, créer un projet nommé
{{ projectName }}.

Utiliser le parcours proposé à un utilisateur standard.

Recharger ensuite la page pour observer l'état réellement conservé par l'application.

Les résultats attendus sont décrits dans verification.
