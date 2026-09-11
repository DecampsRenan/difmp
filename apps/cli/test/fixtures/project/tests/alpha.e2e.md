---
version: 1
id: alpha
tags: [smoke, fast]
inputs:
  projectName: from-spec
---

# Ouvrir la page d'accueil

Ouvrir l'application et observer la page d'accueil du projet {{ projectName }}.

## Résultats attendus

- Le projet {{ projectName }} est visible, source {{ fromConfigOnly }}, retries {{ retries }}.
