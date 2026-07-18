# Auto-update (chordMatik)

The app checks for updates **silently on every startup** and, if a newer signed
build exists, downloads + installs it in the background. The update applies the
**next time you launch** the app — no prompts, no forced restart. (A small pill
briefly confirms when an update was staged.)

This only runs in a **bundled, signed build** — under `npm run tauri dev` the
check just errors and is ignored.

---

## How it works

- **Plugin:** `tauri-plugin-updater` (Rust) + `@tauri-apps/plugin-updater` (JS).
- **In-app logic:** `src/components/AutoUpdater.tsx` (mounted once in `App.tsx`)
  calls `check()` → `downloadAndInstall()`.
- **Config:** `src-tauri/tauri.conf.json` → `plugins.updater`
  (`pubkey` + `endpoints`) and `bundle.createUpdaterArtifacts: true`.
- **Permission:** `updater:default` in `src-tauri/capabilities/default.json`.
- **Source:** GitHub Releases. The updater fetches `latest.json` from
  `https://github.com/OWNER/chordMatik/releases/latest/download/latest.json`.

## One-time setup

1. **Signing keys** — already generated:
   - Private key: `~/.tauri/chordmatik_updater.key` (password: empty). **Keep it
     secret + backed up.** If you lose it you can never sign updates again
     (you'd have to ship a new pubkey, which old installs won't trust).
   - Public key: already embedded in `tauri.conf.json` → `plugins.updater.pubkey`.

2. **Replace `OWNER`** in `tauri.conf.json` → `plugins.updater.endpoints` with
   your GitHub username, and make sure the repo is named `chordMatik` (or fix the
   URL). Create the repo and push:
   ```bash
   git init && git add -A && git commit -m "chordMatik"
   git branch -M main
   git remote add origin https://github.com/OWNER/chordMatik.git
   git push -u origin main
   ```

3. **GitHub Actions secret** (repo → Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` = the **contents** of `~/.tauri/chordmatik_updater.key`
     ```bash
     cat ~/.tauri/chordmatik_updater.key | pbcopy   # paste as the secret value
     ```
   - The key was generated with an **empty password**, so you do **not** need to
     create `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the workflow resolves the
     missing secret to an empty string, which matches. (If you later regenerate
     the key *with* a password, add that secret then.)

## Cutting a notarized release

Releases are built, signed, **and notarized locally** — GitHub CI cannot notarize
(the Developer ID certificate + notary credentials only exist on this Mac). The
CI `Release` workflow is a **manual-only unsigned fallback** (workflow_dispatch);
a tag push alone no longer publishes anything.

1. Bump the version in **both** `package.json` and `src-tauri/tauri.conf.json`
   (e.g. `0.1.1` → `0.1.2`). (`Cargo.toml` is cosmetic — the in-app footer reads
   the tauri.conf version — but bump it too for hygiene.) The updater only
   updates to a **higher** semver.
2. Build the signed release bundle:
   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/chordmatik_updater.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Sevki Bugra Ozbek (PCH6L56487)"
   export APPLE_TEAM_ID="PCH6L56487"
   npm run tauri build -- --features btc --bundles app,dmg
   ```
3. Notarize + staple (profile `retinatag-notary` is stored in the keychain):
   ```bash
   cd src-tauri/target/release/bundle
   xcrun notarytool submit dmg/*.dmg --keychain-profile retinatag-notary --wait
   xcrun stapler staple dmg/*.dmg
   xcrun stapler staple macos/chordMatik.app
   ```
4. Re-pack the **stapled** app for the updater and re-sign it:
   ```bash
   rm -f macos/chordMatik.app.tar.gz macos/chordMatik.app.tar.gz.sig
   tar -C macos -czf macos/chordMatik.app.tar.gz chordMatik.app
   (cd ../../../.. && npx tauri signer sign src-tauri/target/release/bundle/macos/chordMatik.app.tar.gz)
   ```
   If you rebuild the DMG by hand from the stapled app, **codesign the DMG**
   (`codesign --force --sign "Developer ID Application: …" --timestamp <dmg>`)
   before notarizing it, or Gatekeeper rejects the DMG container itself.
5. Verify: `spctl -a -vvv -t exec macos/chordMatik.app` → `accepted ·
   source=Notarized Developer ID`, and `stapler validate` both artifacts.
6. Publish — one command (from the repo root):
   ```bash
   ./scripts/publish-release.sh
   ```
   It reads the version from `tauri.conf.json`, generates `latest.json` from the
   `.sig`, and creates the release with all assets. Safe to re-run (replaces
   assets on an existing tag).

   **It also uploads a stable-named copy of the DMG**, so the public download
   link never changes between releases — this is the link to put on the site /
   README / anywhere users click:

   ```
   https://github.com/burskozbekov/chordMatik/releases/latest/download/chordMatik-macOS-arm64.dmg
   ```

   Clicking it downloads the installer directly (no GitHub page). Keep the
   `chordMatik-macOS-arm64.dmg` name identical in every release or the link breaks.

   <details><summary>Manual equivalent (if the script is unavailable)</summary>

   ```bash
   cp dmg/chordMatik_X.Y.Z_aarch64.dmg dmg/chordMatik-macOS-arm64.dmg
   # NOTE: `gh`'s file#name syntax sets the asset LABEL, not its name — the
   # updater downloads by filename, so copy to the exact names first.
   cp macos/chordMatik.app.tar.gz     macos/chordMatik_aarch64.app.tar.gz
   cp macos/chordMatik.app.tar.gz.sig macos/chordMatik_aarch64.app.tar.gz.sig
   gh release create vX.Y.Z --target main \
     dmg/chordMatik_X.Y.Z_aarch64.dmg \
     dmg/chordMatik-macOS-arm64.dmg \
     macos/chordMatik_aarch64.app.tar.gz \
     macos/chordMatik_aarch64.app.tar.gz.sig \
     latest.json
   ```
   Then confirm `…/releases/download/vX.Y.Z/chordMatik_aarch64.app.tar.gz`
   returns **200** — a manifest pointing at a 404 silently kills auto-update.
   `latest.json` shape: `{"version":"X.Y.Z","platforms":{"darwin-aarch64":
   {"signature":"<contents of the .sig>","url":"https://github.com/burskozbekov/chordMatik/releases/download/vX.Y.Z/chordMatik_aarch64.app.tar.gz"}}}`
   (upload the tar.gz under the exact name `chordMatik_aarch64.app.tar.gz`).
   </details>

   Done — installed apps silently update on next launch.

### Building/signing locally instead of CI
```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/chordmatik_updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
```
The signed artifacts land in `src-tauri/target/release/bundle/` — including
`*.app.tar.gz` + `*.app.tar.gz.sig`. Upload those + a hand-written `latest.json`
to a GitHub Release named after the tag.

`latest.json` schema (tauri-action generates this automatically; shown for reference):
```json
{
  "version": "0.1.1",
  "notes": "…",
  "pub_date": "2026-06-26T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of the .app.tar.gz.sig>",
      "url": "https://github.com/OWNER/chordMatik/releases/download/v0.1.1/chordMatik_0.1.1_aarch64.app.tar.gz"
    }
  }
}
```

## macOS notes / caveats

- The updater's minisign signature is **separate from Apple notarization**. The
  update mechanism works without an Apple Developer ID, but a non-notarized app
  is subject to Gatekeeper: macOS may quarantine the downloaded bundle. For a
  personal app on your own machine this is fine (right-click → Open, or
  `xattr -dr com.apple.quarantine /Applications/chordMatik.app`).
- For the updater to replace the running app it must be in a **writable**
  location — install it to `/Applications` (or `~/Applications`).
- Built for `aarch64-apple-darwin` (Apple Silicon). For Intel too, add the
  `x86_64-apple-darwin` target and a `darwin-x86_64` entry to `latest.json`
  (or build a `universal-apple-darwin` bundle).
- Runtime tools `yt-dlp` + `ffmpeg` are **not** bundled; they remain
  user-installed via Homebrew (unchanged by auto-update).
