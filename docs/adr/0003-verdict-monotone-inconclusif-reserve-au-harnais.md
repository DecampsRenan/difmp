# Verdict monotone : l'inconclusif est réservé au harnais

Un verdict consigné par le harnais ne peut être remplacé par une réévaluation ultérieure que vers le pire — les re-vérifications sont conservées comme observations, jamais comme promotions — et le statut `inconclusif` reste la prérogative du harnais : l'évaluateur ne peut pas se déclarer lui-même incertain ni revendiquer de conclure sans preuve. Chaque refus du harnais sur un statut proposé est enregistré comme un downgrade avec sa raison (preuve rejetée, navigation incertaine, préservation de preuve échouée, verdict déjà décidé), afin qu'un rapport dise POURQUOI difmp a refusé de conclure, jamais un `inconclusif` nu. C'est un trade-off délibéré : on sacrifie l'autonomie de l'évaluateur — ni upgrader, ni s'auto-déclarer incertain sans trace — à la crédibilité du rapport, car un `passed` doit survivre à l'audit.

## Consequences

Un rapport ne contiendra jamais de verdict non justifié : tout `inconclusif` porte une raison de downgrade traçable, et le meilleur statut possible d'un critère ne peut que se dégrader avec le temps.
