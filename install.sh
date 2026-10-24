#!/bin/sh
# Install Wisp without questions: curl -fsSL https://wisp.pages.dev/install | sh
# Join instead: ... | sh -s join [invite-link]
# Legacy: --hub-server, --hub URL --token VALUE, --name NAME, --dir DIR,
# --yes, --no-service, --no-device and --no-open are still accepted.
set -eu

WARREN_REPO="${WARREN_REPO:-https://github.com/eireijie/warren.git}"
DIR="${WARREN_DIR:-$HOME/warren}"
MODE=hub HUB= TOKEN= NAME= INVITE= SERVICE=1 DEVICE=1 OPEN=1
fail() { printf '%s\n' "✗ $*" >&2; exit 1; }
value() { [ -n "$2" ] || fail "$1 needs a value."; }
while [ $# -gt 0 ]; do
  case "$1" in
    join) MODE=join; if [ $# -gt 1 ]; then case "$2" in -*) ;; *) INVITE="$2"; shift ;; esac; fi ;;
    --hub-server) MODE=hub ;;
    --hub) value "$1" "${2:-}"; HUB="$2"; MODE=device; shift ;;
    --token) value "$1" "${2:-}"; TOKEN="$2"; shift ;;
    --name) value "$1" "${2:-}"; NAME="$2"; shift ;;
    --dir) value "$1" "${2:-}"; DIR="$2"; shift ;;
    --yes|-y) : ;;
    --no-service) SERVICE= ;;
    --no-device) DEVICE= ;;
    --no-open) OPEN= ;;
    -h|--help) printf '%s\n' 'Wisp' 'Usage: install.sh [join [invite-link]] [--dir DIR] [--no-service] [--no-open]' 'Legacy: --hub-server | --hub URL --token VALUE [--name NAME]'; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done
# Invite links work in the older address option too.
case "$HUB" in */join/*) MODE=join; INVITE="$HUB" ;; esac
if [ "$MODE" = device ]; then [ -n "$HUB" ] && [ -n "$TOKEN" ] || fail 'Use join [invite-link], or provide both --hub and --token.'; fi
printf '%s\n' 'Wisp'
command -v git >/dev/null 2>&1 || fail 'Install Git, then run this installer again.'
command -v curl >/dev/null 2>&1 || fail 'Install curl, then run this installer again.'
mkdir -p "$HOME/.warren/runtime"
LOG="$HOME/.warren/install.log"
TEMP=$(mktemp -d "${TMPDIR:-/tmp}/wisp-install.XXXXXX")
trap 'rm -rf "$TEMP"' EXIT HUP INT TERM
quiet() { "$@" >>"$LOG" 2>&1 || fail "Couldn't finish getting ready; check $LOG and run wisp doctor."; }
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
RUNTIME="$HOME/.warren/runtime/node"
if command -v node >/dev/null 2>&1 && [ "$(node_major "$(command -v node)")" -ge 22 ]; then
  NODE=$(command -v node)
elif [ -x "$RUNTIME/bin/node" ] && [ "$(node_major "$RUNTIME/bin/node")" -ge 22 ]; then
  NODE="$RUNTIME/bin/node"
else
  case "$(uname -s)" in Darwin) system=darwin ;; Linux) system=linux ;; *) fail 'Use install.ps1 on Windows.' ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; armv7l) arch=armv7l ;; *) fail 'This computer needs a supported Node 22 installation.' ;; esac
  printf '%s\n' '◌ Getting Node 22 ready…'
  quiet curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$TEMP/SHASUMS256.txt"
  archive=$(awk -v suffix="-$system-$arch.tar.gz" '$2 ~ (suffix "$") {print $2; exit}' "$TEMP/SHASUMS256.txt")
  [ -n "$archive" ] || fail 'Node 22 is unavailable for this computer.'
  quiet curl -fsSL "https://nodejs.org/dist/latest-v22.x/$archive" -o "$TEMP/$archive"
  expected=$(awk -v file="$archive" '$2 == file {print $1}' "$TEMP/SHASUMS256.txt")
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$TEMP/$archive" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$TEMP/$archive" | awk '{print $1}')
  else fail 'Install a SHA-256 checker, then run this installer again.'; fi
  [ "$actual" = "$expected" ] || fail 'The Node 22 download was incomplete; run this installer again.'
  mkdir -p "$TEMP/runtime"
  quiet tar -xzf "$TEMP/$archive" -C "$TEMP/runtime" --strip-components=1
  rm -rf "$RUNTIME"
  mv "$TEMP/runtime" "$RUNTIME"
  NODE="$RUNTIME/bin/node"
  printf '%s\n' '✓ Downloaded Node 22'
fi
export PATH="$(dirname "$NODE"):$PATH"
# Update only a clean checkout; never discard someone's local changes.
if [ -d "$DIR/.git" ]; then
  quiet git -C "$DIR" pull --ff-only
else
  [ ! -e "$DIR" ] || fail "$DIR exists; choose another folder with --dir."
  quiet git clone "$WARREN_REPO" "$DIR"
fi
cd "$DIR"
DIR=$(pwd -P)
printf '%s\n' '◌ Getting Wisp ready…'
quiet npm ci --no-audit --no-fund --loglevel=error
quiet npm ci --prefix bin --no-audit --no-fund --loglevel=error
if [ "$MODE" = hub ]; then quiet npm run build --silent; fi
printf '%s\n' '✓ Downloaded Wisp'
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
# Wrappers keep using the selected runtime in new terminals without a system Node.
"$NODE" --input-type=commonjs - "$BIN" "$DIR" "$NODE" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const [bin, dir, node] = process.argv.slice(2);
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
for (const name of ['wisp', 'warren', 'warren-mcp', 'warren-hub']) {
  const file = path.join(bin, name);
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.writeFileSync(file, '#!/bin/sh\nexec ' + quote(node) + ' ' + quote(path.join(dir, 'bin', (name === 'wisp' ? 'warren' : name) + '.mjs')) + ' "$@"\n', { mode: 0o755 });
}
JS
export PATH="$BIN:$PATH"
case "${SHELL:-}" in */zsh) profile="$HOME/.zshrc" ;; */bash) profile="$HOME/.bashrc" ;; *) profile="$HOME/.profile" ;; esac
if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$profile" 2>/dev/null; then printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$profile"; fi
if [ "$MODE" = join ]; then
  set --
  [ -z "$INVITE" ] || set -- "$INVITE"
  [ -z "$NAME" ] || set -- "$@" --name "$NAME"
  [ -n "$SERVICE" ] || set -- "$@" --no-service
  wisp join "$@"
elif [ "$MODE" = device ]; then
  set -- --hub "$HUB" --token "$TOKEN"
  [ -z "$NAME" ] || set -- "$@" --name "$NAME"
  if [ -n "$SERVICE" ]; then quiet wisp service install node "$@"; printf '%s\n' '✓ This computer joined'
  else printf '%s\n' '✓ Installed Wisp; use the existing connection flags with wisp node start'; fi
elif [ -n "$SERVICE" ]; then
  quiet wisp service install hub
  P="${PORT:-4747}"
  up=
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$P/healthz" >/dev/null 2>&1; then up=1; break; fi
    sleep 1
  done
  [ -n "$up" ] || fail 'Wisp did not start; run wisp doctor.'
  printf '%s\n' '✓ Started Wisp (starts again when you log in)'
  if [ -n "$DEVICE" ]; then
    set -- --local
    [ -z "$NAME" ] || set -- "$@" --name "$NAME"
    if wisp service install node "$@" >>"$LOG" 2>&1; then printf '%s\n' '✓ This computer is ready to join when you finish getting ready'
    else printf '%s\n' '✗ This computer needs a check; run wisp doctor'; fi
    # A connected computer also prepares its VM image in the background.
    printf '%s\n' '◌ Getting computers ready for agents…'
  fi
  apps=
  for app in claude codex gemini hermes kimi qwen; do
    if command -v "$app" >/dev/null 2>&1; then apps="${apps:+$apps, }$app"; fi
  done
  if [ -n "$apps" ]; then printf '%s\n' "✓ Found agent apps: $apps"; else printf '%s\n' '◌ Agent apps can be added in Wisp'; fi
  if command -v tailscale >/dev/null 2>&1 || [ -e /Applications/Tailscale.app ]; then printf '%s\n' '✓ Found Tailscale'; fi
  URL="http://localhost:$P"
  printf '%s\n' "Opening Wisp in your browser… $URL"
  if [ -n "$OPEN" ] && [ -z "${SSH_CONNECTION:-}" ]; then
    if [ "$(uname -s)" = Darwin ]; then open "$URL" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1 && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then (xdg-open "$URL" >/dev/null 2>&1 &) || true; fi
  fi
else
  printf '%s\n' '✓ Installed Wisp; start it with: wisp service install hub'
fi
printf '%s\n' 'Other computers → Install Wisp there, then run wisp join' 'Phones → Open Add a device in Wisp and scan the code' 'Stuck? → wisp doctor'
