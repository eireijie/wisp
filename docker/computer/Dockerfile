# The computer Warren's agents work on: Debian 13 ("trixie") with Xfce, Google Chrome, a terminal
# and a file manager on a dock, driven with xdotool and shown live over VNC. Agents' harnesses
# (Claude Code, Codex) can run inside it too, and agents work the browser by page element through
# Playwright MCP. `warren node` pulls this (when it's published for this exact recipe) or builds it
# the first time a VM is needed on a device. The kernel is the VM engine's, not Debian's.
FROM node:22-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc socat xdotool imagemagick xclip xdg-utils dbus-x11 x11-utils \
      xfce4 xfce4-terminal thunar mousepad ristretto greybird-gtk-theme papirus-icon-theme \
      fonts-noto fonts-noto-color-emoji fonts-noto-cjk fonts-liberation \
      sudo curl wget ca-certificates gnupg git python3 python3-pip procps less nano unzip jq ripgrep \
 && rm -rf /usr/share/icons/ePapirus* /usr/share/icons/Papirus-Light \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Google Chrome from Google's own repository (it publishes Intel and ARM builds)
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# harnesses that can run inside the VM, and Playwright MCP for the browser (it drives the Chrome
# people watch, over its debugging port; it never downloads a browser of its own)
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code && npm cache clean --force
RUN npm install -g --no-audit --no-fund @openai/codex && npm cache clean --force
RUN npm install -g --no-audit --no-fund @playwright/mcp@0.0.83 && npm cache clean --force

# Chrome always starts the way Warren needs it (see chrome.sh). Downloads land in ~/files, the folder
# shared with the device (and the agents' working folder).
COPY chrome.sh /usr/local/bin/google-chrome
COPY desktop/ /usr/local/share/warren/desktop/
RUN chmod +x /usr/local/bin/google-chrome \
 && ln -sf /usr/local/bin/google-chrome /usr/local/bin/google-chrome-stable \
 && sed -i 's#/usr/bin/google-chrome-stable#/usr/local/bin/google-chrome#g' /usr/share/applications/google-chrome.desktop \
 && cp /usr/local/share/warren/desktop/*.desktop /usr/share/applications/ \
 && mkdir -p /usr/share/xfce4/helpers && cp /usr/local/share/warren/desktop/warren-chrome-helper.desktop /usr/share/xfce4/helpers/warren-chrome.desktop \
 && mkdir -p /etc/opt/chrome/policies/managed \
 && printf '{ "DownloadDirectory": "/home/warren/files", "PromptForDownloadLocation": false, "DefaultBrowserSettingEnabled": false, "MetricsReportingEnabled": false, "PromotionalTabsEnabled": false, "PrivacySandboxPromptEnabled": false, "AutofillCreditCardEnabled": false }\n' > /etc/opt/chrome/policies/managed/warren.json \
 && userdel -r node \
 && useradd -m -u 1000 -s /bin/bash warren \
 && echo 'warren ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/warren

COPY start.sh /usr/local/bin/warren-desktop
COPY entry.sh /usr/local/bin/warren-entry
COPY browser-mcp.sh /usr/local/bin/warren-browser-mcp
RUN chmod +x /usr/local/bin/warren-desktop /usr/local/bin/warren-entry /usr/local/bin/warren-browser-mcp

WORKDIR /home/warren
CMD ["/usr/local/bin/warren-entry"]
