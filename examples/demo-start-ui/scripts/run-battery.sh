#!/usr/bin/env bash
#
# Run the demo.start-ui.com scenario battery with the scripted adapter by default.
#
# Prerequisites:
#   * `pnpm build` (or at least apps/cli + packages the config imports)
#   * Playwright Chromium for this repo's playwright version
#   * Network access to https://demo.start-ui.com
#
# Env:
#   DIFMP_PROVIDER=scripted|anthropic   (default scripted)
#   DIFMP_MODEL=…                       (required when provider needs a model id)
#   DIFMP_SCRIPT=auto|<name>            (scripted registry key; default auto)
#   DIFMP_EVALUATOR=jev                 (optional Jev criterion judge)
#   DIFMP_JEV_BACKEND=mock|typesafe|…   (default mock when DIFMP_EVALUATOR=jev)
#   DIFMP_BASE_URL=…                    (default https://demo.start-ui.com)
#   Extra args after -- are passed to `difmp run`.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG=$(cd "$HERE/.." && pwd)
REPO_ROOT=$(cd "$PKG/../.." && pwd)
DIFMP="$REPO_ROOT/apps/cli/dist/bin/difmp.js"

if [ ! -f "$DIFMP" ]; then
  echo "CLI not built: $DIFMP" >&2
  echo "run \`pnpm build\` from the repository root first" >&2
  exit 2
fi

PROVIDER="${DIFMP_PROVIDER:-scripted}"
FLAGS=(--provider "$PROVIDER")
if [ -n "${DIFMP_MODEL:-}" ]; then
  FLAGS+=(--model "$DIFMP_MODEL")
elif [ "$PROVIDER" = "anthropic" ]; then
  FLAGS+=(--model "${DIFMP_MODEL:-claude-sonnet-5}")
fi

if [ "$PROVIDER" != "scripted" ] && [ -z "${ANTHROPIC_API_KEY:-}" ] && [ "$PROVIDER" = "anthropic" ]; then
  echo "provider 'anthropic' needs ANTHROPIC_API_KEY in the environment" >&2
  exit 2
fi

echo "==> adapter: ${FLAGS[*]}"
echo "==> config:  $PKG/difmp.config.ts"
echo "==> target:  ${DIFMP_BASE_URL:-https://demo.start-ui.com}"

cd "$PKG"
exec node "$DIFMP" run --config difmp.config.ts "${FLAGS[@]}" "$@"
