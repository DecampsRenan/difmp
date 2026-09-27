# Une seule loi d'adjudication, deux points d'application

Les règles qui transforment une proposition d'évaluateur en verdict consigné (intégrité de la preuve, branche d'absence, persistance des preuves obligatoires, admission monotone) vivaient en deux exemplaires prose-à-prose : `policy/` côté harnais, `verifier/validate.ts` côté agent-runtime, avec l'ordre de la chaîne tenu par un commentaire dans le runner — et deux formulations qui avaient déjà dérivé (« no usable evidence… » vs « no evidence… »). La loi est désormais unique, dans `packages/core/src/policy/adjudicate.ts` : `adjudicate(...)` est le passage de consignation (sur l'inventaire re-lu après l'évaluation), `screenProposal(...)` le passage de screening (sur le snapshot de preuve pris avant la question), tous deux composés des mêmes primitives et des mêmes chaînes de refus. La double application — un temps revendue comme redondance « délibérément » dupliquée — est conservée par conception : un bug dans un passage ne peut plus monnayer un faux `passed` parce que l'autre passage décide, et ce n'est plus deux lois mais une loi croisée sur deux jeux de preuves. Seul le passage de consignation fait autorité.

## Considered Options

- Déplacer seulement la chaîne du runner dans `policy/` : la loi aurait un propriétaire, mais les copies croisées et leur dérive silencieuse seraient restées.
- Single-point enforcement (supprimer le screening, ne garder que la consignation) : interface plus petite, mais on perdrait un garde délibéré documenté — et le screening alimente la boucle « needs more evidence » de l'agent.
- Fusionner le vérificateur dans le runner : rejeté — l'autorité propre à l'évaluateur (`criterionId` attendu, `expected` gelé, `missingEvidence`) n'a rien à faire dans le runner, et la redondance des deux passages est précisément ce qui crédibilise l'audit (ADR-0003).

## Consequences

Ajouter un `DowngradeReason` se fait à un seul endroit ; les deux passages parlent la même voix par construction, et la table de messages canoniques vit dans `packages/core/test/adjudicate.test.ts`. Le vérificateur ne reçoit plus que ce qu'il lit (`maxEvidenceRequests`) : les champs `checks` / `recordEvidence` / `runId`, acceptés et ignorés depuis que le runner possède le chemin `code`, sont supprimés, ainsi que la closure morte que le CLI continuait de construire pour les nourrir.
