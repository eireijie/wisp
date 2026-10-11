#!/bin/sh
# Starts the desktop: a virtual screen, Xfce, and a VNC server that only listens inside the
# container (the device reaches it with `docker exec ... socat`, so no port is exposed).
set -e
RES="${RESOLUTION:-1280x800}"
export DISPLAY=:1
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
mkdir -p "$HOME/files" "$HOME/Desktop" "$HOME/Downloads"
[ -e "$HOME/Desktop/files" ] || ln -s "$HOME/files" "$HOME/Desktop/files"

Xvfb :1 -screen 0 "${RES}x24" -nolisten tcp -dpi 96 &
for _ in $(seq 1 100); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done

# Chromium is the browser for links, whichever way they're opened
mkdir -p "$HOME/.config/xfce4"
[ -f "$HOME/.config/xfce4/helpers.rc" ] || printf 'WebBrowser=chromium\nTerminalEmulator=xfce4-terminal\n' > "$HOME/.config/xfce4/helpers.rc"
xdg-settings set default-web-browser chromium.desktop 2>/dev/null || true

dbus-launch --exit-with-session startxfce4 >/tmp/xfce.log 2>&1 &
exec x11vnc -display :1 -localhost -rfbport 5900 -forever -shared -nopw -noxdamage -quiet
