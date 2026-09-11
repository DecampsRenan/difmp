#!/usr/bin/env bash
#
# Spec §13, last bullet: pack `@harness/cli`, install the TARBALL into consumer projects OUTSIDE
# this workspace, and prove the CLI works there with no development dependency of the harness
# present — for npm, pnpm and Yarn, and for ESM-typed and CommonJS-typed consumers.
#
#   run.sh [workdir] [package-manager...]      default: $TMPDIR/harness-consumer-smoke, npm pnpm yarn
#
# External system dependency: a Chromium matching the repository's Playwright version must already
# be installed (`pnpm exec playwright install --with-deps chromium`). The consumers install
# `playwright` from the tarball's own dependencies and find the browsers in the shared
# `~/.cache/ms-playwright` — they never download one themselves.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI_DIR=$(cd "$HERE/../.." && pwd)
REPO_ROOT=$(cd "$CLI_DIR/../.." && pwd)

WORK="${1:-${TMPDIR:-/tmp}/harness-consumer-smoke}"
shift 2>/dev/null || true
PMS=("$@")
[ ${#PMS[@]} -eq 0 ] && PMS=(npm pnpm yarn)

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export HARNESS_REPO_ROOT="$REPO_ROOT"

rm -rf "$WORK"
mkdir -p "$WORK/pack"

echo "==> packing @harness/cli (pnpm pack runs prepack -> tsdown bundle)"
# `pnpm pack`, never `npm pack`: npm does not rewrite `workspace:*`, and the four @harness/*
# workspace packages are bundled into the output rather than published.
( cd "$CLI_DIR" && pnpm pack --pack-destination "$WORK/pack" ) || exit 1
TGZ=$(ls -1 "$WORK"/pack/*.tgz | head -1)
echo "==> tarball: $TGZ"

echo "==> declared runtime dependencies of the tarball"
tar -xzOf "$TGZ" package/package.json | node -e '
let s = ""; process.stdin.on("data", (c) => { s += c }).on("end", () => {
  const deps = JSON.parse(s).dependencies ?? {}
  const workspace = Object.keys(deps).filter((n) => n.startsWith("@harness/"))
  for (const [n, v] of Object.entries(deps)) console.log(`    ${n}@${v}`)
  if (workspace.length > 0) {
    console.error(`FAIL: the tarball declares unpublishable dependencies: ${workspace.join(", ")}`)
    process.exit(1)
  }
})' || exit 1

STATUS=0
SUMMARY=()
for PM in "${PMS[@]}"; do
  for KIND in esm cjs; do
    DIR="$WORK/$PM-$KIND"
    echo
    echo "==> consumer $PM / $KIND  ($DIR)"
    "$HERE/scaffold.sh" "$DIR" "$KIND" || { SUMMARY+=("SCAFFOLD FAILED $PM/$KIND"); STATUS=1; continue; }
    (
      cd "$DIR"
      case "$PM" in
        npm)  npm install "$TGZ" ;;
        pnpm) pnpm add "$TGZ" ;;
        yarn)
          node -e 'const j=require("./package.json");j.packageManager="yarn@4.13.0";require("fs").writeFileSync("package.json",JSON.stringify(j,null,2))'
          printf 'nodeLinker: node-modules\nenableScripts: false\n' > .yarnrc.yml
          cp "$TGZ" ./harness-cli.tgz
          corepack yarn add ./harness-cli.tgz ;;
        # Yarn 1 (classic) caches a local tarball by NAME AND VERSION, so a rebuilt
        # `harness-cli-0.1.0.tgz` would silently reinstall the previous bytes: copy it under a
        # fresh name every time.
        yarn1)
          cp "$TGZ" "./harness-cli-$(date +%s).tgz"
          yarn add "./$(ls -1t harness-cli-*.tgz | head -1)" ;;
      esac
    ) > "$DIR/install.log" 2>&1
    if [ $? -ne 0 ]; then
      echo "install failed — $DIR/install.log"; tail -30 "$DIR/install.log"
      SUMMARY+=("INSTALL FAILED $PM/$KIND"); STATUS=1; continue
    fi
    OUT=$("$HERE/verify.sh" "$DIR" "$PM" "$KIND" 2>&1); RC=$?
    echo "$OUT"
    SUMMARY+=("$(echo "$OUT" | tail -1)")
    [ $RC -ne 0 ] && STATUS=1
  done
done

echo
echo "================ consumer matrix ================"
printf '%s\n' "${SUMMARY[@]}"
exit $STATUS
