#!/usr/bin/env bash
# autopilot.sh — implémente en autonomie une file FERMÉE d'issues difmp.
#
# Usage : scripts/autopilot.sh 45 46 47 48
#
# Une session opencode headless par issue, séquentiellement, chacune dans son
# propre worktree basé sur origin/main. La session fait : grilling interne ->
# decision-record auto-approuvé sur l'issue -> (+ADR si le sujet le mérite) ->
# implémentation -> porte verte -> PR -> merge squash -> issue fermée.
#
# Échec = jamais de merge sur porte rouge : branche poussée, PR draft, label
# ready-for-human, et la boucle passe au sujet suivant. Les sujets problématiques
# découverts en route deviennent de nouvelles issues (needs-triage) — elles ne
# rentrent PAS dans cette file.
#
# Logs : runs/autopilot-<horodatage>/issue-<n>.log (+ <n>.prompt.md, run de référence)
#
# Env : MODEL, VARIANT, SESSION_TIMEOUT (s), PREPROMPT (fichier de consignes
# supplémentaires optionnel) peuvent surcharger les défauts.

set -uo pipefail

MODEL="${MODEL:-opencode-go/qwen3.8-flash}"
VARIANT="${VARIANT:-medium}"
SESSION_TIMEOUT="${SESSION_TIMEOUT:-5400}"
PREPROMPT="${PREPROMPT:-}"

if [ $# -lt 1 ]; then
  echo "usage: $0 <issue> [<issue> ...]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || exit 1
RUNS_DIR="$REPO_ROOT/runs/autopilot-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUNS_DIR"

for TOOL in gh opencode timeout git pnpm; do
  command -v "$TOOL" >/dev/null || { echo "manque '$TOOL' dans le PATH" >&2; exit 1; }
done

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

MERGED=()
PENDING=()

for N in "$@"; do
  STATE="$(gh issue view "$N" --repo "$REPO" --json state --jq .state)"
  if [ "$STATE" != "OPEN" ]; then
    log "#$N déjà $STATE — skip"
    continue
  fi

  BRANCH="autopilot/issue-$N"
  WT="/tmp/opencode/wt/issue-$N"
  LOG="$RUNS_DIR/issue-$N.log"
  PROMPT_FILE="$RUNS_DIR/issue-$N.prompt.md"

  log "=== #$N — worktree $WT sur origin/main ==="
  git fetch -q origin main
  git worktree prune
  rm -rf "$WT"
  git -C "$REPO_ROOT" worktree add -q -B "$BRANCH" "$WT" origin/main || {
    log "#$N — création du worktree impossible"; PENDING+=("#$N (worktree)"); continue;
  }

  {
    cat <<EOF
Tu es un agent d'implémentation AUTONOME du repo difmp. Le worktree courant (branche $BRANCH, base origin/main) est ton seul périmètre de travail. Contexte du projet : AGENTS.md, docs/agents/, CONTEXT.md à la racine ; style d'archi et de code : les derniers refactors (#35 #37 #41 #43, voir docs/adr/).

SUJET : l'issue #$N, et elle seule. Lis-la avec gh issue view $N --comments. Les numéros de lignes cités dans les issues d'archi-review sont périmés : re-ancre par les noms.

MÉTHODE, dans cet ordre :

1. 'pnpm install' (liens workspace + hooks lefthook — requis pour le typecheck).
2. Grilling interne : explore le code visé, liste les vraies questions ouvertes du sujet, tranche-les toi-même avec un argument concret (code, tests, CONTEXT.md). Cadrage : pas d'extension de scope. Tout sujet adjacent ou problématique rencontré devient une NOUVELLE ISSUE via 'gh issue create --label needs-triage' (titre clair, corps décrivant le frottement observé) — jamais un fix non demandé ici.
3. Decision-record : 'gh issue comment $N' titled "Decision-record (auto-approuvé) — $(date +%F)" : questions du grilling, tranchages motivés, alternatives écartées, lien vers la PR. Termine par : "Approuvé automatiquement par l'agent autonome — sujet à relecture humaine. Pour revenir dessus : commenter cette issue ou ouvrir une issue sœur."
4. ADR dans docs/adr/ UNIQUEMENT si le sujet est une décision d'archi contraignante ; suis le style des 0001..0006 ; statut "Accepted (auto-approuvé, relisible)". Un refactor mécanique n'a pas d'ADR — le commentaire de l'étape 3 suffit.
5. Implémentation : code maintenable, modules profonds, un seul propriétaire par responsabilité, discipline de pureté héritée (cf. runReducer : pins d'immutabilité, tests directs, pas de DOM).
6. PORTE VERTE obligatoire : pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:ui — tout au vert, sans exception.
7. Livraison : commit conventionnel (style git log du repo), 'git push -u origin $BRANCH', 'gh pr create' dont le body contient "Fixes #$N" et le résumé du decision-record, puis attends les checks CI ('gh pr checks <pr> --watch') et 'gh pr merge <pr> --squash --delete-branch'. Vérifie ensuite que #$N est fermée ; sinon 'gh issue close $N --remove-label needs-triage'.

ÉCHEC (porte rouge après efforts raisonnables, sujet trop gros pour une session, ou blocage réel) : ne JAMAIS merger. Pousser la branche, ouvrir la PR en --draft avec l'état des lieux, 'gh issue comment $N' pour l'expliquer, puis 'gh issue edit $N --add-label ready-for-human'. Les choix déjà tranchés doivent rester visibles dans le decision-record.

INTERDICTIONS : pas de push direct sur main (protégée), pas de force-push, pas de nouveau label, ne pas traiter d'autres issues, aucun secret dans les commits ou les logs.

Finis par un résumé (< 20 lignes) sur stdout : numéro de PR, mergée ou draft, issues créées en route.
EOF
    if [ -n "$PREPROMPT" ] && [ -f "$PREPROMPT" ]; then
      echo; echo "--- consignes opérateur additionnelles ---"; cat "$PREPROMPT"
    fi
  } > "$PROMPT_FILE"

  log "#$N — session opencode ($MODEL / $VARIANT, timeout ${SESSION_TIMEOUT}s) -> $LOG"
  timeout "$SESSION_TIMEOUT" opencode run --dir "$WT" -m "$MODEL" --variant "$VARIANT" --auto "$(cat "$PROMPT_FILE")" \
    >"$LOG" 2>&1
  RC=$?

  FINAL="$(gh issue view "$N" --repo "$REPO" --json state --jq .state)"
  if [ "$FINAL" = "CLOSED" ]; then
    log "#$N — FUSIONNÉ (issue fermée)"
    MERGED+=("#$N")
    gh issue edit "$N" --repo "$REPO" --remove-label needs-triage 2>/dev/null
  else
    log "#$N — non clos (rc=$RC) — filet de sécurité : label ready-for-human"
    PENDING+=("#$N (rc=$RC, voir $LOG)")
    gh issue edit "$N" --repo "$REPO" --add-label ready-for-human 2>/dev/null
  fi

  git -C "$REPO_ROOT" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"
done

echo
log "===================== RÉSUMÉ ====================="
log "fusionnés      : ${MERGED[*]:-aucun}"
log "attente humain : ${PENDING[*]:-aucune}"
log "logs           : $RUNS_DIR"
[ ${#PENDING[@]} -eq 0 ]
