# A Linux desktop for Warren agents: Xfce, Chromium and the usual tools, driven with xdotool
# and shown live over VNC. `warren node` builds this the first time a VM is created on a device.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc socat xdotool imagemagick xclip xdg-utils dbus-x11 x11-utils \
      xfce4 xfce4-terminal thunar mousepad ristretto \
      chromium fonts-noto fonts-noto-color-emoji fonts-liberation \
      sudo curl wget ca-certificates git python3 python3-pip procps less nano unzip jq \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# downloads land in ~/files, the folder shared with the device (and the agents' working folder)
# --no-sandbox because containers don't give Chromium user namespaces; set for every way it starts
RUN mkdir -p /etc/chromium/policies/managed /etc/chromium.d \
 && echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --no-first-run --password-store=basic"' > /etc/chromium.d/warren \
 && printf '{ "DownloadDirectory": "/home/warren/files", "PromptForDownloadLocation": false, "DefaultBrowserSettingEnabled": false, "MetricsReportingEnabled": false }\n' > /etc/chromium/policies/managed/warren.json \
 && useradd -m -s /bin/bash warren \
 && echo 'warren ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/warren

COPY start.sh /usr/local/bin/warren-desktop
RUN chmod +x /usr/local/bin/warren-desktop

USER warren
WORKDIR /home/warren
CMD ["/usr/local/bin/warren-desktop"]
