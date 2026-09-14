#!/usr/bin/env bash
#
# Spec §13, last bullet: pack `difmp`, install the TARBALL into consumer projects OUTSIDE
# this workspace, and prove the CLI works there with no development dependency of the harness
# present — for npm, pnpm and Yarn, and for ESM-typed and CommonJS-typed consumers.
#
#   run.sh [workdir] [package-manager...]      default: $TMPDIR/difmp-consumer-smoke, npm pnpm yarn
#
# External system dependency: a Chromium matching the repository's Playwright version must already
# be installed (`pnpm exec playwright install --with-deps chromium`). The consumers install
# `playwright` from the tarball's own dependencies and find the browsers in the shared
# `~/.cache/ms-playwright` — they never download one themselves.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI_DIR=$(cd "$HERE/../.." && pwd)
REPO_ROOT=$(cd "$CLI_DIR/../.." && pwd)

WORK="${1:-${TMPDIR:-/tmp}/difmp-consumer-smoke}"
shift 2>/dev/null || true
PMS=("$@")
[ ${#PMS[@]} -eq 0 ] && PMS=(npm pnpm yarn)

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export DIFMP_REPO_ROOT="$REPO_ROOT"

rm -rf "$WORK"
mkdir -p "$WORK/pack"

echo "==> packing difmp (pnpm pack runs prepack -> tsdown bundle)"
# `pnpm pack`, never `npm pack`: npm does not rewrite `workspace:*`, and the four @difmp/*
# workspace packages are bundled into the output rather than published.
( cd "$CLI_DIR" && pnpm pack --pack-destination "$WORK/pack" ) || exit 1
TGZ=$(ls -1 "$WORK"/pack/*.tgz | head -1)
echo "==> tarball: $TGZ"

echo "==> declared runtime dependencies of the tarball"
tar -xzOf "$TGZ" package/package.json | node -e '
let s = ""; process.stdin.on("data", (c) => { s += c }).on("end", () => {
  const deps = JSON.parse(s).dependencies ?? {}
  const workspace = Object.keys(deps).filter((n) => n.startsWith("@difmp/"))
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
        # `--allow-build=esbuild` is the remedy the README prescribes to users, so the matrix
        # installs the way the documentation says to. difmp pulls esbuild in through `tsx`;
        # pnpm 10 only warns and exits 0, but pnpm >= 12 turns the skipped build script into
        # ERR_PNPM_IGNORED_BUILDS and exits 1. A runner reaches pnpm 12 even when the workspace
        # is pinned to 10: `corepack enable` makes `pnpm` a shim, and these consumer projects
        # live outside the workspace with no `packageManager` field to pin it. The flag is
        # accepted and harmless on both versions.
        pnpm) pnpm add --allow-build=esbuild "$TGZ" ;;
        yarn)
          node -e 'const j=require("./package.json");j.packageManager="yarn@4.13.0";require("fs").writeFileSync("package.json",JSON.stringify(j,null,2))'
          printf 'nodeLinker: node-modules\nenableScripts: false\n' > .yarnrc.yml
          cp "$TGZ" ./difmp.tgz
          corepack yarn add ./difmp.tgz ;;
        # Yarn 1 (classic) caches a local tarball by NAME AND VERSION, so a rebuilt
        # `decampsrenan-difmp-0.0.2.tgz` would silently reinstall the previous bytes: copy it
        # under a fresh name every time.
        yarn1)
          cp "$TGZ" "./difmp-$(date +%s).tgz"
          yarn add "./$(ls -1t difmp-*.tgz | head -1)" ;;
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
