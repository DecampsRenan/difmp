#!/usr/bin/env bash
#
# Exercise an installed `difmp` from inside a consumer project: the bin, discovery, the
# TypeScript config, the package.json scripts, the run-directory assets and every exit code.
#
#   verify.sh <dir> <npm|pnpm|yarn> <esm|cjs>
#
# `DIFMP_REPO_ROOT`, when set, is the development workspace the installed package must NOT
# reference (see the last check).
set -uo pipefail
DIR="$1"; PM="$2"; KIND="$3"
cd "$DIR"
LOG="$DIR/verify.log"
: > "$LOG"
PASS=0; FAIL=0
declare -a RESULTS=()

case "$PM" in
  npm)  EXEC=(npx --no-install difmp); RUNSCRIPT=(npm run --silent) ;;
  pnpm) EXEC=(pnpm exec difmp);        RUNSCRIPT=(pnpm run --silent) ;;
  yarn) EXEC=(corepack yarn run difmp); RUNSCRIPT=(corepack yarn run) ;;
  # Yarn 1 (classic), when one is installed standalone — corepack is the Yarn 4 path above.
  yarn1) EXEC=(yarn run difmp); RUNSCRIPT=(yarn run) ;;
  *) echo "unknown package manager: $PM" >&2; exit 64 ;;
esac

record () { # verdict message
  if [ "$1" = PASS ]; then RESULTS+=("PASS $2"); PASS=$((PASS+1)); else RESULTS+=("FAIL $2"); FAIL=$((FAIL+1)); fi
}

check () { # name expected_exit command...
  local name="$1"; local want="$2"; shift 2
  echo "### $name : $*" >> "$LOG"
  "$@" >> "$LOG" 2>&1
  local got=$?
  echo "### -> exit $got (expected $want)" >> "$LOG"
  if [ "$got" = "$want" ]; then record PASS "$name (exit $got)"; else record FAIL "$name (exit $got, expected $want)"; fi
}

# The application under test, on an ephemeral port.
node server.mjs > "$DIR/server.out" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 100); do grep -q '^PORT=' "$DIR/server.out" 2>/dev/null && break; sleep 0.1; done
PORT=$(sed -n 's/^PORT=//p' "$DIR/server.out")
if [ -z "$PORT" ]; then echo "the consumer's static server never started" >&2; cat "$DIR/server.out" >&2; exit 1; fi
export CONSUMER_BASE_URL="http://127.0.0.1:${PORT}"
echo "app under test: $CONSUMER_BASE_URL" >> "$LOG"

# The bin resolves and answers.
check "bin --version"             0 "${EXEC[@]}" --version
check "bin --help"                0 "${EXEC[@]}" --help
# Discovery and TypeScript config loading. Neither starts a model or a browser.
check "list (discovery + config)" 0 "${EXEC[@]}" list
check "list via package.json script" 0 "${RUNSCRIPT[@]}" e2e:list
check "validate"                  0 "${EXEC[@]}" validate
check "list --tag smoke"          0 "${EXEC[@]}" list --tag smoke
# A real run, through the documented `"test:e2e": "difmp run"` script. Exit 0.
check "test:e2e script (passing)" 0 "${RUNSCRIPT[@]}" test:e2e
# A failing verdict. Exit 1.
echo "### failing scenario" >> "$LOG"
CONSUMER_VERDICT=failed "${EXEC[@]}" run >> "$LOG" 2>&1
got=$?; echo "### -> exit $got (expected 1)" >> "$LOG"
if [ "$got" = 1 ]; then record PASS "failing scenario (exit 1)"; else record FAIL "failing scenario (exit $got, expected 1)"; fi
# An invalid spec, named explicitly so `exclude` does not hide it. Rejected before the browser.
check "invalid spec rejected"     2 "${EXEC[@]}" run tests/invalid/bad-frontmatter.e2e.md
# Selecting nothing is an explicit error, never a silent success.
check "no scenario selected"      2 "${EXEC[@]}" run tests/does-not-exist
# A quoted glob, matched by the harness rather than the shell.
check "quoted glob argument"      0 "${EXEC[@]}" run 'tests/**/project-create.e2e.md'

# The run directory and the report assets.
LAST=$(ls -1dt runs/*/ 2>/dev/null | head -1)
if [ -n "$LAST" ]; then
  for f in manifest.json contract.json result.json report.html junit.xml artifacts.json events.jsonl spec.e2e.md; do
    if [ -s "$LAST$f" ]; then record PASS "run directory: $f"; else record FAIL "run directory: $f missing or empty"; fi
  done
  # The standalone report has to open offline: no remote asset may be referenced.
  if grep -qE '(src|href)="https?://' "$LAST/report.html"; then
    record FAIL "report.html references a remote asset"
  else
    record PASS "report.html is self-contained"
  fi
  rm -f "$LAST/report.html"
  check "report <run-dir> rebuild" 0 "${EXEC[@]}" report "${LAST%/}"
  if [ -s "$LAST/report.html" ]; then record PASS "report.html rebuilt from the run directory"; else record FAIL "report.html not rebuilt"; fi
else
  record FAIL "no run directory was produced"
fi

# The dashboard assets ship inside the package and are served from it.
"${EXEC[@]}" run --ui --ui-port 45123 > ui.out 2>&1 &
CLI=$!
UIOK=fail
for _ in $(seq 1 300); do curl -sf -o /dev/null http://127.0.0.1:45123/api/health && { UIOK=ok; break; }; sleep 0.1; done
if [ "$UIOK" = ok ] && curl -sf http://127.0.0.1:45123/ | grep -q "__DIFMP_UI__"; then
  record PASS "dashboard served from the installed package"
else
  record FAIL "dashboard not served (see $DIR/ui.out)"
fi
wait $CLI

# The installed package must not reach back into the development workspace.
if [ -n "${DIFMP_REPO_ROOT:-}" ]; then
  HIT=$(grep -rl -- "$DIFMP_REPO_ROOT" node_modules/@decampsrenan/difmp/dist .yarn/unplugged 2>/dev/null | head -3)
  if [ -n "$HIT" ]; then record FAIL "installed package references the development workspace: $HIT"
  else record PASS "installed package references no workspace path"; fi
fi

kill $SRV 2>/dev/null
printf '%s\n' "${RESULTS[@]}"
echo "SUMMARY $PM/$KIND: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
