#!/usr/bin/env bash
#
# dsh-voice-input installer (dual-face bundle: Tencent STT proxy + composer mic)
# Installs into a DSH profile without needing pnpm or the dsh CLI.
#
# Usage: ./install.sh [--profile <name>]   (default profile: web)
#
# The plugin must live INSIDE the profile tree (vendor/) so its lib/index.js
# can resolve the @deepseek-ai/* peer dependencies from the profile's own
# node_modules — the same trick dsh-tavily-firecrawl uses.
#
# Requirements: bash, node. Idempotent: re-running is safe.
set -euo pipefail

DIST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="web"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --profile=*) PROFILE="${1#--profile=}"; shift ;;
    -h|--help) sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
BEGIN_MARKER="# --- dsh-voice-input: begin ---"
END_MARKER="# --- dsh-voice-input: end ---"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "error: profile not found at $PROFILE_DIR (run dsh web once first)" >&2
  exit 1
fi

echo "==> Installing dsh-voice-input"
echo "    DSH_HOME : $DSH_HOME"
echo "    profile  : $PROFILE ($PROFILE_DIR)"

# 1. bundle package into vendor/ ----------------------------------------------
mkdir -p "$PROFILE_DIR/vendor/dsh-voice-input" "$PROFILE_DIR/node_modules"
cp -R "$DIST_DIR/lib" "$PROFILE_DIR/vendor/dsh-voice-input/"
cp "$DIST_DIR/package.json" "$DIST_DIR/cordis.patch.yml" "$PROFILE_DIR/vendor/dsh-voice-input/"
echo "==> bundle package copied to $PROFILE_DIR/vendor/dsh-voice-input"

# 2. node_modules symlink (the loader resolves the bare package name) ----------
ln -sfn ../vendor/dsh-voice-input "$PROFILE_DIR/node_modules/dsh-voice-input"
echo "==> node_modules symlink created"

# 3. profile manifest: create if missing, always record the link: dep ----------
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  cat > "$PROFILE_DIR/package.json" <<PROFILEJSON
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
PROFILEJSON
  echo "==> created profile manifest $PROFILE_DIR/package.json"
fi
node - "$PROFILE_DIR/package.json" <<'NODE'
const fs = require('fs')
const [path] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'))
pkg.dependencies = { ...(pkg.dependencies ?? {}), 'dsh-voice-input': 'link:./vendor/dsh-voice-input' }
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
NODE
echo "==> dependency recorded in profile manifest"

# 4. wiring patch into cordis.patch.yml (idempotent) ---------------------------
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
if grep -q "voice-input" "$PATCH_FILE" 2>/dev/null; then
  echo "==> wiring patch already present, skipping"
else
  node - "$PATCH_FILE" "$BEGIN_MARKER" "$END_MARKER" "$DIST_DIR" <<'NODE'
const fs = require('fs')
const [path, begin, end, distDir] = process.argv.slice(2)
const block = fs.readFileSync(require('path').join(distDir, 'cordis.patch.yml'), 'utf8').trim()
// A fresh profile's patch is a comment header plus the empty-array `[]`
// placeholder. Appending after `[]` would start a second YAML document, so
// strip comment lines and decide replace-vs-append on the real body.
const body = fs.readFileSync(path, 'utf8').split('\n')
  .filter(l => l.trim() && !l.trim().startsWith('#')).join('\n').trim()
const content = begin + '\n' + block + '\n' + end + '\n'
if (body === '[]' || body === '') {
  fs.writeFileSync(path, content)
} else {
  fs.appendFileSync(path, '\n' + content)
}
NODE
  echo "==> wiring patch merged into $PATCH_FILE"
fi

# 5. keys file ----------------------------------------------------------------
if [ ! -f "$DSH_HOME/.env" ]; then
  cat > "$DSH_HOME/.env" <<'ENVEOF'
# dsh-voice-input: uncomment and fill in your Tencent Cloud keys, then restart.
#TENCENTCLOUD_SECRET_ID=AKIDxxxx
#TENCENTCLOUD_SECRET_KEY=xxxx
#TENCENTCLOUD_APPID=1234567890
ENVEOF
  chmod 600 "$DSH_HOME/.env"
  echo "==> created $DSH_HOME/.env (add your keys there)"
else
  echo "==> $DSH_HOME/.env exists — add TENCENTCLOUD_SECRET_ID/KEY/APPID if missing"
fi

cat <<'DONE'

==> Done. Next steps:
  1. Add your keys in $DSH_HOME/.env (TENCENTCLOUD_SECRET_ID / _KEY / _APPID).
  2. Restart dsh (your usual dsh web command).
  3. The mic appears in the composer tool row; engine/AppId card is under
     Settings → Plugins → 插件配置 → 语音识别设置.
DONE
