---
name: release
description: Cut a new release of @decampsrenan/difmp and publish it to npm. Use when the user wants to release, cut a release, bump the difmp version, publish difmp to npm, tag a new version, or asks for a new difmp release.
---

# release — cut and publish a new difmp version

The distributable is `@decampsrenan/difmp` (`apps/cli`); the private `@difmp/*` workspace
packages are bundled into its artifact and never published. Releasing = bump the version, land it on
`main` through a PR (the branch is protected), tag it, and let `.github/workflows/release.yml`
publish to npm with **trusted publishing** (OIDC, no npm token).

The current published version is the baseline — never pick a version that is already on the
registry: the workflow's guard skips an existing version, and npm rejects a republish anyway.

## Steps

1. **Pick the next version.** Semver, strictly greater than the published one
   (`npm view @decampsrenan/difmp version`). The repo is pre-stable (0.x), so keep bumping
   within 0.x per semver intent. The number you pick is what the tag will carry.
   Completion: a version, greater than the published one, that you could write in a tag.

2. **Bump the version.** Edit `version` in `apps/cli/package.json` — the only published field that
   matters; leave the private `@difmp/*` packages at their own versions. If the old version appears
   as a literal elsewhere (README tarball names `decampsrenan-difmp-<ver>.tgz`, the
   `consumer-smoke` comments), update those too.
   Completion: `apps/cli/package.json` and every literal reference agree on the new version.

3. **Verify before tagging.** Run the release gates:
   - `pnpm run typecheck`
   - `pnpm run test`
   - `bash apps/cli/scripts/consumer-smoke/run.sh /tmp/difmp-consumer-smoke npm pnpm` (needs
     Chromium first: `pnpm exec playwright install chromium`)
     Completion: typecheck and all test suites green, consumer matrix 24/24 in every cell.

4. **Commit.** Conventional message naming the version, e.g. `chore(release): 0.0.2`. Never stage
   `dist/`, `*.tgz`, or `.recon/` (all gitignored).
   Completion: a commit containing exactly the version bump and its doc/script touch-ups.

5. **Land it on `main` via PR.** Direct pushes to `main` are rejected
   ("changes must be made through a pull request"). Push a branch, open a PR (`gh pr create --base
main`), get it merged. Then `git fetch origin main` and reset local `main` to `origin/main`.
   Completion: `git rev-parse origin/main` includes the release commit.

6. **Tag the merged commit.** The tag must point at a commit that is on `main`, not at your
   pre-merge branch commit (a squash or rebase merge would leave that commit off the branch):
   - `git tag v0.0.2 origin/main`
   - `git push origin v0.0.2`
     Completion: `git ls-remote origin refs/tags/v0.0.2` matches `git rev-parse origin/main`.

7. **Let the workflow publish.** `release.yml` runs on the tag push: it resolves the version from
   `apps/cli/package.json`, rebuilds via `prepack` (UI + tsdown bundle), skips if the version is
   already on the registry, else publishes through OIDC. Watch it:
   `gh run watch --run-id <release-run-id>` (filter with `gh run list --workflow=release`).
   Completion: the `release` workflow finishes green, with either a publish or an explicit skip.

8. **Verify the publish.** `npm view @decampsrenan/difmp version` returns the new version. Then
   install-and-run from a scratch consumer to prove the shipped artifact works:
   - `mkdir /tmp/difmp-verify && cd /tmp/difmp-verify && npm init -y`
   - `npm i -D @decampsrenan/difmp` then `npx --no-install difmp --version` → prints the new
     version, and a scripted run against the bundled example turns green.
     Completion: `difmp --version` prints the new version and a `scripted` run passes.

## Caveats

- **If trusted publishing is not configured**, the workflow cannot publish. On npmjs.com: package
  settings → Trusted Publisher → GitHub Actions → owner `DecampsRenan`, repo `difmp`, workflow
  `release.yml`. Until then, publish manually with an OTP from the user's authenticator:
  `pnpm --filter @decampsrenan/difmp publish --no-git-checks --otp <6-digit>`. The tag still
  triggers the workflow, but the guard skips the now-published version.
- **The OIDC path is unproven in CI.** 0.0.1 was published manually; the first `release` run only
  exercised the skip guard. If `pnpm publish` does not relay the GitHub OIDC token on a real
  release, switch `release.yml` to `npm publish` (it already has `id-token: write` and
  `registry-url`) — the npm CLI handles OIDC natively.
- **pnpm consumers:** `esbuild` arrives transitively through `tsx`, and pnpm ≥ 12 refuses ignored
  build scripts — `pnpm i -D @decampsrenan/difmp` needs `--allow-build=esbuild`.
- **prepack replaces `apps/cli/dist`** with the bundled artifact. If you then work in-repo, restore
  the `tsc -b` layout with `pnpm --filter @decampsrenan/difmp build`.
- The tag must equal the `apps/cli/package.json` version. A mismatch does not fail the workflow
  loudly (it publishes whatever the manifest says), so check it before pushing the tag.
