# Séparation agent navigateur / vérificateur

Dans un run difmp, l'évaluateur qui juge les critères à méthode `model` — le vérificateur — ne doit jamais être le même modèle que l'agent navigateur qui a agi sur la page : le harnais impose deux cerveaux distincts, et on préférera un modèle dédié à la vérification (par exemple un modèle de type Jev). C'est un trade-off délibéré : on accepte le surcoût — un modèle de plus, des tokens de vérificateur comptés à part dans le budget, avec une réserve bloquée pour l'évaluation finale — pour garantir l'intégrité du jugement. L'agent qui a agi ne doit pas juger sa propre exécution.

## Considered Options

- Un seul modèle qui agit puis se juge : économique, mais le modèle reste juge partial de son propre travail.
- L'agent navigateur écrivant lui-même les verdicts : rejeté par conception — le harnais ne le permet pas ; l'agent peut seulement demander une re-vérification.
