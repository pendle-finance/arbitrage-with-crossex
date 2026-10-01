#!/bin/bash
set -euo pipefail

TAG="${1:-${GITHUB_REF_NAME:-}}"
REPO="${GITHUB_REPOSITORY:-pendle-finance/arbitrage-with-crossex}"
OUT=out
FILES=(app.tar.gz app.zip install.sh install.ps1)

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || fail "tag '$TAG' is not vX.Y.Z or vX.Y.Z-rc.N"
COMMIT="$(git rev-parse --verify "$TAG^{commit}")"
VERSION_JSON="$(git show "$COMMIT:version.json")"
VERSION="$(jq -r '.version' <<<"$VERSION_JSON")"
TAG_VERSION="${TAG#v}"
TAG_VERSION="${TAG_VERSION%-rc.*}"
[ "$TAG_VERSION" = "$VERSION" ] || fail "tag $TAG does not match version.json ($VERSION)"

rm -rf "$OUT"
mkdir -p "$OUT"
PREFIX="${REPO#*/}-${TAG#v}/"
git archive --format=tar.gz --prefix="$PREFIX" -o "$OUT/app.tar.gz" "$COMMIT"
git archive --format=zip --prefix="$PREFIX" -o "$OUT/app.zip" "$COMMIT"
git show "$COMMIT:install.sh" >"$OUT/install.sh"
git show "$COMMIT:install.ps1" >"$OUT/install.ps1"

jq -n \
  --arg version "$VERSION" \
  --arg commit "$COMMIT" \
  --argjson highlights "$(jq '.highlights // []' <<<"$VERSION_JSON")" \
  --arg tgz "$(sha "$OUT/app.tar.gz")" \
  --arg zip "$(sha "$OUT/app.zip")" \
  --arg sh "$(sha "$OUT/install.sh")" \
  --arg ps1 "$(sha "$OUT/install.ps1")" \
  '{version: $version, commit: $commit, highlights: $highlights,
    files: {"app.tar.gz": $tgz, "app.zip": $zip, "install.sh": $sh, "install.ps1": $ps1}}' \
  >"$OUT/release.json"

PREV="$(git describe --tags --abbrev=0 --match 'v*' --exclude '*-rc.*' "$COMMIT^" 2>/dev/null || true)"
BASE="${PREV:-$(git hash-object -t tree /dev/null)}"
READ_FIRST="$(git diff --name-only "$BASE" "$COMMIT" -- .github/workflows install.sh install.ps1 update.ps1 | paste -sd ',' - | sed 's/,/, /g')"

{
  echo "## $TAG"
  echo
  echo "- Version: $VERSION"
  echo "- Commit: \`$COMMIT\`"
  if [ -n "$PREV" ]; then
    echo "- Changes since $PREV: https://github.com/$REPO/compare/$PREV...$TAG"
  else
    echo "- Changes: first release, no earlier tag"
  fi
  echo "- Read these first: ${READ_FIRST:-none}"
  echo
  echo "| File | SHA-256 |"
  echo "|---|---|"
  for f in "${FILES[@]}"; do echo "| $f | \`$(sha "$OUT/$f")\` |"; done
} >"$OUT/notes.md"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$OUT/notes.md" >>"$GITHUB_STEP_SUMMARY"; fi
