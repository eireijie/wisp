#!/usr/bin/env bash
# Remove Wisp from this Mac or Linux computer, to start over or to stop using it.
#
#   Use the uninstall command in README.md
#   (or, from a clone: bash uninstall.sh)
#
# It asks before each step and only touches Wisp's own things:
#   - the hub and device services (started at login)
#   - agents' VMs (Apple container or Docker, named wisp-cmp_…) and the wisp-computer image
#   - the desktop app and its settings
#   - the `wisp` commands in ~/.local/bin
#   - ~/.wisp (this device's settings and agents' working folders)
#   - ~/wisp (Wisp itself, and a hub's data: chats, memory, files) — or --dir DIR
#   - Wisp's own Tailscale address, when the hub goes (only if it points at this hub)
# Options: --dry-run (only list what it would remove), --yes (don't ask), --dir DIR (where Wisp
# was installed, default ~/wisp).
# Nothing else is touched: not Docker or container themselves, not Tailscale, not your agents' CLIs.
# The desktop app does the same from Settings > Data (apps/desktop/src/removal.cjs); a test keeps them equal.
set -uo pipefail

GITHUB_REPO="eireijie/wisp"
# Only tests set this: it moves /Applications, /etc and /var inside a temp folder.
ROOT="${WISP_UNINSTALL_ROOT:-}"

DIR="${WISP_DIR-${WARREN_DIR-$HOME/wisp}}"
if [ -z "${WISP_DIR+x}${WARREN_DIR+x}" ] && [ ! -e "$DIR" ] && [ -d "$HOME/warren/.git" ]; then DIR="$HOME/warren"; fi
YES="" DRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --dry-run|-n) DRY=1 ;;
    --dir) DIR="${2:?--dir needs a folder}"; shift ;;
    -h|--help) sed -n '2,18p' "$0" 2>/dev/null || true; exit 0 ;;
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

bold "Remove Wisp"
if [ -n "$DRY" ]; then echo "Dry run: listing what it would ask about. Nothing is changed."
else echo "This asks before each step. Say no to keep something."; fi
echo

# 1. services
services=()
if mac; then
  for label in ai.wisp.hub ai.wisp.node ai.warren.hub ai.warren.node; do [ -f "$HOME/Library/LaunchAgents/$label.plist" ] && services+=("$label"); done
else
  for u in wisp wisp-node warren warren-node; do
    { [ -f "$HOME/.config/systemd/user/$u.service" ] || [ -f "$ROOT/etc/systemd/system/$u.service" ]; } && services+=("$u")
  done
fi
# Tailscale keeps serving the address on its own, so it would send visitors to whatever uses this
# port next. Only the root of https://<this computer> pointing at this hub is Wisp's.
hub_port() {
  for f in "$HOME/Library/LaunchAgents/ai.wisp.hub.plist" "$HOME/Library/LaunchAgents/ai.warren.hub.plist" "$HOME/.config/systemd/user/wisp.service" "$HOME/.config/systemd/user/warren.service"; do
    [ -f "$f" ] || continue
    p=$(sed -n -e '/<key>PORT<\/key>/s/.*<key>PORT<\/key><string>\([0-9]*\)<.*/\1/p' -e 's/^Environment="*PORT=\([0-9]*\).*/\1/p' "$f" | head -1)
    [ -n "$p" ] && { echo "$p"; return; }
  done
  echo "${PORT:-4747}"
}
tailscale_off() {
  command -v tailscale >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || { echo "  If Wisp had a Tailscale address, turn it off: tailscale funnel --https=443 off && tailscale serve --https=443 off"; return 0; }
  # prints "only" when the address is Wisp's alone, "shared" when other paths use it too
  how=$(python3 -c '
import json, re, sys
def load(s): return json.loads(s[s.index("{"):])
try:
  dns = load(sys.argv[1])["Self"]["DNSName"].rstrip(".")
  mounts = load(sys.argv[2])["Web"][dns + ":443"]["Handlers"]
  if re.fullmatch(r"https?://(localhost|127\.0\.0\.1|\[::1\]):" + sys.argv[3] + "/?", mounts["/"]["Proxy"]): print("only" if len(mounts) == 1 else "shared")
except Exception: pass
' "$(tailscale status --json 2>/dev/null)" "$(tailscale serve status --json 2>/dev/null)" "$(hub_port)")
  case "$how" in
    only) tailscale funnel --https=443 off >/dev/null 2>&1; tailscale serve --https=443 off >/dev/null 2>&1; done_ "turned off Wisp's Tailscale address" ;;
    shared) tailscale serve --https=443 --set-path=/ off >/dev/null 2>&1; done_ "turned off Wisp's Tailscale address; its other paths stay" ;;
  esac
}
if [ ${#services[@]} -gt 0 ] && confirm "Stop Wisp's services and remove them from startup (${services[*]})?"; then
  case " ${services[*]} " in *hub*|*" wisp "*|*" warren "*) tailscale_off ;; esac
  if mac; then
    for k in "${services[@]}"; do
      launchctl bootout "gui/$(id -u)/$k" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$k.plist"
      done_ "removed $k"
    done
  else
    for u in "${services[@]}"; do
      if [ -f "$HOME/.config/systemd/user/$u.service" ]; then
        systemctl --user disable --now "$u" 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/$u.service"
        systemctl --user daemon-reload 2>/dev/null || true
      else
        echo "  $u is a system service; removing it needs sudo:"
        sudo systemctl disable --now "$u" && sudo rm -f "$ROOT/etc/systemd/system/$u.service" && sudo systemctl daemon-reload || true
      fi
      done_ "removed $u"
    done
  fi
fi

# 2. agents' VMs and their image
vms_container=() vms_docker=()
if command -v container >/dev/null 2>&1; then
  while read -r id; do [ -n "$id" ] && vms_container+=("$id"); done < <(container ls -a 2>/dev/null | awk 'NR > 1 && $1 ~ /^(wisp|warren)-cmp_/ {print $1}')
fi
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  while read -r id; do [ -n "$id" ] && vms_docker+=("$id"); done < <(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^(wisp|warren)-cmp_' || true)
fi
n=$(( ${#vms_container[@]} + ${#vms_docker[@]} ))
if [ "$n" -gt 0 ] && confirm "Delete $n agent VM(s) and everything on them?"; then
  for id in ${vms_container[@]+"${vms_container[@]}"}; do container stop "$id" >/dev/null 2>&1; container rm "$id" >/dev/null 2>&1 && done_ "deleted VM $id"; done
  for id in ${vms_docker[@]+"${vms_docker[@]}"}; do docker rm -f "$id" >/dev/null 2>&1 && done_ "deleted VM $id"; done
fi
images=""
command -v container >/dev/null 2>&1 && container image list 2>/dev/null | grep -Eq '^([^[:space:]]*/)?(wisp|warren)-computer[[:space:]]' && images="container"
command -v docker >/dev/null 2>&1 && docker images -q '*computer' 2>/dev/null | grep -q . && images="$images docker"
command -v docker >/dev/null 2>&1 && docker images -q "ghcr.io/${GITHUB_REPO}-computer" 2>/dev/null | grep -q . && images="$images docker"
if [ -n "$images" ] && confirm "Delete the VM image (wisp-computer, a few GB)?"; then
  if [[ "$images" == *container* ]]; then
    container image list 2>/dev/null | awk 'NR > 1 && $1 ~ /(^|\/)(wisp|warren)-computer$/ {print $1":"$2}' | while read -r ref; do container image rm "$ref" >/dev/null 2>&1; done
    done_ "deleted the image from Apple container"
  fi
  if [[ "$images" == *docker* ]]; then
    for ref in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '(^|/)(wisp|warren)-computer:'); do docker rmi -f "$ref" >/dev/null 2>&1; done
    done_ "deleted the image from Docker"
  fi
fi

# 3. the desktop app (which runs the hub, when no service does)
has_hub_service() { case " ${services[*]:-} " in *hub*|*" wisp "*|*" warren "*) return 0 ;; esac; return 1; }
if mac; then
  for product in Wisp Warren; do
  app="$ROOT/Applications/$product.app" data="$HOME/Library/Application Support/$product"
  if { [ -d "$app" ] || [ -d "$data" ]; } && confirm "Remove the Wisp app and its settings (a server it ran, with its chats and memory, goes too)?"; then
    has_hub_service || tailscale_off
    osascript -e "tell application \"$product\" to quit" >/dev/null 2>&1 || true
    sleep 1
    app_id=$(printf "%s" "$product" | tr '[:upper:]' '[:lower:]')
    rm -rf "$app" "$data" "$HOME/Library/Logs/$product" "$HOME/Library/Preferences/ai.$app_id.desktop.plist" "$HOME/Library/Caches/ai.$app_id.desktop" "$HOME/Library/Saved Application State/ai.$app_id.desktop.savedState"
    done_ "removed the app"
  fi
  done
else
  for product in Wisp Warren; do
  data="$HOME/.config/$product"
  if [ -d "$data" ] && confirm "Remove the Wisp app's settings (a server it ran, with its chats and memory, goes too)?"; then
    has_hub_service || tailscale_off
    rm -rf "$data"
    done_ "removed $data (delete the AppImage or run: sudo apt remove wisp, if you installed the .deb)"
  fi
  done
fi

  # Both desktop settings folders are handled above.

# 4. the commands
links=()
for c in wisp wisp-hub wisp-mcp warren warren-hub warren-mcp; do [ -L "$HOME/.local/bin/$c" ] && links+=("$HOME/.local/bin/$c"); done
if [ ${#links[@]} -gt 0 ] && confirm "Remove the wisp commands from ~/.local/bin?"; then
  rm -f "${links[@]}"
  done_ "removed the commands"
fi

# 5. this device's settings and agents' working folders
for folder in "$HOME/.wisp" "$HOME/.warren"; do
  if { [ -e "$folder" ] || [ -L "$folder" ]; } && confirm "Delete $folder (this device's connection and your agents' working folders)?"; then
    rm -rf "$folder"
    done_ "deleted $folder"
  fi
done

# 6. Wisp itself, and a hub's data
# (the old ~/warren too, which a current install can have left beside ~/wisp)
folders=("$DIR")
[ "$DIR" = "$HOME/warren" ] || folders+=("$HOME/warren")
for folder in "${folders[@]}"; do
  if [ -d "$folder" ] && [ -f "$folder/package.json" ] && grep -Eq '"name": "(wisp|warren)"' "$folder/package.json"; then
    echo
    echo "$folder is Wisp itself. If this computer ran the hub, its chats, memory and files are in $folder/data."
    if confirm "Delete $folder, including that data?"; then
      rm -rf "$folder"
      done_ "deleted $folder"
    fi
  fi
done

# System installs and cloud-init deployments can keep their data outside this user's home.
for folder in "$ROOT/var/lib/wisp" "$ROOT/var/lib/warren" "$ROOT/opt/wisp" "$ROOT/opt/warren"; do
  if [ -d "$folder" ] && confirm "Delete $folder (system installation and hub data)?"; then
    if [ -f "$folder/compose.yaml" ]; then
      if [ "$(id -u)" -eq 0 ]; then docker compose -f "$folder/compose.yaml" down || continue
      else sudo docker compose -f "$folder/compose.yaml" down || continue; fi
    fi
    if [ "$(id -u)" -eq 0 ]; then rm -rf "$folder"; else sudo rm -rf "$folder"; fi
    done_ "deleted $folder"
  fi
done

echo
bold "Done."
echo "To install again: curl -fsSL https://raw.githubusercontent.com/$GITHUB_REPO/main/install.sh | bash -s -- --hub-server"
