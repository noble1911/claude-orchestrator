#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Build and publish release artifacts locally (no GitHub Actions minutes).

Usage:
  scripts/manual-release.sh --tag vX.Y.Z [options]

Options:
  --tag <tag>              Release tag (required), e.g. v0.1.3
  --target <target>        all | desktop | mobile (default: all)
  --repo <owner/name>      Primary repo for release uploads
                           (default: noble1911/claude-orchestrator)
  --no-upload              Build/package artifacts only; skip gh upload
  --create-releases        Create missing GitHub releases before upload
  --skip-install           Skip npm install steps (assume dependencies are already installed)
  --keep-version-files     Do not restore version files after build
  --tauri-key-file <path>  Path to Tauri updater private key file (minisign format)
  --tauri-key-password-file <path>
                           Read Tauri updater private key password from file (first line)
  --no-key-password-prompt Never prompt for key password when missing
  -h, --help               Show this help

Examples:
  scripts/manual-release.sh --tag v0.1.3 --target mobile
  scripts/manual-release.sh --tag v0.1.3 --target all --create-releases
  scripts/manual-release.sh --tag v0.1.3 --target desktop --tauri-key-file ~/.tauri/claude-orchestrator.key
EOF
}

log() {
  printf '[manual-release] %s\n' "$*"
}

fail() {
  printf '[manual-release] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

decode_base64() {
  local input="$1"
  local decoded
  if decoded="$(printf '%s' "$input" | base64 --decode 2>/dev/null)"; then
    printf '%s' "$decoded"
    return 0
  fi
  if decoded="$(printf '%s' "$input" | base64 -D 2>/dev/null)"; then
    printf '%s' "$decoded"
    return 0
  fi
  return 1
}

TAG=""
TARGET="all"
PRIMARY_REPO="noble1911/claude-orchestrator"
UPLOAD="true"
CREATE_RELEASES="false"
INSTALL_DEPS="true"
KEEP_VERSION_FILES="false"
TAURI_KEY_FILE=""
TAURI_KEY_PASSWORD_FILE=""
PROMPT_KEY_PASSWORD="true"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      [ $# -ge 2 ] || fail "--tag requires a value"
      TAG="$2"
      shift 2
      ;;
    --target)
      [ $# -ge 2 ] || fail "--target requires a value"
      TARGET="$2"
      shift 2
      ;;
    --repo)
      [ $# -ge 2 ] || fail "--repo requires a value"
      PRIMARY_REPO="$2"
      shift 2
      ;;
    --no-upload)
      UPLOAD="false"
      shift
      ;;
    --create-releases)
      CREATE_RELEASES="true"
      shift
      ;;
    --skip-install)
      INSTALL_DEPS="false"
      shift
      ;;
    --keep-version-files)
      KEEP_VERSION_FILES="true"
      shift
      ;;
    --tauri-key-file)
      [ $# -ge 2 ] || fail "--tauri-key-file requires a value"
      TAURI_KEY_FILE="$2"
      shift 2
      ;;
    --tauri-key-password-file)
      [ $# -ge 2 ] || fail "--tauri-key-password-file requires a value"
      TAURI_KEY_PASSWORD_FILE="$2"
      shift 2
      ;;
    --no-key-password-prompt)
      PROMPT_KEY_PASSWORD="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[ -n "$TAG" ] || fail "--tag is required (for example: --tag v0.1.3)"
if ! printf '%s' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'; then
  fail "Invalid tag format '$TAG'. Expected semantic version prefixed with v (for example v0.1.3)."
fi

case "$TARGET" in
  all|desktop|mobile) ;;
  *)
    fail "Invalid --target '$TARGET'. Expected one of: all, desktop, mobile"
    ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${TAG#v}"
DESKTOP_FILES=()
MOBILE_FILES=()
ALL_FILES=()
HAS_SIGNING="false"

BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claude-orchestrator-release.XXXXXX")"
RESTORE_LIST=""

backup_file() {
  local file="$1"
  mkdir -p "$BACKUP_DIR/$(dirname "$file")"
  cp "$file" "$BACKUP_DIR/$file"
  RESTORE_LIST="$RESTORE_LIST $file"
}

cleanup() {
  if [ "$KEEP_VERSION_FILES" != "true" ]; then
    for file in $RESTORE_LIST; do
      if [ -f "$BACKUP_DIR/$file" ]; then
        cp "$BACKUP_DIR/$file" "$file"
      fi
    done
  fi
  rm -rf "$BACKUP_DIR"
}

trap cleanup EXIT

sync_version_files() {
  log "Syncing version files to $VERSION from tag $TAG"

  backup_file "src-tauri/Cargo.toml"
  backup_file "src-tauri/tauri.conf.json"
  backup_file "mobile/app.json"

  awk -v version="$VERSION" '
    BEGIN { updated = 0 }
    !updated && /^version = "/ {
      print "version = \"" version "\""
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        exit 1
      }
    }
  ' src-tauri/Cargo.toml > src-tauri/Cargo.toml.tmp
  mv src-tauri/Cargo.toml.tmp src-tauri/Cargo.toml

  jq --arg version "$VERSION" '.version = $version' src-tauri/tauri.conf.json > src-tauri/tauri.conf.json.tmp
  mv src-tauri/tauri.conf.json.tmp src-tauri/tauri.conf.json

  jq --arg version "$VERSION" '.expo.version = $version' mobile/app.json > mobile/app.json.tmp
  mv mobile/app.json.tmp mobile/app.json
}

find_default_tauri_key_file() {
  local default_file="$HOME/.tauri/claude-orchestrator.key"
  if [ -f "$default_file" ]; then
    printf '%s' "$default_file"
    return 0
  fi

  local tauri_dir="$HOME/.tauri"
  [ -d "$tauri_dir" ] || return 1

  local matches=()
  local file=""
  while IFS= read -r -d '' file; do
    matches+=("$file")
  done < <(find "$tauri_dir" -maxdepth 1 -type f -name '*.key' -print0 2>/dev/null)

  if [ "${#matches[@]}" -eq 1 ]; then
    printf '%s' "${matches[0]}"
    return 0
  fi

  return 1
}

load_signing_material_from_files() {
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    local key_file=""
    key_file="${TAURI_KEY_FILE:-${TAURI_SIGNING_PRIVATE_KEY_FILE:-}}"
    if [ -z "$key_file" ]; then
      key_file="$(find_default_tauri_key_file || true)"
    fi

    if [ -n "$key_file" ]; then
      [ -f "$key_file" ] || fail "Tauri key file not found: $key_file"
      TAURI_SIGNING_PRIVATE_KEY="$(cat "$key_file")"
      export TAURI_SIGNING_PRIVATE_KEY
      log "Loaded updater signing key from $key_file"
    fi
  fi

  if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
    local password_file=""
    password_file="${TAURI_KEY_PASSWORD_FILE:-${TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE:-}}"
    if [ -n "$password_file" ]; then
      [ -f "$password_file" ] || fail "Tauri key password file not found: $password_file"
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(head -n 1 "$password_file" | tr -d '\r\n')"
      export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
      log "Loaded updater signing password from file"
    elif [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ "$PROMPT_KEY_PASSWORD" = "true" ] && [ -t 0 ]; then
      read -r -s -p "Tauri signing key password: " TAURI_SIGNING_PRIVATE_KEY_PASSWORD
      printf '\n'
      export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    fi
  fi
}

prepare_signing_env() {
  HAS_SIGNING="false"
  load_signing_material_from_files

  if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
    log "Updater signing key/password not set; building desktop artifacts without updater bundles"
    return
  fi

  local key="${TAURI_SIGNING_PRIVATE_KEY//$'\r'/}"
  local decoded=""

  if [[ "$key" == *"\\n"* ]]; then
    key="$(printf '%b' "$key")"
  fi

  if ! printf '%s' "$key" | grep -q '^untrusted comment:'; then
    if decoded="$(decode_base64 "$key")"; then
      if printf '%s' "$decoded" | grep -q '^untrusted comment:'; then
        key="$decoded"
      fi
    fi
  fi

  if ! printf '%s' "$key" | grep -q '^untrusted comment:'; then
    if printf '%s' "$key" | grep -Eq '^RW[0-9A-Za-z+/=]+$'; then
      key=$'untrusted comment: minisign encrypted secret key\n'"$key"
    fi
  fi

  if ! printf '%s' "$key" | grep -q '^untrusted comment:'; then
    log "Signing key format invalid; skipping updater artifact build"
    return
  fi

  if ! printf '%s\n' "$key" | grep -Eq '^RW[0-9A-Za-z+/=]+$'; then
    log "Signing key payload missing; skipping updater artifact build"
    return
  fi

  TAURI_SIGNING_PRIVATE_KEY="$(printf '%s' "$key" | base64 | tr -d '\n')"
  export TAURI_SIGNING_PRIVATE_KEY
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  HAS_SIGNING="true"
  log "Updater signing enabled"
}

build_desktop() {
  [ "$(uname -s)" = "Darwin" ] || fail "Desktop build requires macOS (for .app/.dmg generation)."
  require_cmd ditto
  require_cmd hdiutil
  require_cmd codesign

  if [ "$INSTALL_DEPS" = "true" ]; then
    log "Installing desktop dependencies"
    npm ci
  fi

  log "Building desktop frontend"
  npm run build

  prepare_signing_env

  if [ "$HAS_SIGNING" = "true" ]; then
    log "Building desktop app bundle with updater artifacts"
    npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":true}}'
  else
    log "Building desktop app bundle"
    npx tauri build --bundles app
  fi

  local app_source="src-tauri/target/release/bundle/macos/Claude Orchestrator.app"
  [ -d "$app_source" ] || fail "Desktop app bundle not found at: $app_source"

  mkdir -p builds release-assets
  rm -rf "builds/Claude Orchestrator.app" "builds/dmg-root"

  ditto "$app_source" "builds/Claude Orchestrator.app"
  if ! codesign --verify --deep --strict --verbose=2 "builds/Claude Orchestrator.app" >/dev/null 2>&1; then
    log "Re-signing app ad-hoc to avoid broken-signature warnings"
    codesign --force --deep --sign - "builds/Claude Orchestrator.app"
  fi

  mkdir -p "builds/dmg-root"
  ditto "builds/Claude Orchestrator.app" "builds/dmg-root/Claude Orchestrator.app"
  ln -sfn /Applications "builds/dmg-root/Applications"
  rm -f "builds/Claude Orchestrator.dmg"
  hdiutil create -volname "Claude Orchestrator" -srcfolder "builds/dmg-root" -ov -format UDZO "builds/Claude Orchestrator.dmg"

  local app_zip="release-assets/Claude-Orchestrator-${TAG}-macos-app.zip"
  local dmg_file="release-assets/Claude-Orchestrator-${TAG}-macos.dmg"
  rm -f "$app_zip" "$dmg_file"
  ditto -c -k --sequesterRsrc --keepParent "builds/Claude Orchestrator.app" "$app_zip"
  cp "builds/Claude Orchestrator.dmg" "$dmg_file"

  DESKTOP_FILES+=("$app_zip")
  DESKTOP_FILES+=("$dmg_file")

  if [ "$HAS_SIGNING" = "true" ]; then
    local updater_source updater_sig_source updater_file updater_sig_file latest_json
    updater_source="$(find src-tauri/target/release/bundle -type f -name '*.app.tar.gz' | head -n 1 || true)"
    updater_sig_source="$(find src-tauri/target/release/bundle -type f -name '*.app.tar.gz.sig' | head -n 1 || true)"
    if [ -n "$updater_source" ] && [ -n "$updater_sig_source" ]; then
      updater_file="Claude-Orchestrator-${TAG}-macos-updater.tar.gz"
      updater_sig_file="${updater_file}.sig"
      cp "$updater_source" "release-assets/$updater_file"
      cp "$updater_sig_source" "release-assets/$updater_sig_file"
      DESKTOP_FILES+=("release-assets/$updater_file")
      DESKTOP_FILES+=("release-assets/$updater_sig_file")

      local arch target_arch target_base release_url_base updater_sig_content updater_download_url update_pub_date
      arch="$(uname -m)"
      if [ "$arch" = "arm64" ]; then
        target_arch="aarch64"
      else
        target_arch="x86_64"
      fi
      target_base="darwin-${target_arch}"
      release_url_base="https://github.com/${PRIMARY_REPO}/releases/download/${TAG}"
      updater_sig_content="$(cat "release-assets/$updater_sig_file")"
      updater_download_url="${release_url_base}/${updater_file}"
      update_pub_date="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

      latest_json="release-assets/latest.json"
      jq -n \
        --arg version "$VERSION" \
        --arg notes "Release $VERSION" \
        --arg pub_date "$update_pub_date" \
        --arg target "$target_base" \
        --arg url "$updater_download_url" \
        --arg signature "$updater_sig_content" \
        '{
          version: $version,
          notes: $notes,
          pub_date: $pub_date,
          platforms: {
            ($target): { url: $url, signature: $signature },
            (($target + "-app")): { url: $url, signature: $signature }
          }
        }' > "$latest_json"
      DESKTOP_FILES+=("$latest_json")
    else
      log "Updater artifacts not found; skipping latest.json generation"
    fi
  fi
}

build_mobile() {
  require_cmd java

  if [ "$INSTALL_DEPS" = "true" ]; then
    log "Installing mobile dependencies"
    npm ci --prefix mobile
  fi

  log "Building Android APK"
  (
    cd mobile
    if [ ! -d android ]; then
      npx expo prebuild --platform android --non-interactive
    fi
    cd android
    chmod +x ./gradlew
    ./gradlew --no-daemon --parallel --build-cache assembleRelease
  )

  local apk_source
  apk_source="$(find mobile/android/app/build/outputs/apk/release -type f -name '*-release.apk' | head -n 1 || true)"
  [ -n "$apk_source" ] || fail "APK output not found under mobile/android/app/build/outputs/apk/release"

  mkdir -p release-assets
  local apk_target="release-assets/Claude-Orchestrator-${TAG}-android.apk"
  cp "$apk_source" "$apk_target"
  MOBILE_FILES+=("$apk_target")
}

ensure_release_exists() {
  local repo="$1"
  if gh release view "$TAG" --repo "$repo" >/dev/null 2>&1; then
    return 0
  fi
  if [ "$CREATE_RELEASES" = "true" ]; then
    log "Creating missing release $TAG in $repo"
    gh release create "$TAG" --repo "$repo" --title "$TAG" --notes "Manual release $TAG"
    return 0
  fi
  fail "Release $TAG not found in $repo. Re-run with --create-releases or create it first."
}

upload_files() {
  local repo="$1"
  shift
  local file
  for file in "$@"; do
    [ -f "$file" ] || continue
    log "Uploading $(basename "$file") to $repo:$TAG"
    gh release upload "$TAG" "$file" --repo "$repo" --clobber
  done
}

main() {
  require_cmd git
  require_cmd jq
  require_cmd npm
  require_cmd npx

  if [ "$UPLOAD" = "true" ] || [ "$CREATE_RELEASES" = "true" ]; then
    require_cmd gh
  fi

  sync_version_files

  rm -rf release-assets
  mkdir -p release-assets

  if [ "$TARGET" = "all" ] || [ "$TARGET" = "desktop" ]; then
    build_desktop
  fi

  if [ "$TARGET" = "all" ] || [ "$TARGET" = "mobile" ]; then
    build_mobile
  fi

  ALL_FILES=()
  local file
  for file in "${DESKTOP_FILES[@]-}"; do
    [ -n "$file" ] && ALL_FILES+=("$file")
  done
  for file in "${MOBILE_FILES[@]-}"; do
    [ -n "$file" ] && ALL_FILES+=("$file")
  done
  if [ "${#ALL_FILES[@]}" -eq 0 ]; then
    fail "No artifacts were generated."
  fi

  log "Artifacts ready:"
  for file in "${ALL_FILES[@]}"; do
    [ -f "$file" ] && printf '  - %s\n' "$file"
  done

  if [ "$UPLOAD" = "true" ]; then
    gh auth status >/dev/null 2>&1 || fail "gh is not authenticated. Run: gh auth login"
    ensure_release_exists "$PRIMARY_REPO"
    upload_files "$PRIMARY_REPO" "${ALL_FILES[@]}"
    log "Upload complete."
  else
    log "Upload skipped (--no-upload)."
  fi

  if [ "$KEEP_VERSION_FILES" = "true" ]; then
    log "Version files left at $VERSION (--keep-version-files)."
  else
    log "Version files restored to pre-run state."
  fi
}

main
