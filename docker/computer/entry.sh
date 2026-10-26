#!/bin/sh
# Runs as root when the VM starts: gives the wisp user its home folder (a new volume can start
# out owned by root, as with Apple's container), then starts the desktop as wisp. Only the home
# folder and its own files: ~/files is the device's folder, shared in, and stays as it is.
set -e
if [ ! -e /home/wisp/.bashrc ]; then
  cp -r /etc/skel/. /home/wisp/
  chown wisp:wisp /home/wisp/.bashrc /home/wisp/.profile /home/wisp/.bash_logout 2>/dev/null || true
fi
chown wisp:wisp /home/wisp
exec setpriv --reuid=wisp --regid=wisp --init-groups env HOME=/home/wisp USER=wisp LOGNAME=wisp SHELL=/bin/bash /usr/local/bin/wisp-desktop
