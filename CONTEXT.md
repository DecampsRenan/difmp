# difmp

difmp exécute des scénarios end-to-end écrits en prose (Markdown) plutôt qu'en sélecteurs : un modèle
conduit le navigateur, difmp possède les outils, les budgets, la vérification et les preuves.

## Language

### Scénario et contrat

**Scénario** :
Le texte-source écrit par l'auteur dans un fichier `*.e2e.md` (frontmatter + corps en prose).
_Avoid_ : journey, test, cas de test

**Contrat** :
Le scénario figé au début d'un run — interpolé, découpé en critères, haché — écrit dans
`contract.json` avant toute navigation. Immuable pour la durée du run. Produit de la Préparation
du run, jamais réécrit après le gel.
_Avoid_ : expectation figée

**Préparation du run** :
La chaîne qui fait passer le Scénario au Contrat : précédence des entrées (config < spec <
`--inputs-file` < `--input`), interpolation de phase 1, contrôle des noms de registres, puis gel —
interpolation stricte, hachés, et le seul remplacement de budget qu'un scénario ait le droit
d'imposer (`timeout` sur `attemptTimeoutMs`). Un seul chemin, deux attitudes : stricte pour le run
(on s'arrête au premier problème), tolérante pour `difmp validate` (on accumule tout, les
références `{{ fixture.* }}` sont admises faute de setup). Ce que la fabrique de scripts de la CLI
utilise n'est que son étage d'entrées — le même code, pas une copie.
_Avoid_ : pré-run (comme nom), parsing (qui n'en est qu'un morceau), validation (nommer
« l'attitude tolérante de la Préparation »)

**Spec** :
Désigne uniquement le fichier (`spec.e2e.md`, frontmatter `specPath`). Ne pas employer comme
synonyme de scénario ou de contrat.

### Attentes et critères

**Attente** :
Ce que l'auteur exprime comme résultat voulu — une puce de `verification:` ou du corps du contrat.
_Avoid_ : assertion, check, critère (le critère est ce qui en découle, voir ci-dessous)

**Critère** :
Unité atomique identifiée (id), hachée et jugée séparément, issue d'une attente (méthode `model`)
ou d'une entrée `checks:` (méthode `code`). Une puce = exactement un critère ; un bloc de prose sans
puces = un unique critère global. Le texte d'un critère est immuable une fois le contrat gelé.
_Avoid_ : expectative, test unitaire

**Vérification** :
Le processus par lequel difmp juge les critères — pas un objet du domaine. Ne jamais l'employer
comme synonyme d'attente ou de critère.

### Jugement

**Verdict** :
Le statut _consigné_ par le harnais pour un critère ou un run, après application des règles — seule
autorité dans les rapports. Se distinguent de lui : le statut _proposé_ par l'évaluateur, qui peut
être refusé, et les réévaluations ultérieures, conservées comme observations mais ne remplaçant un
verdict que vers le pire (jamais de promotion).
_Avoid_ : résultat, conclusion, statut proposé (nommer « verdict » pour dire « proposition de
l'évaluateur »)

**Inconclusif** :
Verdict du harnais signifiant « refuse de conclure » — preuve rejetée, navigation incertaine, budget
épuisé, critères non résolus. Ni succès ni échec ; n'est jamais une conclusion que l'évaluateur
revendique de lui-même.
_Avoid_ : incertain, partiel, N/A

**Adjudication** :
Application par le harnais des quatre règles qui transforment une proposition d'évaluateur en verdict
consigné — intégrité de la preuve, branche d'absence, persistance des preuves obligatoires, admission
monotone — dans cet ordre et pas un autre. Elle se déroule en deux passages lors d'une même
évaluation : le _screening_ par l'évaluateur (sur le snapshot de preuve pris avant la question) et la
_consignation_ par le harnais (sur l'inventaire re-lu après la réponse). Seule la consignation fait
autorité ; la double application est délibérée — une même loi croisée sur deux jeux de preuves,
jamais deux lois. Les messages de refus sont écrits une fois pour toutes par l'adjudication, pour
qu'un rapport dise le même POURQUOI quel que soit le passage qui a intercepté le problème.
_Avoid_ : post-vérification, correction de verdict, double jugement

### Preuves

**Artefact** :
Toute pièce capturée pendant un run et inventoriée (capture d'écran, snapshot ARIA, trace, log…),
avec un état : présent, manquant ou échoué. Un échec de capture est consigné, jamais masqué.

**Preuve** :
Artefact _cité_ par un verdict pour un critère — un rôle, pas un type d'objet. Inventorié mais non
cité = artefact seul. Une preuve doit exister et appartenir à l'attempt jugée, sinon le harnais force
le verdict à inconclusif.
_Avoid_ : evidence (en français), capture (comme synonyme de preuve)

**Enregistrement de la preuve** :
Le chemin unique par lequel une capture, une observation ou une sonde de check devient artefact
inventorié : frapper l'id, écrire, consigner, et n'admettre dans l'index de preuve que ce qui a
réellement survécu. Une capture ratée y est enregistrée comme ratée, jamais avalée ; un refus du
magasin retire l'artefact de l'index et, s'il était obligatoire, condamne le critère à n'être plus
`passed` et le run à `error`.
_Avoid_ : sauvegarde (ne couvre pas l'index ni les échecs), logging

### Exécution

**Run** :
Exécution d'un contrat, identifiant frappé par le harnais. Laisse après coup un dossier de run
lisible.
_Avoid_ : session, exécution, test (comme unité d'exécution)

**Attempt** :
Tentative d'exécution du contrat _à l'intérieur_ d'un run — unité d'isolation (contexte navigateur,
données, preuves). Un run = une seule attempt en l'état (pas de retry automatique) ; le terme est
nommé dès maintenant pour que le retry futur n'exige aucun changement de modèle.
_Avoid_ : essai, retry, job

**Journal** :
Trace ordonnée des événements d'un run — numérotée `seq` par run, pas par attempt. Les assertions du
harnais y vivent ; la trace Playwright ne les remplace pas.
_Avoid_ : log, cronique

**Dossier de run** :
Le répertoire `runs/<run-id>/` laissé par un run — journal, contrat gelé, spec source, manifeste,
artefacts, rapport.
_Avoid_ : archive, output, rapport (le rapport n'en est qu'une pièce)

### Acteurs

**Agent navigateur** :
Le modèle qui agit sur la page via les outils du harnais. Il ne juge jamais : il peut demander une
re-vérification, pas modifier un critère ni un verdict.
_Avoid_ : driver, opérateur, LLM (générique)

**Distributeur d'actions** :
La pièce du harnais qui exécute les huit outils et possède la mémoire de la page : dernière
observation, settling, compteur d'actions, action en cours. Ses transitions sont les seules ; le
reste du harnais les consulte — ce sont les faits que reçoit l'adjudication pour la branche
d'absence. Il ne juge rien : `check` lui prête la fonction d'évaluation, la loi reste l'affaire de
l'adjudication.
_Avoid_ : exécuteur, tool loop (comme nom de domaine)

**Évaluateur** :
Ce qui _propose_ le statut d'un critère. Trois sortes : le vérificateur (modèle), le check (code),
le modèle scripté (double de test, marqué comme tel — jamais lu comme un vrai jugement).

**Vérificateur** :
Le modèle qui juge les critères à méthode `model`. Doit rester distinct de l'agent navigateur —
jamais le même cerveau dans un run ; on préférera par exemple un modèle dédié à la vérification.
_Avoid_ : judgeur, critique

**Harnais** :
difmp lui-même : frappe les identifiants, gèle le contrat, compte les consommations, applique les
downgrades, consigne les verdicts. Le _runner_ n'est que le composant qui l'exécute — pas un concept
du domaine.
_Avoid_ : moteur, framework, runner (comme synonyme de harnais)

### Budgets

**Budget** (sens large) :
Toute consommation comptée par le harnais — actions, appels modèle, tokens, temps. Deux espèces à
ne jamais confondre : le **garde bloquant** (timeout d'attempt, timeout par opération, max d'appels
modèle, budget de tokens avec réserve pour l'évaluation finale), dont l'épuisement arrête l'attempt
et force _inconclusif (budget épuisé)_ ; et le **seuil indicatif** (`maxActions`), comptage
signalétique seul — dépasser émet un signal de réévaluation, ne refuse aucune action, ne downgrade
rien : un succès en 40 actions reste `passed`.
Règle : dans les rapports, « budget épuisé » ne désigne jamais le seuil indicatif.
_Avoid_ : quota, limite (ambigu entre les deux espèces), Hard limit cachée dérivée de `maxActions`

### Environnement de test

**Fixture** :
Préétat préparé par le harnais avant l'attempt : valeurs publiques injectables
(`{{ fixture.<key> }}`), secrets, état navigateur (ex. `storageState`), et cleanup borné enregistré
dès chaque acquisition. Jamais l'application visée elle-même.
_Avoid_ : setup, données de test, environnement

**App témoin** :
Petite application (`examples/fixture-app`) contre laquelle on teste difmp lui-même — le cobaye du
harnais, pas une fixture.
_Avoid_ : fixture (pour la désigner), démo, playground
