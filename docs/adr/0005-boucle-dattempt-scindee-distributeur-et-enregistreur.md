# La boucle d'attempt scindée : l'état de la page au Distributeur, la preuve à son enregistreur

`runAttempt` tenait une closure sur une quinzaine de variables muettes : le switch des huit outils
lisait et modifiait `currentObservation` et `navigationSettled` — que le harnais relisait par
capture de closure au moment de l'adjudication — et le dossier de preuve se fabriquait trois fois
presque identiquement (capture, observation, sonde de check) autour d'un index et de deux listes
d'échecs épars. La boucle est désormais composée de deux modules internes de `runner/` :

- **`dispatcher.ts` — le Distributeur d'actions** possède l'état vivant de la page : c'est lui qui
  sait qu'un clic provoquant une navigation périmé l'observation et dépose la certitude de
  settling. Le harnais ne lui dicte aucune transition ; il **consulte** — `navigationSettled()` et
  `currentObservation()` sont les faits servis à l'adjudication, `finishRequested()` arrête la
  boucle, `takePendingNudge()` et `closeInterruptedAction()` sont les deux seules questions de
  bord. Le rituel du journal (frappe de l'`actionId`, comptage, `actionStarted`/`actionFinished`,
  porte de schéma sur le résultat, capture every-action) n'existe qu'en un exemplaire, y compris
  pour `check` et `finish` : le distributeur garde les huit cas et vérifie un critère en empruntant
  la fonction du harnais, jamais en décidant quoi que ce soit.
- **`evidence.ts` — l'Enregistreur de preuve** possède l'écriture (frappe, bâti, consigne), l'index
  (seul ce qui a survécu est citable) et les échecs de preuves obligatoires. La règle — une capture
  ratée est enregistrée comme ratée, jamais avalée — a un propriétaire et une énonciation.

Les deux sont des modules internes, pas des services Context : il n'existe pas de second
implémenteur, aucun consommateur hors du runner, et l'endroit où truquer est honnête est déjà un
seam en dessous (`RunStore`). Les faux scénarios d'écriture restent des pannes réelles du système
de fichiers (dossiers bouchons), parce que ce qu'on prouve ainsi — l'échec consigné, pas avalé —
est précisément ce que possède l'enregistreur.

## Considered Options

- **Services Context pour les deux modules** : rejeté — la remplaçabilité publique ne sert que si
  quelqu'un remplace ; un enregistreur falsifiable dans les tests prouverait moins de choses, pas
  plus, et l'interface publique de `core` se serait élargie pour rien.
- **Le distributeur signale, le harnais applique les transitions d'état de la page** : rejeté —
  les lignes `currentObservation = undefined / navigationSettled = false` seraient restées dans la
  boucle, à réinterpréter des événements que seul le distributeur sait produire ; le module serait
  devenu une coquille sans mémoire, c'est-à-dire sans profondeur.
- **Séparer le switch en « outils navigateur » (distributeur) et `check`/`finish` (harnais)** :
  rejeté — le rituel journalisé début/fin et la porte de schéma sur le résultat auraient été écrits
  deux fois, exactement la duplication que la coupe devait tuer.

## Consequences

Six chemins du switch, jusqu'ici inaccessibles sans scripting d'un modèle, sont testés en direct
sur le distributeur (`packages/core/test/dispatcher.test.ts`) : `press`, `scroll`, la capture
`fullPage`, la capture every-action (y compris après un refus), les refus de référence inconnue ou
ambiguë, et la remise en état douteux après une interaction qui navigue — la règle qui décide
échec-vs-inconclusif. L'index de preuve et la liste des échecs obligatoires ne sont plus accessibles
qu'à travers l'enregistreur : un futur candidat (budgets, deadline) butera sur deux objets nommés
au lieu d'une closure. Le split redaction-par-convention du journal (émettre via `journal` dedans,
`emit` assaini dehors) reste un point connu, volontairement hors de cette coupe.
