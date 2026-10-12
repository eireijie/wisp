# A Linux desktop for Warren agents: Xfce, Chromium and the usual tools, driven with xdotool and
# shown live over VNC. Agents' harnesses (Claude Code, Codex) can run inside it too, and agents can
# work the browser by page element through Playwright MCP. `warren node` builds this (or pulls it,
# when it's published for this exact recipe) the first time a VM is needed on a device.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc socat xdotool imagemagick xclip xdg-utils dbus-x11 x11-utils \
      xfce4 xfce4-terminal thunar mousepad ristretto \
      chromium fonts-noto fonts-noto-color-emoji fonts-liberation \
      sudo curl wget ca-certificates git python3 python3-pip procps less nano unzip jq ripgrep \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# harnesses that can run inside the VM, and Playwright MCP for the browser (it drives the Chromium
# people watch, over its debugging port; it never downloads a browser of its own)
RUN npm install -g @anthropic-ai/claude-code @openai/codex @playwright/mcp@0.0.83 \
 && npm cache clean --force

# downloads land in ~/files, the folder shared with the device (and the agents' working folder).
# --no-sandbox because containers don't give Chromium user namespaces (--test-type hides the bar
# warning about it). The debugging port only listens inside the VM, and Chromium refuses it on its
# default profile, hence a profile of its own. CJK fonts so pages in any language read right.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /etc/chromium/policies/managed /etc/chromium.d \
 && echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --test-type --no-first-run --password-store=basic --user-data-dir=/home/warren/.config/warren-browser --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222"' > /etc/chromium.d/warren \
 && printf '{ "DownloadDirectory": "/home/warren/files", "PromptForDownloadLocation": false, "DefaultBrowserSettingEnabled": false, "MetricsReportingEnabled": false }\n' > /etc/chromium/policies/managed/warren.json \
 && userdel -r node \
 && useradd -m -u 1000 -s /bin/bash warren \
 && echo 'warren ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/warren

COPY start.sh /usr/local/bin/warren-desktop
COPY entry.sh /usr/local/bin/warren-entry
COPY browser-mcp.sh /usr/local/bin/warren-browser-mcp
RUN chmod +x /usr/local/bin/warren-desktop /usr/local/bin/warren-entry /usr/local/bin/warren-browser-mcp

WORKDIR /home/warren
CMD ["/usr/local/bin/warren-entry"]
