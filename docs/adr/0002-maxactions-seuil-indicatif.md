# maxActions est un seuil indicatif, pas un garde bloquant

`maxActions` est conservé comme nom malgré son sens d'indicatif — misnomer assumé — car il fait partie de l'API publique (`difmp.config.ts` et frontmatter), et il reste un **seuil indicatif** au sens du groupe Budgets : le dépasser émet un signal de réévaluation (« 28 actions / 25 suggérées »), ne refuse aucune action, ne downgrade aucun statut, ne demande aucune approbation ; un succès en 40 actions reste `passed`. C'est un trade-off entre autonomie de l'agent et contrôle des coûts : les gardes qui comptent vraiment sont explicites et configurables ailleurs (timeout d'attempt, timeout par opération, max d'appels modèle, budget de tokens), et il est délibérément interdit d'introduire une limite bloquante cachée dérivée de `maxActions`.

## Consequences

Dans les rapports, « budget épuisé » (`inconclusif`) ne désigne jamais ce seuil. Le compteur d'actions inclut observations, captures et tentatives échouées, et se compte séparément des appels modèle.
