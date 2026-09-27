# La préparation d'un run a un seul propriétaire, deux attitudes

Ce qui fait passer un `*.e2e.md` à un Contrat figé — précédence des entrées (config < spec <
`--inputs-file` < `--input`), interpolation de phase 1, contrôle des noms de registres, gel avec
hachés et remplacement du budget par le scénario — était écrit trois fois : l'étape 1 du runner,
la reprise verbatim de `runOne` pour sa fabrique de scripts (cohérence tenue par un commentaire :
« pur et déterministe, donc faire deux fois ne peut pas diverger ») et une troisième copie main dans
`difmp validate`, avec ses propres boucles de références et de registres. La règle « un scénario
remplace `attemptTimeoutMs` » vivait dans un coin de `contract.ts`, le paramètre `mode` du gel
n'avait plus d'appelant, et rien ne testait le gel directement.

`packages/core/src/prepare` est désormais le seul chemin : `prepareRun(demande)` résout entrées et
registres et rend un `PreparedRun` dont le verbe `.contract({ fixturePublic })` est le gel — le type
interdit de geler avant d'avoir résolu. La porte voisine `checkRun` rejoue la même chaîne en
attitude tolérante : accumulation de tous les problèmes, références `{{ fixture.* }}` acceptées,
identifiants factices. `freezeContract` et `contract.ts` n'existent plus.

Les deux portes du calcul strict — le runner et la CLI — exécutent chacune la préparation ; rien
ne transite par la requête `runScenario`, dont l'interface ne bouge pas (le paquet est publié). La
préparation est pure et légère (pas de navigateur, pas de disque) : la divergence entre les deux
calculs est structurellement impossible puisqu'ils sont le même code, et une mémoïsation éventuelle
resterait un changement privé derrière cette interface (issue #42, décision 5).

## Considered Options

- **Une chaîne incluant la fixture** (tout l'avant-navigation dans `prepareRun`) : rejeté — le gel
  consomme les valeurs publiques de la fixture ; faire porter le journal, le manifeste en deux
  temps et le redactor à la préparation en ferait un demi-runner caché, avec la convention de
  redaction qui voyage avec lui.
- **Fonctions libres `resolveRunInputs` + `buildContract` à câbler à la main** : rejeté — rien
  n'empêcherait de geler dans le désordre ou avec de mauvaises entrées ; la cohérence redeviendrait
  une convention. `resolveRunInputs` existe malgré tout, comme l'étape d'entrées seule dont la
  fabrique de scripts a besoin — c'est le premier étage de `prepareRun`, pas un parallèle.
- **Faire préparer par la CLI et passer le résultat au runner** (champ optionnel dans la requête) :
  rejeté — une couture de plus dans l'interface publique, avec sa sémantique d'incohérence
  (« et si le préparé ne correspond pas aux registres passés à côté ? »), pour économiser un calcul
  pur.
- **Garder `validate` sur sa copie main en partageant seulement les entrées** : rejeté — c'est
  recréer le commentaire « ne peut pas diverger » ailleurs.

## Consequences

`difmp validate` rend exactement les mêmes messages, dans le même ordre d'accumulation, garantis
par un test de caractérisation écrit AVANT la bascule
(`apps/cli/test/validate-characterization.test.ts`) ; le jour où un message change, c'est un
changement du contrat CLI, décidé, pas un accident de refactor. L'ordre des étapes (entrées, puis
registres, puis gel) et le remplacement du budget par le scénario ont un nom et des tests directs
(`packages/core/test/prepareRun.test.ts`, 10 cas, en process, sans faux navigateur). La boucle
manuelle critère-par-critère de `validate.ts` a disparu. Le paramètre mort `promptHashes` du gel
avec lui ; `hashes.prompts` reste un champ du document, rempli de vide.
