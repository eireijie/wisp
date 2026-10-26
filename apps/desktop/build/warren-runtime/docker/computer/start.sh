#!/bin/sh
# Starts the desktop: a virtual screen, Xfce with a dock (Chrome, Terminal, Files), and a VNC server
# that only listens inside the container (the device reaches it with `exec ... socat`, so no port is
# exposed).
set -e
RES="${RESOLUTION:-1280x800}"
export DISPLAY=:1
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
mkdir -p "$HOME/files" "$HOME/Downloads"

# the same desktop every time: Warren's dock, wallpaper, window theme and icons, and Chrome for links
CONF="$HOME/.config/xfce4/xfconf/xfce-perchannel-xml"
mkdir -p "$CONF"
cp /usr/local/share/warren/desktop/*.xml "$CONF/"
printf 'WebBrowser=warren-chrome\nTerminalEmulator=xfce4-terminal\nFileManager=thunar\n' > "$HOME/.config/xfce4/helpers.rc"
xdg-settings set default-web-browser google-chrome.desktop 2>/dev/null || true

Xvfb :1 -screen 0 "${RES}x24" -nolisten tcp -dpi 96 &
for _ in $(seq 1 100); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done

dbus-launch --exit-with-session startxfce4 >/tmp/xfce.log 2>&1 &
exec x11vnc -display :1 -localhost -rfbport 5900 -forever -shared -nopw -noxdamage -quiet
