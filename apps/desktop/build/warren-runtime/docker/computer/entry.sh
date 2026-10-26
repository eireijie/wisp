#!/bin/sh
# Runs as root when the VM starts: gives the warren user its home folder (a new volume can start
# out owned by root, as with Apple's container), then starts the desktop as warren. Only the home
# folder and its own files: ~/files is the device's folder, shared in, and stays as it is.
set -e
if [ ! -e /home/warren/.bashrc ]; then
  cp -r /etc/skel/. /home/warren/
  chown warren:warren /home/warren/.bashrc /home/warren/.profile /home/warren/.bash_logout 2>/dev/null || true
fi
chown warren:warren /home/warren
exec setpriv --reuid=warren --regid=warren --init-groups env HOME=/home/warren USER=warren LOGNAME=warren SHELL=/bin/bash /usr/local/bin/warren-desktop
