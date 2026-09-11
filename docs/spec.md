# Initialiser un harness de tests E2E exécutés par des agents

Ce document est le brief d’implémentation à transmettre à un agent de développement. Réalise le projet décrit ici jusqu’à obtenir une première tranche fonctionnelle exécutée et vérifiée. Ne t’arrête pas à un squelette de fichiers ou à une proposition d’architecture.

## 1. Objectif

Construire un harness TypeScript avec Effect v4 qui exécute des scénarios E2E écrits en Markdown avec frontmatter YAML. Un agent choisit les actions de navigation ; le harness contrôle les outils, les budgets, les vérifications et la collecte des preuves.

L’utilisateur doit pouvoir lancer un scénario localement ou en CI, suivre ce qui se passe, puis comprendre un échec depuis un rapport et ses artefacts.

Le premier jalon est un scénario « créer un projet puis le retrouver après rechargement » qui réussit sur une application saine, détecte une régression réelle et produit des preuves précises.

## 2. Décisions retenues

- Langage : TypeScript en mode strict.
- Runtime d’orchestration : Effect v4, version exacte épinglée et lockfile commité. Vérifier les API de la version installée ; ne pas copier des exemples Effect v3.
- Runtime système : Node.js, dans une version LTS supportée par les dépendances retenues et fixée dans le dépôt et en CI. Le runner, la CLI et le serveur live s’exécutent sous Node.js. Déclarer les versions prises en charge dans `engines.node`.
- Gestionnaire de paquets du dépôt : pnpm, version fixée dans `packageManager`, workspace pnpm et `pnpm-lock.yaml` commité. Installation CI avec `pnpm install --frozen-lockfile`. Le package distribué doit rester installable et utilisable avec npm, pnpm ou Yarn, sans imposer pnpm aux projets consommateurs.
- Distribution : package installable dans un projet tiers, exposant un binaire `harness` via le champ `bin`, utilisable dans les scripts `package.json` comme Vitest, Jest ou Mocha. `harness` est un nom provisoire ; vérifier le nom disponible avant une éventuelle publication, qui est hors périmètre.
- Format des specs : fichiers `*.e2e.md`, frontmatter YAML entre `---`, corps Markdown libre.
- Validation des contrats : Effect Schema.
- Vérification par défaut : attentes en texte libre, évaluées à partir de preuves collectées. Aucun profil TS obligatoire. Des checks TS restent une extension facultative pour les invariants nécessitant une preuve déterministe.
- `inputs` et `fixture` sont facultatifs. `maxActions` est un indicateur de durée du parcours, jamais une limite bloquante.
- Navigateur du MVP : Chromium via la bibliothèque Playwright appelée directement depuis TypeScript.
- Interface : application web locale React/TypeScript, avec suivi via SSE et rapport HTML autonome après exécution.
- Stockage initial : fichiers locaux. Aucun service de base de données requis.
- Exécution initiale : un scénario à la fois, avec contexte navigateur et données isolés par tentative.
- L’agent agit par outils structurés contrôlés par le harness. Il n’a pas de terminal, d’accès aux sources de l’application ni d’outil d’exécution JavaScript arbitraire.

Ces choix constituent le point de départ. Résous les détails courants de manière autonome et documente les décisions. Demande une clarification uniquement si une ambiguïté empêche réellement l’implémentation.

## 3. Périmètre du MVP

Livrer une tranche verticale complète : lecture d’une spec, préparation des fixtures, boucle agent, actions navigateur, vérifications, journal durable, interface live, rapport et exécution CI.

Inclure un adaptateur modèle réel configurable, ainsi qu’un adaptateur scripté déterministe pour tester le harness sans appel externe. Le rapport doit identifier explicitement l’adaptateur utilisé. Un test avec adaptateur scripté ne constitue pas une validation de la capacité d’un modèle à naviguer.

Reporter après le MVP : exploration ouverte, compilation du texte en code d’assertion, génération de tests Playwright permanents, drivers agent-browser/Playwright CLI, exécution distribuée, plusieurs navigateurs, multi-agent, comptes utilisateurs du dashboard et reprise d’une session navigateur après crash. L’évaluation des attentes textuelles fait bien partie du MVP.

## 4. Format de scénario

Exemple de référence :

```markdown
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
  - Le projet {{ projectName }} apparaît dans la liste après création.
  - Le projet reste présent après rechargement de la page.
  - La liste contient exactement un projet portant ce nom après rechargement.
---

# Créer un projet

Depuis l’accueil, créer un projet nommé {{ projectName }}
dans l’espace de travail courant.

Utiliser le parcours proposé à un utilisateur standard.

Les résultats attendus sont décrits dans verification.
```

### Règles de parsing

- `version` et `id` sont obligatoires. Le corps Markdown doit être non vide.
- `tags`, `inputs`, `fixture`, `timeout`, `maxActions` et `checks` sont facultatifs. Les paramètres d’exécution absents héritent de la configuration du projet.
- Les attentes doivent être présentes dans le champ `verification` sous forme de chaîne, ou dans une section Markdown `## Résultats attendus`. Rejeter la présence des deux sources pour éviter toute ambiguïté. Aucun `verification.profile` n’est requis ni pris en charge dans ce contrat.
- Dans les attentes, une liste Markdown de premier niveau définit un critère par item ; un paragraphe sans liste constitue un critère global. Affecter des identifiants stables dans le contrat (`c1`, `c2`…) et préserver les textes, l’ordre et les positions source. La validation structurelle ne fait pas d’appel modèle et n’invente aucune attente.
- Rejeter les champs inconnus, clés YAML dupliquées, identifiants de scénarios dupliqués et versions non prises en charge.
- Utiliser un parseur YAML en mode données, sans tags exécutables, avec des limites de taille et d’alias.
- `timeout`, lorsqu’il est fourni, doit être une durée positive reconnue ; `maxActions`, lorsqu’il est fourni, un entier strictement positif décrivant un seuil indicatif.
- Les noms des fixtures et des éventuels checks TS se résolvent dans des registres du projet. Ils ne sont jamais interprétés comme du code ni comme des chemins d’import libres.
- Les erreurs doivent désigner le fichier, le champ et, lorsque possible, la ligne concernée.
- Garder le texte d’origine et le contrat normalisé dans les artefacts.

### Inputs : les données du scénario

`inputs` déclare les valeurs non sensibles que le scénario utilise : nom du projet, recherche, quantité, code de produit ou rôle de démonstration. Ils sont facultatifs : un scénario peut simplement écrire ses valeurs dans son texte. Ils évitent les répétitions et permettent de lancer le même scénario avec d’autres données.

Exemple : `projectName: "Projet {{ run.id }}"` fournit un nom unique à utiliser dans les actions et les attentes. `run.id` et `attempt.id` sont créés par le harness, jamais demandés à l’utilisateur.

Accepter dans le MVP des inputs scalaires (chaîne, nombre, booléen), sérialisés de façon déterministe dans le texte. Permettre des valeurs par défaut dans la configuration et des remplacements avec `--input key=value` (chaîne) ou `--inputs-file <json>` (valeurs typées). Priorité : configuration < spec < fichier JSON < options CLI. Rejeter les clés CLI/fichier non déclarées dans la configuration ou la spec.

Implémenter uniquement des substitutions de données, sans moteur d’expression : `{{ run.id }}`, `{{ attempt.id }}`, les clés déclarées dans `inputs` et, si une fixture existe, ses valeurs publiques sous `{{ fixture.<clé> }}`. Résoudre d’abord les inputs avec les variables réservées, préparer la fixture avec ces inputs, puis substituer le corps et les attentes avec les inputs résolus et les valeurs publiques de fixture. Les inputs ne peuvent pas dépendre des sorties de fixture ; rejeter les variables absentes et les dépendances cycliques. Ne pas interpréter récursivement des valeurs arbitraires.

Les secrets sont fournis aux fixtures par configuration d’environnement. Ils ne doivent pas devenir des inputs ordinaires ni apparaître dans les prompts ou rapports.

### Vérifications textuelles et contrat figé

Le texte original des attentes est le contrat. Il est figé et identifié avant la navigation, après interpolation. L’agent navigateur ne peut pas le modifier. Il peut demander une collecte de preuves via `check`, mais ne choisit pas le verdict.

Le service `Verifier` évalue chaque critère à partir du texte et des observations brutes horodatées. Pour le mode textuel, utiliser un appel modèle dédié avec un contexte distinct de la conversation de navigation ; le même fournisseur et modèle peuvent être utilisés. Il ne s’agit pas d’un système multi-agent concurrent. Le vérificateur reçoit les preuves utiles et le critère, pas seulement le résumé de l’agent navigateur.

La réponse structurée contient `criterionId`, état, attendu, observé, références de preuves et éventuelles limites. Le harness vérifie le schéma, l’existence des références et leur appartenance à la tentative. Il agrège les résultats sans laisser le navigateur les réécrire. Un critère sans preuve suffisante reste `inconclusive` ; une formulation vague ne doit pas être transformée en seuil inventé.

Le contrôle structurel des références ne garantit pas que le jugement sémantique du modèle soit correct. Identifier `method: model` dans le rapport. Une évaluation textuelle est probabiliste et peut produire des faux positifs ou négatifs ; ne pas la présenter comme une assertion déterministe.

Lorsque nécessaire, un auteur peut ajouter un mapping facultatif `checks: { c3: project-unique-in-storage }`. Le nom référence un check TS de confiance, associé à ce critère, qui collecte et vérifie un invariant métier. Son résultat fait autorité pour ce critère et est marqué `method: code`. Aucun check TS n’est requis pour un scénario ordinaire. Inclure le texte du critère dans le contrat du check ou vérifier son hash afin qu’une réorganisation des attentes ne réassocie pas silencieusement le check à un autre critère.

### Fixture : la préparation et le nettoyage

Une fixture est une fonction TS de support réutilisable, enregistrée dans `harness.config.ts`, que le harness exécute avant le scénario. Par exemple, `authenticated-workspace` crée un espace de travail isolé, prépare un utilisateur connecté, puis rend son état de session au navigateur. Elle peut utiliser une API de seed ou les outils de test du projet ; elle n’est pas décidée par l’agent.

Son contrat prévoit les identifiants de tentative, inputs résolus et accès aux secrets, puis expose séparément des valeurs publiques (par exemple `workspaceName`), un état navigateur privé (par exemple `storageState`) et un nettoyage géré par scope. Le nettoyage est enregistré dès l’acquisition de chaque ressource pour couvrir une préparation partiellement échouée.

Sans `fixture`, ouvrir un contexte navigateur vierge à l’URL configurée. Le scénario peut alors tester le login depuis l’interface. Avec une fixture connectée, il teste directement le parcours métier. Ne pas préparer à l’avance le comportement précisément soumis au test.

Après réussite, échec ou annulation, nettoyer les ressources de la tentative avec un délai borné. Des comptes ou tenants partagés ne constituent pas une isolation des données : utiliser des ressources par tentative dès qu’un scénario modifie l’application.

## 5. Architecture et organisation

Préférer un workspace compact :

```text
apps/
  cli/                   # Commandes, serveur local et assemblage des layers
  ui/                    # Suivi live React
packages/
  core/                  # Schémas, runner, services, politique et événements
  browser-playwright/    # Driver navigateur et acquisition des preuves
  agent-runtime/         # Boucle agent, adaptateur modèle, adaptateur scripté
  reporting/             # JSON, JUnit et HTML autonome
examples/
  fixture-app/           # Application démonstratrice et défauts injectables
  scenarios/             # Specs Markdown
  support/               # Fixtures et checks TS facultatifs de démonstration
docs/
```

Les noms peuvent évoluer si cela simplifie le dépôt. Éviter la multiplication de packages pour des modules minuscules. Le cœur ne doit dépendre ni de React ni des détails d’un fournisseur de modèle.

### Services Effect

| Service | Responsabilité |
| --- | --- |
| `SpecLoader` | Lire, parser, normaliser et valider les specs |
| `FixtureManager` | Préparer et nettoyer les données et l’authentification |
| `AgentRuntime` | Obtenir une prochaine action structurée depuis le modèle |
| `BrowserDriver` | Observer le navigateur et exécuter les actions autorisées |
| `Verifier` | Évaluer les attentes textuelles ou checks TS facultatifs depuis les preuves |
| `RunStore` | Persister le manifeste, les événements, résultats et artefacts |
| `Reporter` | Produire les exports JSON, JUnit et HTML |

Utiliser `Context.Service` et des layers explicites conformément à la version Effect v4 installée. Utiliser les scopes pour les ressources, des erreurs typées, une concurrence structurée et des timeouts bornés.

Employer les services de plateforme Node.js compatibles avec la version Effect v4 retenue. Vérifier sous les versions Node.js annoncées le lancement Playwright, les signaux, les fichiers, SSE et la finalisation des vidéos. Ne pas introduire de dépendance à un runtime alternatif.

Les SDK Promise doivent être encapsulés avec traduction des erreurs. L’interruption d’un Effect ne garantit pas l’annulation d’une Promise sous-jacente : utiliser les mécanismes d’annulation disponibles et fermer les ressources pour empêcher les actions tardives.

## 6. Boucle d’exécution

Ordre attendu :

1. Valider la spec, la configuration, les registres et les capacités nécessaires.
2. Créer les identifiants du run et de la tentative, puis persister le manifeste initial.
3. Préparer la fixture facultative, résoudre et figer les attentes, puis ouvrir un contexte navigateur isolé.
4. Démarrer les captures, logs console et réseau avant les actions du scénario.
5. Fournir à l’agent le scénario résolu, les critères, les outils, le seuil indicatif d’actions et les budgets bloquants explicitement configurés.
6. Observer, demander une action structurée, valider sa politique, journaliser son début, l’exécuter puis journaliser son résultat.
7. Collecter les preuves aux checkpoints demandés et à la fin ; le `Verifier` évalue les critères par appel modèle dédié ou check TS facultatif.
8. Calculer le résultat depuis les critères et l’état d’exécution.
9. Finaliser les preuves, fermer le navigateur, nettoyer les fixtures et produire les rapports.

Une demande `finish` du modèle déclenche la vérification finale ; elle ne suffit jamais à déclarer le succès.

Prévoir des preuves à différents moments : un critère de persistance a besoin d’une observation avant et après rechargement. L’agent navigateur peut réaliser ces étapes et demander un `check`. Si les preuves manquent, le vérificateur renvoie une demande de preuve structurée ; le runner peut continuer la navigation dans les budgets disponibles, sans modifier l’attente. Les éventuels checks TS peuvent effectuer des sondes contrôlées, toutes journalisées comme opérations du harness.

## 7. Outils et limites de l’agent

Outils minimaux : `observe`, `click`, `fill`, `press`, `scroll`, `screenshot`, `check` et `finish`. Ajouter une navigation explicite si nécessaire, soumise à la politique d’origines.

- Les arguments et résultats de chaque outil sont validés par Schema.
- `observe` renvoie une représentation compacte de la page, son URL, un `observationId` et des références d’éléments utilisables.
- Une action ciblée transporte l’`observationId` et la référence d’élément. Rejeter les références périmées ou ambiguës et demander une nouvelle observation.
- Privilégier rôles, noms accessibles et locators stables. Ne pas exposer l’objet Playwright `Page` au modèle.
- `check` référence un critère textuel existant et déclenche sa collecte/évaluation ; l’agent navigateur ne peut pas fournir son propre verdict.
- Le contenu de l’application est une donnée observée, jamais une instruction autorisant de nouveaux outils ou un changement du scénario.
- Enregistrer une courte intention d’action si le modèle la fournit ; ne pas demander de raisonnement interne détaillé.

`maxActions` est un seuil indicatif, malgré son nom conservé à la demande de l’utilisateur. Compter les appels aux outils navigateur de l’agent acceptés pour exécution, y compris observations, captures et tentatives échouées ; compter séparément appels modèle et opérations de vérification. Lors du premier dépassement, émettre `actionGuidanceExceeded`, afficher « 28 actions / 25 indicatives » et inviter l’agent à réévaluer brièvement son approche. Le run continue : aucune action n’est refusée, aucun statut n’est dégradé et aucune approbation n’est requise pour ce seul motif. Une réussite en 40 actions reste `passed`. Ne pas introduire de limite bloquante cachée dérivée de ce seuil.

Les garde-fous bloquants sont distincts, explicites et configurables : timeout global de tentative, timeout par opération, maximum d’appels modèle et budget de tokens. Inclure les appels du vérificateur dans la consommation et réserver une marge pour l’évaluation finale. Documenter les valeurs par défaut et afficher la configuration résolue avant le lancement. La détection d’une boucle peut émettre un signal de progression insuffisante ; elle ne transforme pas le dépassement de `maxActions` en arrêt forcé.

Les origines de navigation et les éventuels services tiers autorisés sont définis dans la configuration du harness. Une vérification d’URL au niveau des outils n’est pas une isolation réseau complète : documenter cette limite et utiliser un environnement CI maîtrisé.

Ne jamais répéter automatiquement une action mutante sur simple timeout : une création peut avoir abouti même si sa réponse a été perdue. Vérifier l’état avant toute reprise. Les retries de transport doivent être bornés et réservés aux opérations pour lesquelles ils sont appropriés.

## 8. Modèle et configuration

Définir une interface de fournisseur permettant de demander une réponse structurée avec outils, de recevoir les informations de consommation disponibles et d’annuler un appel lorsque le fournisseur le permet.

Implémenter un adaptateur réel pour un fournisseur disposant de ces capacités. Choisir et documenter ce fournisseur selon les SDK et accès disponibles au moment de l’initialisation ; ne pas figer un nom de modèle dans le code métier. Le fournisseur, le modèle et les options sont configurables.

Les clés restent dans des variables d’environnement. Fournir `.env.example` sans valeur sensible. Si aucune clé n’est disponible, terminer et tester la tranche avec l’adaptateur scripté, puis indiquer précisément la commande permettant le smoke test réel. Ne pas présenter ce smoke test comme effectué.

La configuration de projet `harness.config.ts` porte notamment : discovery `include`/`exclude`, URL de base, origines permises, inputs par défaut, fixtures et checks facultatifs, fournisseur/modèle, seuil indicatif d’actions, budgets bloquants, politique de capture et dossier des résultats. Exporter un helper typé `defineConfig`. Charger ce module TS comme code de confiance du projet, jamais depuis un nom arbitraire contenu dans une spec. Ne pas obliger à créer un registre de support si le scénario utilise seulement du texte.

Persister les paramètres résolus non sensibles, les versions des dépendances principales, l’identité du modèle, le hash des prompts, de la spec et du contrat. Des paramètres figés améliorent la traçabilité sans rendre un LLM déterministe.

## 9. Résultats et vérifications

Le résultat d’une tentative est une union discriminée :

| Statut | Sens |
| --- | --- |
| `passed` | Tous les critères obligatoires ont été vérifiés avec les preuves requises |
| `failed` | Une observation contredit un critère obligatoire du produit |
| `inconclusive` | Les preuves ne permettent pas de conclure, ou un budget bloquant est épuisé avant de pouvoir conclure ; dépasser `maxActions` n’est pas un motif |
| `error` | Échec de fixture, fournisseur, navigateur, stockage ou infrastructure |
| `cancelled` | Annulation explicite de l’exécution |

Chaque critère a son propre état : `pending`, `passed`, `failed`, `inconclusive` ou `error`, ainsi que sa méthode `model` ou `code`. Un run peut conserver un critère en échec même si une erreur d’infrastructure survient ensuite. Ne pas perdre cette information dans le statut agrégé. Dans les tests internes, identifier également les réponses du vérificateur scripté pour ne pas les confondre avec un jugement de modèle réel.

Politique d’agrégation du MVP : annulation explicite → `cancelled` ; sinon erreur bloquante d’exécution ou de preuve obligatoire → `error` ; sinon critère obligatoire échoué → `failed` ; sinon critère non résolu → `inconclusive` ; sinon `passed`.

Séparer dans les rapports : observations factuelles, attentes textuelles, évaluations et hypothèses de diagnostic. Le modèle évaluateur peut produire un verdict sémantique étayé, mais l’agent navigateur ne peut pas le modifier. Le harness valide la structure et agrège les résultats ; il ne prétend pas rendre déterministe l’évaluation du texte.

Une absence de locator après navigation incertaine produit généralement `inconclusive`. Une absence établie au checkpoint prévu par un critère peut produire `failed`. Implémenter explicitement cette différence.

## 10. Journal et artefacts

Structure cible :

```text
runs/<run-id>/
  manifest.json
  spec.e2e.md
  contract.json
  events.jsonl
  result.json
  report.html
  junit.xml
  attempts/<attempt-id>/
    trace.zip
    screenshots/
    video.webm
    console.jsonl
    network.jsonl
```

Les fichiers optionnels absents sont signalés dans un inventaire d’artefacts avec leur état et la raison. Un échec de capture ne doit jamais être dissimulé.

Tous les événements ont : `schemaVersion`, `runId`, `attemptId` si applicable, `seq` croissant par run, horodatage UTC, durée monotone lorsque pertinente, type et payload typé. Les événements d’action portent un `actionId` ; les vérifications portent un `criterionId` ; les preuves sont reliées par `artifactId` et, lorsque possible, par numéro d’événement.

Événements minimum : démarrage, fixture prête si applicable, observation obtenue, appel modèle commencé/terminé avec rôle navigateur ou vérificateur, action commencée/terminée, demande de preuve, vérification terminée, artefact disponible, `actionGuidanceExceeded`, budget bloquant épuisé, erreur, annulation demandée et run terminé.

Le journal append-only est écrit avant diffusion live. Sérialiser les écritures pour maintenir l’ordre. Écrire les fichiers de résultat par remplacement atomique. Au rechargement d’un run interrompu, tolérer une dernière ligne JSONL incomplète et signaler que l’exécution n’a pas été finalisée.

Enregistrer la trace dès la première tentative, puis appliquer la politique de conservation à la fin. L’API `context.tracing` de Playwright ne contient pas automatiquement les assertions du harness : elles doivent rester présentes dans notre journal et corrélées aux actions de vérification.

La vidéo est configurable et complémentaire. Elle doit être finalisée après fermeture du contexte. Les captures aux checkpoints et à l’échec sont prioritaires. La vue live du MVP peut afficher la dernière capture ; un screencast continu n’est pas requis.

Les logs textuels doivent exclure les secrets connus. Les traces, vidéos et DOM peuvent contenir des données sensibles : utiliser des fixtures synthétiques pour la démonstration, documenter la rétention et ne pas promettre une anonymisation complète de ces formats.

## 11. Interface live et rapport

L’interface doit afficher :

- Le scénario, son statut, le run et la tentative courants.
- Les critères de réussite et leurs états.
- La dernière capture, avec son horodatage et son action associée.
- Une timeline des actions, observations, vérifications et erreurs.
- Les budgets bloquants consommés et restants, et séparément le nombre d’actions comparé au seuil indicatif ; coût uniquement si calculable, sinon « indisponible ».
- Les preuves et les liens vers les artefacts disponibles.
- Une commande d’annulation fonctionnelle.

Utiliser SSE pour les événements, avec reprise depuis un curseur/`Last-Event-ID` et replay depuis le journal. Une reconnexion ne doit ni perdre ni dupliquer les événements affichés. Limiter les files d’attente des clients lents sans bloquer le runner ; le replay permet de rattraper les événements.

Le serveur local écoute sur loopback par défaut. Aucune connexion au dashboard ne doit être nécessaire à la progression d’un run. La CI peut fonctionner sans serveur UI.

Le rapport HTML doit s’ouvrir hors ligne et afficher le verdict, les critères, les faits, la timeline et les références de preuves. Intégrer le résumé et les données nécessaires au HTML ; conserver les gros artefacts comme fichiers relatifs. L’ouverture de `trace.zip` dans Playwright Trace Viewer peut rester une action externe documentée.

Échapper les contenus venant du scénario, du modèle, des pages et des logs. Le MVP ne propose pas de prise de contrôle manuelle du navigateur.

## 12. CLI et CI

La CLI est l’interface principale du produit. Elle doit fonctionner depuis n’importe quel projet consommateur après installation comme dépendance de développement, sans cloner le dépôt du harness et sans écrire de script d’orchestration. Le dashboard est une option du runner.

Distribuer un package contenant un exécutable JavaScript compilé déclaré dans `bin`, son shebang Node.js (`#!/usr/bin/env node`), ses dépendances nécessaires et les assets UI/rapport. Fournir les déclarations TypeScript des API publiques, notamment `defineConfig`. Résoudre ces assets depuis le package installé et les specs/configurations depuis le projet consommateur. Ne pas dépendre de chemins du workspace de développement. Préparer le package et le tester via une archive locale ; ne pas le publier.

Prévoir explicitement le chargement de `harness.config.ts` et des modules TS de support sous les versions Node.js prises en charge : utiliser un mécanisme de chargement/transpilation documenté dont les dépendances sont incluses à l’exécution. Ne pas supposer que Node.js exécute nativement toute syntaxe TypeScript ni demander au consommateur d’installer un loader global. Documenter le format de modules du package et tester son usage depuis des projets consommateurs ESM et CommonJS ; une CLI compilée ESM est acceptable sans imposer la conversion du projet consommateur.

Contrat de commandes à implémenter :

```text
harness [fichier-ou-dossier-ou-glob...]
harness run [fichier-ou-dossier-ou-glob...]
harness list [--tag smoke]
harness validate [fichier-ou-dossier-ou-glob...]
harness report <run-directory>
harness --help
harness --version
```

`harness` seul est un alias de `harness run` : découverte des `**/*.e2e.md`, exclusion des dépendances et résultats, exécution unique puis sortie. Respecter `include`/`exclude` et les globs passés comme arguments, y compris lorsqu’ils sont quotés. Trier les specs pour obtenir un ordre stable. Aucun watch automatique et aucun prompt interactif requis en CI. Un mode watch pourra être ajouté après le MVP.

Options de `run` minimum : `--config`, `--tag`, `--input key=value` répétable, `--inputs-file`, `--reporter` répétable (`console`, `json`, `junit`), `--output`, `--ui`, `--provider`. Ne pas réinventer le parsing des arguments si une bibliothèque compatible Node.js/Effect convient. Les options CLI d’exécution priment sur la configuration ; documenter les priorités.

Dans un projet consommateur, l’usage cible après installation du package est :

```json
{
  "scripts": {
    "test:e2e": "harness run",
    "test:e2e:ui": "harness run --ui"
  }
}
```

```sh
npm run test:e2e
npm run test:e2e -- --tag smoke
npx --no-install harness run tests/e2e
pnpm exec harness run tests/e2e
```

Ces commandes supposent le package déjà installé localement comme dépendance de développement. Adapter le nom au binaire effectivement distribué. L’exemple npx désactive l’installation implicite pour éviter d’exécuter un package homonyme public non vérifié. Fournir également les commandes d’installation et d’exécution équivalentes pour npm, pnpm et Yarn dans le README.

`validate` et `list` ne lancent ni modèle ni navigateur. `validate` vérifie les références de variables connues sans exiger l’existence de valeurs publiques de fixture avant setup, puis valide ces valeurs après setup lors de `run`. `run` fonctionne sans interface par défaut. `report` reconstruit le HTML à partir des données persistées sans rejouer le scénario.

Le reporter console doit fournir le nom des scénarios, leurs états, durées, seuils indicatifs dépassés, un résumé global et le chemin du rapport. En sortie non-TTY, produire un texte stable sans animation. Le mode reporter JSON doit garder stdout exploitable par une machine et envoyer les diagnostics techniques sur stderr.

Codes de sortie : `0` si tous les scénarios sélectionnés passent ; `1` pour un résultat `failed` ou `inconclusive` ; `2` pour configuration invalide ou erreur d’exécution ; `130` pour interruption utilisateur. Aucune spec sélectionnée doit être une erreur explicite, jamais un succès silencieux.

Exporter JUnit : critères produit échoués comme failures ; erreurs techniques et résultats indéterminés comme errors, avec statut réel préservé dans le message et dans le JSON. Documenter le traitement des annulations. Ne pas transformer un résultat indéterminé en skipped vert.

Fournir un workflow GitHub Actions démonstrateur installant les versions Node.js et pnpm fixées, puis exécutant `pnpm install --frozen-lockfile`, typecheck, tests du harness et scénarios avec adaptateur scripté via la CLI distribuée. Utiliser Vitest pour les tests internes du projet ; le harness conserve son propre runner de scénarios et sa propre CLI. Installer Chromium et ses dépendances Linux avec la version Playwright du projet et vérifier le parcours réel sous Node.js. Documenter toute dépendance système externe nécessaire. Publier les artefacts même après échec, tant que le runner CI le permet.

Un job modèle réel doit être optionnel, explicitement activé et alimenté par des secrets CI ; il ne doit pas être requis pour contribuer au harness. Aucun retry de scénario automatique dans le MVP. Préparer les identifiants de tentatives sans implémenter prématurément cette fonctionnalité.

## 13. Démonstration et tests significatifs

Construire une petite application de démonstration avec données persistées côté serveur, un espace de travail isolé et un formulaire de création de projet. L’authentification de démonstration peut être préparée par fixture ; le scénario ne teste pas le login.

Le scénario de démonstration exprime ses attentes en texte : présence avant rechargement, présence après rechargement et un seul projet de ce nom visible dans la liste. Il doit fonctionner sans `profile` ni check TS. L’exhaustivité des preuves d’unicité dépend de la liste (filtrage, pagination) ; le modèle ne doit pas déduire une unicité globale d’une vue partielle.

Ajouter un exemple avancé distinct avec check TS facultatif démontrant exactement une création persistée pour l’identifiant de la tentative. Cette preuve peut utiliser une sonde serveur réservée au check, documentée comme telle. L’agent navigateur n’a pas accès à cette sonde. Ne pas imposer cette extension au scénario textuel de base.

Prévoir quatre variantes reproductibles :

1. Application saine : le scénario passe.
2. Création refusée avec réponse HTTP 500 : le critère de création échoue avec preuve réseau et état UI.
3. Faux succès visuel : le projet apparaît localement mais disparaît après rechargement ; le critère de persistance échoue.
4. Disposition modifiée avec mêmes possibilités fonctionnelles : le parcours reste réalisable. Cette variante sert notamment à évaluer la robustesse du modèle réel lorsqu’il est disponible.

Tester également les comportements à risque du harness :

- Spec invalide rejetée avant lancement du navigateur.
- `finish` demandé prématurément sans faux positif.
- Critère obligatoire non évalué interdisant `passed`.
- Référence périmée rejetée sans clic sur un autre élément.
- Dépassement de `maxActions` émettant un avertissement unique et laissant réussir un parcours plus long, sans refus d’outil ni dégradation du verdict.
- Budget bloquant distinct atteint mettant fin à la boucle, sans requêtes ou actions tardives.
- Vérification textuelle sans profil TS, avec preuves appartenant au run ; preuves absentes ou références inventées ne donnant jamais `passed`.
- Fixture omise fonctionnant avec contexte vierge ; fixture présente préparée et nettoyée après réussite, échec ou annulation.
- Inputs remplacés suivant les priorités documentées, variables absentes rejetées et secrets non injectés au modèle.
- Annulation avec fermeture des ressources et conservation des preuves disponibles.
- Échec de sauvegarde d’une preuve obligatoire empêchant un succès silencieux.
- Déconnexion puis reconnexion SSE avec reprise ordonnée.
- Export JUnit et codes de sortie conservant la distinction produit/infrastructure/indéterminé.
- Rapport reconstruit sans appel modèle.
- Package construit puis installé avec npm dans un répertoire consommateur temporaire extérieur au workspace : discovery, config TS, scripts package.json, binaire, assets du rapport et codes de sortie fonctionnent sans dépendances de développement transitives cachées. Vérifier aussi les invocations pnpm et Yarn, ainsi que le chargement des configurations depuis des projets ESM et CommonJS.

Utiliser l’adaptateur scripté pour tester les décisions du harness de façon reproductible, avec de vrais appels Playwright contre l’application de démonstration. Fournir aussi des réponses scriptées du vérificateur pour vérifier les contrats et cas de preuves manquantes. Ces tests ne valident pas la qualité sémantique d’un modèle réel : ajouter un smoke test réel facultatif sur les variantes et signaler séparément son résultat. Réserver les assertions unitaires aux contrats et invariants utiles. Ne pas écrire des tests qui recopient simplement l’implémentation.

## 14. Ordre d’implémentation

1. Initialiser le workspace, les versions, TypeScript, les scripts et les schémas.
2. Implémenter validation de spec, registres et configuration.
3. Construire la fixture-app, le driver Playwright et le contrat de vérification textuelle fondé sur les preuves.
4. Exécuter une tranche complète avec adaptateur scripté, journal et résultat JSON.
5. Ajouter les captures, trace, rapport HTML et JUnit.
6. Implémenter l’adaptateur réel, l’évaluation textuelle dédiée et la boucle modèle/outils avec seuil indicatif et budgets bloquants séparés.
7. Ajouter le serveur SSE, l’interface live et l’annulation.
8. Construire le package CLI, le tester depuis un projet consommateur, vérifier les variantes défectueuses et les sorties CI, puis documenter l’usage.

Garder le dépôt exécutable entre ces étapes. Si une dépendance annoncée n’existe pas ou si une API a changé, vérifier sa documentation officielle, adapter le code et consigner la décision. Ne pas inventer de méthode de bibliothèque.

## 15. Définition de terminé

Le projet est initialisé lorsque :

- Une installation depuis un checkout vierge suit le README avec des commandes exactes.
- Node.js est le runtime vérifié du runner, de la CLI et du serveur live, avec une plage de versions supportées explicite.
- Le package CLI s’utilise comme dépendance de développement dans un projet tiers, avec discovery et scripts package.json, sans cloner le harness.
- Le typecheck, les tests pertinents et le workflow démonstrateur passent.
- Une spec Markdown/YAML produit un run complet sur la fixture-app.
- Le parcours standard utilise des vérifications en texte, sans profil TS obligatoire ; inputs et fixture sont réellement facultatifs.
- Un run dépassant `maxActions` peut réussir et conserve son verdict normal.
- Les variantes saine, HTTP 500 et faux succès ont les résultats attendus, preuves à l’appui.
- Un rapport consultable explique précisément le critère contredit et référence ses artefacts.
- L’interface live suit une exécution et peut l’annuler proprement.
- Aucun fournisseur de modèle ni secret n’est nécessaire aux tests reproductibles du projet.
- Un adaptateur modèle réel est implémenté, avec procédure de smoke test ; son exécution réelle est rapportée honnêtement selon les accès disponibles.
- Les limites connues et les décisions sont décrites dans `docs/architecture.md`.

Dans la réponse finale de l’agent d’implémentation, fournir les commandes de lancement, les chemins des fichiers importants, les vérifications réellement effectuées, un exemple de dossier de run et les éventuels points restant bloqués. Ne pas affirmer qu’un test a été exécuté s’il ne l’a pas été.

## 16. Références techniques

Les capacités ci-dessous ont été consultées pendant le cadrage du 11 septembre 2026. Vérifier les API de la version installée lors de l’implémentation.

- [Effect v4 et statut de publication](https://effect.website/)
- [Migration des services Effect v4](https://github.com/Effect-TS/effect/blob/main/migration/services.md)
- [API de trace Playwright et limite concernant les assertions](https://playwright.dev/docs/api/class-tracing)
- [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer)
- [Playwright en CI](https://playwright.dev/docs/ci)
- [Playwright CLI pour agents, option future](https://playwright.dev/docs/getting-started-cli)
- [Dashboard agent-browser, option future](https://agent-browser.dev/dashboard)
- [Vidéo agent-browser](https://agent-browser.dev/recording)
