#!/usr/bin/env bash
# Install Wisp on macOS or Linux.
#
#   Run install.sh from a checkout, or use the command in INSTALL.md.
#
# With no options it asks what this computer is for. Options:
#   --hub-server                 run the hub here (the workspace and web app), started at boot/login
#   --hub URL --token T [--name N]
#                                connect this computer to a hub as a device (from Wisp → Devices → Add device)
#   --dir DIR                    where to put Wisp (default ~/wisp, or $WISP_DIR)
#   --yes                        don't ask before installing a VM engine during `wisp setup`
#   --no-service                 install only; don't start anything
#   --no-device                  with --hub-server: don't also make this computer a device for agents
#   --no-open                    don't open the browser at the end
#
# It checks for git and Node 22+, clones (or updates) Wisp, installs its dependencies, puts the
# `wisp` command on your PATH, and sets it up to keep running. Nothing is installed with sudo.
set -euo pipefail

GITHUB_REPO="eireijie/wisp"
WISP_REPO="${WISP_REPO-${WARREN_REPO-https://github.com/$GITHUB_REPO.git}}"
DIR="${WISP_DIR-${WARREN_DIR-$HOME/wisp}}"
# Reuse an existing checkout so an update never installs a second hub.
if [ -z "${WISP_DIR+x}${WARREN_DIR+x}" ] && [ ! -e "$DIR" ] && [ -d "$HOME/warren/.git" ]; then DIR="$HOME/warren"; fi
MODE="" HUB="" TOKEN="" NAME="" YES="" SERVICE=1 DEVICE=1 OPEN=1

# an option that takes a value, given without one ("--hub" at the end), is a mistake worth a message, not "unbound variable"
value() { [ -n "$2" ] || { printf '\033[31m%s\033[0m\n' "$1 needs a value, for example: $1 $3" >&2; exit 1; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --hub-server) MODE=hub ;;
    --hub) value "$1" "${2:-}" "http://my-server:4747"; HUB="$2"; MODE=device; shift ;;
    --token) value "$1" "${2:-}" "wr_node_…"; TOKEN="$2"; shift ;;
    --name) value "$1" "${2:-}" "my-laptop"; NAME="$2"; shift ;;
    --dir) value "$1" "${2:-}" "~/wisp"; DIR="$2"; shift ;;
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

bold "Wisp installer"

# 1. git and Node 22+
command -v git >/dev/null || fail "git is missing. Install it (macOS: xcode-select --install; Debian/Ubuntu: sudo apt-get install -y git) and run this again."
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null || [ "$(node_major)" -lt 22 ]; then
  if [ "$(uname)" = Darwin ] && command -v brew >/dev/null; then
    a=$(ask "Wisp needs Node 22 or newer. Install it with Homebrew now? [Y/n] ")
    case "$a" in n|N|no) fail "Install Node 22 or newer and run this again." ;; esac
    brew install node@22
    export PATH="$(brew --prefix node@22)/bin:$PATH"
    echo "Add Node to your PATH for new terminals: echo 'export PATH=\"$(brew --prefix node@22)/bin:\$PATH\"' >> ~/.zprofile"
  else
    echo "Wisp needs Node 22 or newer. One way to get it without sudo:"
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
  origin=$(git -C "$DIR" remote get-url origin)
  case "$origin" in https://github.com/eireijie/warren|https://github.com/eireijie/warren.git|git@github.com:eireijie/warren.git) git -C "$DIR" remote set-url origin "$WISP_REPO" ;; esac
  git -C "$DIR" pull --ff-only
else
  [ -e "$DIR" ] && fail "$DIR exists and isn't a Wisp checkout. Pick another folder with --dir."
  git clone "$WISP_REPO" "$DIR"
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
  [ -n "$TOKEN" ] || TOKEN=$(ask "Device token (Wisp → Devices → Add device): ")
  [ -n "$HUB" ] && [ -n "$TOKEN" ] || fail "A device needs the hub URL and a token from Wisp → Devices → Add device."
fi

# 4. dependencies (install scripts for better-sqlite3, esbuild and fsevents are expected)
bold "Installing dependencies"
npm ci --no-audit --no-fund --loglevel=error
if [ "$MODE" = hub ] || [ "$MODE" = none ]; then
  bold "Building the web app"
  npm run build --silent
fi

# 5. the `wisp` command
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
for cmd in wisp wisp-mcp wisp-hub; do
  ln -sf "$DIR/bin/$cmd.mjs" "$BIN/$cmd"
done
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Add $BIN to your PATH for new terminals: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.$(basename "${SHELL:-bash}")rc" ;;
esac
export PATH="$BIN:$PATH"

# Migrate settings and existing services before starting anything under the new name.
node "$DIR/bin/wisp.mjs" migrate
for old_cmd in warren warren-hub warren-mcp; do
  old_link="$HOME/.local/bin/$old_cmd"
  if [ -L "$old_link" ]; then
    case "$(readlink "$old_link")" in "$DIR"/bin/*|"$HOME/warren"/bin/*) rm -f "$old_link" ;; esac
  fi
done

# 6. start it
if [ "$MODE" = hub ]; then
  P="${PORT:-4747}"
  if [ -n "$SERVICE" ]; then
    svc=1
    wisp service install hub || svc=""
    P=$(wisp service status hub --json | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8"))[0].port')
    [ -n "$svc" ] || fail "Wisp couldn't be set up to start by itself (see above). Run the installer again with --no-service, then start it with: wisp hub start"
    up=""
    for _ in $(seq 1 30); do
      if curl -fsS "http://127.0.0.1:$P/healthz" >/dev/null 2>&1; then up=1; break; fi
      sleep 1
    done
    if [ -z "$up" ]; then
      echo
      fail "Wisp didn't start. Its log is in ~/.wisp/hub.log; \`wisp service status\` shows what's running. Run the installer again once it's fixed."
    fi
    # the hub's own computer runs agents too, so one computer is enough to start
    if [ -n "$DEVICE" ]; then
      bold "Making this computer a device for your agents"
      dev_args=(--local)
      [ -n "$NAME" ] && dev_args+=(--name "$NAME")
      wisp service install node "${dev_args[@]}" || echo "Couldn't set up this computer as a device; add it later in Wisp → Devices."
      echo "To give agents their own computers (VMs) here, run: wisp setup"
    fi
    echo
    bold "Wisp is running: http://localhost:$P"
    lan="$(lan_ip)"
    [ -n "$lan" ] && echo "On other devices on this Wi-Fi: http://$lan:$P"
    echo "Open it to make your account. Setup then helps you use Wisp from anywhere with Tailscale (free)."
    open_browser "http://localhost:$P"
  else
    echo
    bold "Start the hub with: wisp hub start"
    echo "Then open http://localhost:$P in a browser to make your account."
  fi
elif [ "$MODE" = device ]; then
  bold "Getting this device ready for agents' VMs"
  setup_args=()
  [ -n "$YES" ] && setup_args+=(--yes)
  if [ -r /dev/tty ]; then wisp setup ${setup_args[@]+"${setup_args[@]}"} </dev/tty || true; else wisp setup ${setup_args[@]+"${setup_args[@]}"} || true; fi
  args=(--hub "$HUB" --token "$TOKEN")
  [ -n "$NAME" ] && args+=(--name "$NAME")
  if [ -n "$SERVICE" ]; then
    wisp service install node "${args[@]}"
  else
    echo "Connect with: wisp node start ${args[*]}"
  fi
else
  echo
  bold "Installed in $DIR"
  echo "  wisp hub start      run the hub in this terminal"
  echo "  wisp service --help keep the hub or a device running"
fi
