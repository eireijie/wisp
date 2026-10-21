#!/usr/bin/env bash
# Install Warren on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/eireijie/warren/main/install.sh | bash
#
# With no options it asks what this computer is for. Options:
#   --hub-server                 run the hub here (the workspace and web app), started at boot/login
#   --hub URL --token T [--name N]
#                                connect this computer to a hub as a device (from Warren → Devices → Add device)
#   --dir DIR                    where to put Warren (default ~/warren, or $WARREN_DIR)
#   --yes                        don't ask before installing a VM engine during `warren setup`
#   --no-service                 install only; don't start anything
#   --no-device                  with --hub-server: don't also make this computer a device for agents
#   --no-open                    don't open the browser at the end
#
# It checks for git and Node 22+, clones (or updates) Warren, installs its dependencies, puts the
# `warren` command on your PATH, and sets it up to keep running. Nothing is installed with sudo.
set -euo pipefail

WARREN_REPO="${WARREN_REPO:-https://github.com/eireijie/warren.git}"
DIR="${WARREN_DIR:-$HOME/warren}"
MODE="" HUB="" TOKEN="" NAME="" YES="" SERVICE=1 DEVICE=1 OPEN=1

# an option that takes a value, given without one ("--hub" at the end), is a mistake worth a message, not "unbound variable"
value() { [ -n "$2" ] || { printf '\033[31m%s\033[0m\n' "$1 needs a value, for example: $1 $3" >&2; exit 1; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --hub-server) MODE=hub ;;
    --hub) value "$1" "${2:-}" "http://my-server:4747"; HUB="$2"; MODE=device; shift ;;
    --token) value "$1" "${2:-}" "wr_node_…"; TOKEN="$2"; shift ;;
    --name) value "$1" "${2:-}" "my-laptop"; NAME="$2"; shift ;;
    --dir) value "$1" "${2:-}" "~/warren"; DIR="$2"; shift ;;
    --yes|-y) YES=1 ;;
    --no-service) SERVICE="" ;;
    --no-device) DEVICE="" ;;
    --no-open) OPEN="" ;;
    -h|--help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
# piped into bash, stdin is the script, so questions read from the terminal
ask() {
  local q="$1" a=""
  if [ -r /dev/tty ]; then read -r -p "$q" a </dev/tty || true; fi
  printf '%s' "$a"
}

# this computer's address on its home network, for other devices on the same Wi-Fi
lan_ip() {
  if [ "$(uname)" = Darwin ]; then ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
  else hostname -I 2>/dev/null | tr ' ' '\n' | grep -Ev '^(100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|172\.1[7-9]\.|127\.)' | head -1 || true; fi
}
# the browser, when someone is sitting at this computer (not over SSH, and there's a screen)
open_browser() {
  [ -n "$OPEN" ] && [ -z "${SSH_CONNECTION:-}" ] || return 0
  if [ "$(uname)" = Darwin ]; then open "$1" >/dev/null 2>&1 || true
  elif { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } && command -v xdg-open >/dev/null; then (xdg-open "$1" >/dev/null 2>&1 &) || true
  fi
}

bold "Warren installer"

# 1. git and Node 22+
command -v git >/dev/null || fail "git is missing. Install it (macOS: xcode-select --install; Debian/Ubuntu: sudo apt-get install -y git) and run this again."
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null || [ "$(node_major)" -lt 22 ]; then
  if [ "$(uname)" = Darwin ] && command -v brew >/dev/null; then
    a=$(ask "Warren needs Node 22 or newer. Install it with Homebrew now? [Y/n] ")
    case "$a" in n|N|no) fail "Install Node 22 or newer and run this again." ;; esac
    brew install node@22
    export PATH="$(brew --prefix node@22)/bin:$PATH"
    echo "Add Node to your PATH for new terminals: echo 'export PATH=\"$(brew --prefix node@22)/bin:\$PATH\"' >> ~/.zprofile"
  else
    echo "Warren needs Node 22 or newer. One way to get it without sudo:"
    echo "  curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22"
    echo "On Debian/Ubuntu with sudo:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs"
    fail "Then run this installer again."
  fi
fi
echo "node $(node -v), $(git --version)"

# 2. the code
if [ -d "$DIR/.git" ]; then
  echo "Updating $DIR"
  # npm rewrites the lockfile on some installs; that change is never the user's work
  git -C "$DIR" checkout -- package-lock.json 2>/dev/null || true
  git -C "$DIR" pull --ff-only
else
  [ -e "$DIR" ] && fail "$DIR exists and isn't a Warren checkout. Pick another folder with --dir."
  git clone "$WARREN_REPO" "$DIR"
fi
cd "$DIR"

# 3. what this computer is for
if [ -z "$MODE" ]; then
  echo
  echo "What should this computer do?"
  echo "  1) Run the hub: the workspace and web app (one per workspace)"
  echo "  2) Connect to a hub as a device that runs agents and their VMs"
  echo "  3) Just install it"
  case "$(ask "Choose 1, 2 or 3 [1]: ")" in
    2) MODE=device ;;
    3) MODE=none ;;
    *) MODE=hub ;;
  esac
fi
if [ "$MODE" = device ]; then
  [ -n "$HUB" ] || HUB=$(ask "Hub URL (for example http://my-server:4747): ")
  [ -n "$TOKEN" ] || TOKEN=$(ask "Device token (Warren → Devices → Add device): ")
  [ -n "$HUB" ] && [ -n "$TOKEN" ] || fail "A device needs the hub URL and a token from Warren → Devices → Add device."
fi

# 4. dependencies (install scripts for better-sqlite3, esbuild and fsevents are expected)
bold "Installing dependencies"
npm ci --no-audit --no-fund --loglevel=error
if [ "$MODE" = hub ] || [ "$MODE" = none ]; then
  bold "Building the web app"
  npm run build --silent
fi

# 5. the `warren` command
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
for cmd in warren warren-mcp warren-hub; do
  ln -sf "$DIR/bin/$cmd.mjs" "$BIN/$cmd"
done
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Add $BIN to your PATH for new terminals: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.$(basename "${SHELL:-bash}")rc" ;;
esac
export PATH="$BIN:$PATH"

# 6. start it
if [ "$MODE" = hub ]; then
  P="${PORT:-4747}"
  if [ -n "$SERVICE" ]; then
    warren service install hub || true
    up=""
    for _ in $(seq 1 30); do
      if curl -fsS "http://127.0.0.1:$P/healthz" >/dev/null 2>&1; then up=1; break; fi
      sleep 1
    done
    if [ -z "$up" ]; then
      echo
      fail "Warren didn't start. Its log is in ~/.warren/hub.log; \`warren service status\` shows what's running. Run the installer again once it's fixed."
    fi
    # the hub's own computer runs agents too, so one computer is enough to start
    if [ -n "$DEVICE" ]; then
      bold "Making this computer a device for your agents"
      dev_args=(--local)
      [ -n "$NAME" ] && dev_args+=(--name "$NAME")
      warren service install node "${dev_args[@]}" || echo "Couldn't set up this computer as a device; add it later in Warren → Devices."
      echo "To give agents their own computers (VMs) here, run: warren setup"
    fi
    echo
    bold "Warren is running: http://localhost:$P"
    lan="$(lan_ip)"
    [ -n "$lan" ] && echo "On other devices on this Wi-Fi: http://$lan:$P"
    echo "Open it to make your account. Setup then helps you use Warren from anywhere with Tailscale (free)."
    open_browser "http://localhost:$P"
  else
    echo
    bold "Start the hub with: warren hub start"
    echo "Then open http://localhost:$P in a browser to make your account."
  fi
elif [ "$MODE" = device ]; then
  bold "Getting this device ready for agents' VMs"
  setup_args=()
  [ -n "$YES" ] && setup_args+=(--yes)
  if [ -r /dev/tty ]; then warren setup ${setup_args[@]+"${setup_args[@]}"} </dev/tty || true; else warren setup ${setup_args[@]+"${setup_args[@]}"} || true; fi
  args=(--hub "$HUB" --token "$TOKEN")
  [ -n "$NAME" ] && args+=(--name "$NAME")
  if [ -n "$SERVICE" ]; then
    warren service install node "${args[@]}"
  else
    echo "Connect with: warren node start ${args[*]}"
  fi
else
  echo
  bold "Installed in $DIR"
  echo "  warren hub start      run the hub in this terminal"
  echo "  warren service --help keep the hub or a device running"
fi
