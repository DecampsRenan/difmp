#!/usr/bin/env bash
#
# Spec §12: run the example scenarios with the SCRIPTED adapter through the DISTRIBUTED CLI.
#
#   run-examples.sh [workdir] [variant...]     default workdir: $TMPDIR/harness-dist-cli
#                                              default variants: healthy alt-layout
#
# `HARNESS_PROVIDER` (default `scripted`) and `HARNESS_MODEL` select the adapter. The optional
# real-model smoke job sets them to `anthropic` and a model id; every other caller leaves them
# alone and gets the deterministic, network-free double.
#
# The binary under test is the one inside the packed tarball, installed with npm into a directory
# outside this workspace — not `apps/cli/dist` and not a workspace symlink. The scenarios, the
# support config and the demo app do come from the checkout: they are the project under test.
#
# External system dependencies:
#   * Chromium matching the repository's Playwright version, already installed
#     (`pnpm exec playwright install --with-deps chromium`) plus its Linux shared libraries.
#   * `pnpm run build` must have produced `examples/fixture-app/dist` and `examples/support`.
# No network access is needed at run time: the adapter is `scripted` and the app is local.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI_DIR=$(cd "$HERE/../.." && pwd)
REPO_ROOT=$(cd "$CLI_DIR/../.." && pwd)

WORK="${1:-${TMPDIR:-/tmp}/harness-dist-cli}"
shift 2>/dev/null || true
VARIANTS=("$@")
[ ${#VARIANTS[@]} -eq 0 ] && VARIANTS=(healthy alt-layout)

PROVIDER="${HARNESS_PROVIDER:-scripted}"
PROVIDER_FLAGS=(--provider "$PROVIDER")
[ -n "${HARNESS_MODEL:-}" ] && PROVIDER_FLAGS+=(--model "$HARNESS_MODEL")
if [ "$PROVIDER" != "scripted" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "provider '$PROVIDER' needs ANTHROPIC_API_KEY in the environment" >&2
  exit 2
fi
echo "==> adapter: ${PROVIDER_FLAGS[*]}"

APP_MAIN="$REPO_ROOT/examples/fixture-app/dist/main.js"
if [ ! -f "$APP_MAIN" ]; then
  echo "the demo app is not built: $APP_MAIN" >&2
  echo "run \`pnpm typecheck\` (the project-references build emits it) or" >&2
  echo "\`pnpm --filter @harness/fixture-app build\` — \`pnpm build\` alone does NOT cover examples/*" >&2
  exit 2
fi

rm -rf "$WORK"; mkdir -p "$WORK/pack" "$WORK/consumer"

echo "==> packing and installing the distributed CLI"
( cd "$CLI_DIR" && pnpm pack --pack-destination "$WORK/pack" ) >/dev/null || exit 1
TGZ=$(ls -1 "$WORK"/pack/*.tgz | head -1)
( cd "$WORK/consumer" && npm init -y >/dev/null && npm install --no-audit --no-fund "$TGZ" ) >/dev/null || exit 1
HARNESS="$WORK/consumer/node_modules/.bin/harness"
[ -x "$HARNESS" ] || { echo "no harness bin at $HARNESS" >&2; exit 1; }
echo "==> $("$HARNESS" --version | head -1)"

STATUS=0
for VARIANT in "${VARIANTS[@]}"; do
  echo
  echo "==> variant: $VARIANT"
  APPLOG="$WORK/app-$VARIANT.log"
  node "$APP_MAIN" \
    --port 0 --variant "$VARIANT" --seed \
    --seed-email demo@example.test --seed-password demo-password > "$APPLOG" 2>&1 &
  APP=$!
  for _ in $(seq 1 200); do grep -q '^x-seed-token: ' "$APPLOG" 2>/dev/null && break; sleep 0.1; done
  URL=$(sed -n 's/^fixture-app listening on \([^ ]*\).*/\1/p' "$APPLOG")
  TOKEN=$(sed -n 's/^x-seed-token: //p' "$APPLOG")
  if [ -z "$URL" ] || [ -z "$TOKEN" ]; then
    echo "the demo app never started:"; cat "$APPLOG"; kill $APP 2>/dev/null; STATUS=1; continue
  fi
  echo "    app: $URL"

  # The CLI is invoked from the repository root because the scenarios and the support config live
  # there; `--config` is explicit so discovery does not depend on the working directory.
  ( cd "$REPO_ROOT" && \
    HARNESS_BASE_URL="$URL" \
    FIXTURE_APP_SEED_TOKEN="$TOKEN" \
    FIXTURE_APP_VARIANT="$VARIANT" \
    "$HARNESS" run \
      --config examples/support/harness.config.ts \
      "${PROVIDER_FLAGS[@]}" \
      --reporter console --reporter junit \
      --output "$WORK/runs/$VARIANT" )
  RC=$?
  echo "    exit $RC"
  [ $RC -ne 0 ] && STATUS=1
  kill $APP 2>/dev/null; wait $APP 2>/dev/null
done

echo
echo "==> run directories: $WORK/runs"
exit $STATUS
