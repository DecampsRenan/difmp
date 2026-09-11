---
version: 1
id: project-create-checked
tags: [projects, invariant]
fixture: authenticated-workspace
timeout: 90s
maxActions: 25
inputs:
  projectName: "Projet {{ run.id }}"
checks:
  c3: project-unique-in-storage
verification: |
  - Le projet {{ projectName }} apparaît dans la liste des projets après sa création.
  - Le projet {{ projectName }} est toujours présent dans la liste des projets après un rechargement complet de la page.
  - Exactement un projet nommé {{ projectName }} a été enregistré côté serveur pour cette tentative.
---

# Créer un projet, avec un invariant vérifié par un check TS

Variante avancée de `project-create`. Le parcours est identique : depuis l'accueil de l'espace de
travail {{ fixture.workspaceName }}, créer un projet nommé {{ projectName }}, puis recharger la page.

La différence est dans l'évaluation des attentes. Les deux premières restent textuelles : elles sont
jugées à partir des preuves collectées, et cette évaluation est probabiliste. La troisième est
associée, via `checks`, au check TS `project-unique-in-storage` : son verdict fait autorité et il est
rapporté avec `method: code`.

Ce check interroge une sonde serveur réservée, qui n'est pas exposée à l'agent navigateur. Il établit
donc quelque chose que la liste affichée ne peut pas établir : le nombre de projets réellement
persistés sous ce nom, indépendamment du filtrage et de la pagination de l'interface.

Un scénario ordinaire n'a pas besoin de cette extension ; `project-create` s'en passe.

Les résultats attendus sont décrits dans verification.
