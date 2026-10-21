#!/usr/bin/env bash
# Remove Warren from this Mac or Linux computer, to start over or to stop using it.
#
#   curl -fsSL https://raw.githubusercontent.com/eireijie/warren/main/uninstall.sh | bash
#   (or, from a clone: bash uninstall.sh)
#
# It asks before each step and only touches Warren's own things:
#   - the hub and device services (started at login)
#   - agents' VMs (Apple container or Docker, named warren-cmp_…) and the warren-computer image
#   - the desktop app and its settings
#   - the `warren` commands in ~/.local/bin
#   - ~/.warren (this device's settings and agents' working folders)
#   - ~/warren (Warren itself, and a hub's data: chats, memory, files) — or --dir DIR
# Options: --dry-run (only list what it would remove), --yes (don't ask), --dir DIR (where Warren
# was installed, default ~/warren).
# Nothing else is touched: not Docker or container themselves, not Tailscale, not your agents' CLIs.
set -uo pipefail

DIR="${WARREN_DIR:-$HOME/warren}"
YES="" DRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --dry-run|-n) DRY=1 ;;
    --dir) DIR="${2:?--dir needs a folder}"; shift ;;
    -h|--help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
# yes/no, default no; reads the terminal because stdin is the script when piped
confirm() {
  if [ -n "$DRY" ]; then printf '  would ask: %s\n' "$1"; return 1; fi
  [ -n "$YES" ] && return 0
  local a=""
  if [ -r /dev/tty ]; then read -r -p "$1 [y/N] " a </dev/tty || true; fi
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
done_() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
mac() { [ "$(uname)" = Darwin ]; }

bold "Remove Warren"
if [ -n "$DRY" ]; then echo "Dry run: listing what it would ask about. Nothing is changed."
else echo "This asks before each step. Say no to keep something."; fi
echo

# 1. services
services=()
if mac; then
  for k in hub node; do [ -f "$HOME/Library/LaunchAgents/ai.warren.$k.plist" ] && services+=("$k"); done
else
  for u in warren warren-node; do
    { [ -f "$HOME/.config/systemd/user/$u.service" ] || [ -f "/etc/systemd/system/$u.service" ]; } && services+=("$u")
  done
fi
if [ ${#services[@]} -gt 0 ] && confirm "Stop Warren's services and remove them from startup (${services[*]})?"; then
  if mac; then
    for k in "${services[@]}"; do
      launchctl bootout "gui/$(id -u)/ai.warren.$k" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/ai.warren.$k.plist"
      done_ "removed ai.warren.$k"
    done
  else
    for u in "${services[@]}"; do
      if [ -f "$HOME/.config/systemd/user/$u.service" ]; then
        systemctl --user disable --now "$u" 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/$u.service"
        systemctl --user daemon-reload 2>/dev/null || true
      else
        echo "  $u is a system service; removing it needs sudo:"
        sudo systemctl disable --now "$u" && sudo rm -f "/etc/systemd/system/$u.service" && sudo systemctl daemon-reload || true
      fi
      done_ "removed $u"
    done
  fi
fi

# 2. agents' VMs and their image
vms_container=() vms_docker=()
if command -v container >/dev/null 2>&1; then
  while read -r id; do [ -n "$id" ] && vms_container+=("$id"); done < <(container ls -a 2>/dev/null | awk 'NR > 1 && $1 ~ /^warren-cmp_/ {print $1}')
fi
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  while read -r id; do [ -n "$id" ] && vms_docker+=("$id"); done < <(docker ps -a --format '{{.Names}}' 2>/dev/null | grep '^warren-cmp_' || true)
fi
n=$(( ${#vms_container[@]} + ${#vms_docker[@]} ))
if [ "$n" -gt 0 ] && confirm "Delete $n agent VM(s) and everything on them?"; then
  for id in ${vms_container[@]+"${vms_container[@]}"}; do container stop "$id" >/dev/null 2>&1; container rm "$id" >/dev/null 2>&1 && done_ "deleted VM $id"; done
  for id in ${vms_docker[@]+"${vms_docker[@]}"}; do docker rm -f "$id" >/dev/null 2>&1 && done_ "deleted VM $id"; done
fi
images=""
command -v container >/dev/null 2>&1 && container image list 2>/dev/null | grep -q '^warren-computer' && images="container"
command -v docker >/dev/null 2>&1 && docker images -q 'warren-computer' 2>/dev/null | grep -q . && images="$images docker"
command -v docker >/dev/null 2>&1 && docker images -q 'ghcr.io/eireijie/warren-computer' 2>/dev/null | grep -q . && images="$images docker"
if [ -n "$images" ] && confirm "Delete the VM image (warren-computer, a few GB)?"; then
  if [[ "$images" == *container* ]]; then
    container image list 2>/dev/null | awk 'NR > 1 && $1 == "warren-computer" {print $1":"$2}' | while read -r ref; do container image rm "$ref" >/dev/null 2>&1; done
    done_ "deleted the image from Apple container"
  fi
  if [[ "$images" == *docker* ]]; then
    for ref in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '(^|/)warren-computer:'); do docker rmi -f "$ref" >/dev/null 2>&1; done
    done_ "deleted the image from Docker"
  fi
fi

# 3. the desktop app
if mac; then
  app="/Applications/Warren.app" data="$HOME/Library/Application Support/Warren"
  if { [ -d "$app" ] || [ -d "$data" ]; } && confirm "Remove the Warren app and its settings (a server it ran, with its chats and memory, goes too)?"; then
    osascript -e 'tell application "Warren" to quit' >/dev/null 2>&1 || true
    sleep 1
    rm -rf "$app" "$data" "$HOME/Library/Logs/Warren" "$HOME/Library/Preferences/ai.warren.desktop.plist" "$HOME/Library/Caches/ai.warren.desktop" "$HOME/Library/Saved Application State/ai.warren.desktop.savedState"
    done_ "removed the app"
  fi
else
  data="$HOME/.config/Warren"
  if [ -d "$data" ] && confirm "Remove the Warren app's settings (a server it ran, with its chats and memory, goes too)?"; then
    rm -rf "$data"
    done_ "removed $data (delete the AppImage or run: sudo apt remove warren, if you installed the .deb)"
  fi
fi

# 4. the commands
links=()
for c in warren warren-hub warren-mcp; do [ -L "$HOME/.local/bin/$c" ] && links+=("$HOME/.local/bin/$c"); done
if [ ${#links[@]} -gt 0 ] && confirm "Remove the warren commands from ~/.local/bin?"; then
  rm -f "${links[@]}"
  done_ "removed the commands"
fi

# 5. this device's settings and agents' working folders
if [ -d "$HOME/.warren" ] && confirm "Delete ~/.warren (this device's connection and your agents' working folders)?"; then
  rm -rf "$HOME/.warren"
  done_ "deleted ~/.warren"
fi

# 6. Warren itself, and a hub's data
if [ -d "$DIR" ] && [ -f "$DIR/package.json" ] && grep -q '"name": "warren"' "$DIR/package.json"; then
  echo
  echo "$DIR is Warren itself. If this computer ran the hub, its chats, memory and files are in $DIR/data."
  if confirm "Delete $DIR, including that data?"; then
    rm -rf "$DIR"
    done_ "deleted $DIR"
  fi
fi

echo
bold "Done."
echo "To install again: curl -fsSL https://raw.githubusercontent.com/eireijie/warren/main/install.sh | bash -s -- --hub-server"
