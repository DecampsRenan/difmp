---
version: 1
id: project-create-no-fixture
tags: [projects, login]
timeout: 120s
maxActions: 35
verification: |
  - Après connexion, la page d'accueil affiche le nom de l'espace de travail de l'utilisateur connecté.
  - Un projet nommé Projet sans fixture apparaît dans la liste des projets après sa création.
  - Ce projet est toujours présent dans la liste après un rechargement complet de la page.
---

# Se connecter depuis l'interface, puis créer un projet

Ce scénario ne déclare ni `fixture` ni `inputs` : les deux sont facultatifs. Le harness ouvre donc un
contexte navigateur vierge sur l'URL configurée, sans session préparée, et le scénario écrit
lui-même les valeurs dont il a besoin.

L'application affiche alors un formulaire de connexion. S'y connecter avec l'adresse
demo@example.test et le mot de passe demo-password. Ce sont des données de démonstration synthétiques
de l'application d'exemple locale, créées explicitement avant le run ; ce ne sont pas des secrets, et
un secret ne s'écrirait jamais dans une spec.

Créer ensuite un projet nommé Projet sans fixture, puis recharger complètement la page.

Contrairement à `project-create`, ce scénario teste bien le login : c'est le seul cas où le préparer
d'avance reviendrait à ne pas tester ce qui est examiné.

Les résultats attendus sont décrits dans verification.
