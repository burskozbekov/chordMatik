#!/usr/bin/env bash
#
# Publish a (already built + notarized) chordMatik release to GitHub.
#
# Uploads BOTH:
#   • chordMatik_X.Y.Z_aarch64.dmg   — versioned, for archival
#   • chordMatik-macOS-arm64.dmg     — stable name, so the public download link
#                                      NEVER changes between releases:
#
#     https://github.com/burskozbekov/chordMatik/releases/latest/download/chordMatik-macOS-arm64.dmg
#
# …plus the updater artifacts (app.tar.gz + .sig) and a generated latest.json.
#
# Run it AFTER building + notarizing + stapling (see UPDATER.md steps 1–5):
#   ./scripts/publish-release.sh
#
# Safe to re-run: if the release already exists, assets are replaced.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

REPO_URL="https://github.com/burskozbekov/chordMatik"
STABLE_NAME="chordMatik-macOS-arm64.dmg"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
TAG="v${VERSION}"
BUNDLE="src-tauri/target/release/bundle"
DMG="${BUNDLE}/dmg/chordMatik_${VERSION}_aarch64.dmg"
TARBALL="${BUNDLE}/macos/chordMatik.app.tar.gz"
SIG="${TARBALL}.sig"
STABLE_DMG="${BUNDLE}/dmg/${STABLE_NAME}"
LATEST_JSON="${BUNDLE}/latest.json"

# --- sanity: everything must already be built/notarized ------------------------
missing=0
for f in "$DMG" "$TARBALL" "$SIG"; do
  if [ ! -f "$f" ]; then
    echo "❌ missing: $f"
    missing=1
  fi
done
if [ "$missing" = "1" ]; then
  echo
  echo "Build + notarize first — see UPDATER.md (steps 1–5)."
  exit 1
fi

# Guard: package.json and tauri.conf.json must agree, or the updater will ignore
# the release (it only upgrades to a HIGHER semver than the installed build).
PKG_VERSION="$(node -p "require('./package.json').version")"
if [ "$PKG_VERSION" != "$VERSION" ]; then
  echo "❌ version mismatch: package.json=${PKG_VERSION} tauri.conf.json=${VERSION}"
  echo "   Bump both to the same version first."
  exit 1
fi

# --- re-pack the (stapled) app for the updater ---------------------------------
# The updater tarball must be rebuilt AFTER notarization/stapling, and it must
# be built WITHOUT AppleDouble metadata: macOS `tar` writes a `._chordMatik.app`
# entry for extended attributes, and the updater's Rust extractor fails on it
# ("failed to unpack `._chordMatik.app`") — an update that downloads and then
# silently never installs. COPYFILE_DISABLE=1 suppresses those entries.
APP="${BUNDLE}/macos/chordMatik.app"
xcrun stapler validate "$APP" >/dev/null 2>&1 || {
  echo "❌ ${APP} is not stapled — notarize + staple first (UPDATER.md step 3)."
  exit 1
}
rm -f "$TARBALL" "$SIG"
COPYFILE_DISABLE=1 tar -C "${BUNDLE}/macos" -czf "$TARBALL" chordMatik.app
# NOTE: macOS `tar tzf` HIDES AppleDouble entries when listing, so inspect the
# raw archive with Python — that is how the 13 `._*` entries went unnoticed.
python3 - "$TARBALL" <<'PY' || exit 1
import sys, tarfile
with tarfile.open(sys.argv[1]) as t:
    names = [m.name for m in t]
bad = [n for n in names if n.split("/")[-1].startswith("._")]
if bad:
    print(f"❌ updater tarball contains {len(bad)} AppleDouble (._) entries, e.g. {bad[0]} — the updater cannot extract it.")
    sys.exit(1)
if not names or not names[0].startswith("chordMatik.app"):
    print("❌ updater tarball must contain chordMatik.app/ at its root.")
    sys.exit(1)
print(f"→ updater tarball: {len(names)} entries, no AppleDouble metadata")
PY
KEY_FILE="${TAURI_SIGNING_KEY_FILE:-$HOME/.tauri/chordmatik_updater.key}"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  [ -f "$KEY_FILE" ] || { echo "❌ updater signing key not found at ${KEY_FILE}"; exit 1; }
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
fi
npx tauri signer sign "$TARBALL" >/dev/null
[ -f "$SIG" ] || { echo "❌ signing the updater tarball failed (no ${SIG})"; exit 1; }
echo "→ updater tarball re-packed from the stapled app + signed"

# --- stable-named copy → permanent download link ------------------------------
cp -f "$DMG" "$STABLE_DMG"

# --- latest.json for the auto-updater -----------------------------------------
SIG_PATH="$SIG" TAG="$TAG" VERSION="$VERSION" REPO_URL="$REPO_URL" \
node -e '
  const fs = require("fs");
  const out = {
    version: process.env.VERSION,
    pub_date: new Date().toISOString(),
    platforms: {
      "darwin-aarch64": {
        signature: fs.readFileSync(process.env.SIG_PATH, "utf8").trim(),
        url: `${process.env.REPO_URL}/releases/download/${process.env.TAG}/chordMatik_aarch64.app.tar.gz`,
      },
    },
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(out, null, 2));
' "$LATEST_JSON"

# latest.json references these exact FILENAMES. `gh`'s `file#name` syntax sets
# the asset *label*, not its name — using it here silently published a manifest
# pointing at a 404 (auto-update dead). Copy to the real names instead.
UPD_TARBALL="${BUNDLE}/macos/chordMatik_aarch64.app.tar.gz"
UPD_SIG="${UPD_TARBALL}.sig"
cp -f "$TARBALL" "$UPD_TARBALL"
cp -f "$SIG" "$UPD_SIG"

ASSETS=(
  "$DMG"
  "$STABLE_DMG"
  "$UPD_TARBALL"
  "$UPD_SIG"
  "$LATEST_JSON"
)

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "→ release ${TAG} exists — replacing assets"
  gh release upload "$TAG" --clobber "${ASSETS[@]}"
else
  echo "→ creating release ${TAG}"
  gh release create "$TAG" --target main \
    --title "chordMatik ${TAG}" \
    --notes "Installed apps auto-update to this version on next launch." \
    "${ASSETS[@]}"
fi

# --- verify the update chain actually resolves --------------------------------
# A manifest pointing at a missing asset kills auto-update silently, so never
# report success without checking. (GitHub's CDN can lag a few seconds.)
UPD_URL="${REPO_URL}/releases/download/${TAG}/chordMatik_aarch64.app.tar.gz"
echo "→ verifying updater asset…"
code=""
for _ in 1 2 3 4 5 6; do
  code=$(curl -sIL -o /dev/null -w "%{http_code}" "$UPD_URL" || true)
  [ "$code" = "200" ] && break
  sleep 5
done

echo
if [ "$code" = "200" ]; then
  echo "✅ Published ${TAG} — updater asset reachable"
else
  echo "⚠️  Published ${TAG}, but the updater asset returned HTTP ${code}."
  echo "   latest.json points at: ${UPD_URL}"
  echo "   Auto-update will FAIL until that asset exists under that exact name."
fi
echo
echo "   Permanent download link (put this on the site/README — never changes):"
echo "   ${REPO_URL}/releases/latest/download/${STABLE_NAME}"
