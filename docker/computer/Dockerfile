# The computer Wisp's agents work on: Debian 13 ("trixie") with Xfce, Google Chrome, a terminal
# and a file manager on a dock, driven with xdotool and shown live over VNC. Agents' harnesses
# (Claude Code, Codex, Hermes, Kimi CLI) can run inside it too, and agents work the browser by page element through
# Playwright MCP. `wisp node` pulls this (when it's published for this exact recipe) or builds it
# the first time a VM is needed on a device. The kernel is the VM engine's, not Debian's.
FROM node:22-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc socat xdotool imagemagick xclip xdg-utils dbus-x11 x11-utils \
      xfce4 xfce4-terminal thunar mousepad ristretto greybird-gtk-theme papirus-icon-theme librsvg2-common \
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

# Kimi CLI (Moonshot's "Kimi Code", the successor of the archived Python kimi-cli): npm package with
# prebuilt binaries for linux x64 and arm64. `kimi acp` is how Wisp drives it; `kimi login` signs it in.
RUN npm install -g --no-audit --no-fund @moonshot-ai/kimi-code@2.2.0 && npm cache clean --force

# Hermes Agent (Nous Research), from its own installer pinned to a release tag and commit. The
# installer's stages are the supported way to skip its browser tools (Chrome and Playwright MCP are
# here already). It goes in /opt, not the home folder, because the home folder is a volume; its state
# (~/.hermes) lives in the home folder. 1000 is the wisp user, created below; Hermes installs extra
# Python packages on demand, so that user owns the install.
ARG HERMES_TAG=v2026.9.24
ARG HERMES_COMMIT=f97608f178d1ffeca59860195ab7da295f7c8e5f
RUN curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_TAG}/scripts/install.sh" -o /tmp/hermes-install.sh \
 && export HERMES_HOME=/opt/hermes \
 && for stage in prerequisites repository venv python-deps; do \
      bash /tmp/hermes-install.sh --stage "$stage" --commit "$HERMES_COMMIT" --dir /opt/hermes/hermes-agent --skip-browser --skip-computer-use </dev/null || exit 1; \
    done \
 && rm -rf /tmp/hermes-install.sh /opt/hermes/hermes-agent/.git /root/.cache /root/.hermes \
 && ln -s /opt/hermes/hermes-agent/venv/bin/hermes /usr/local/bin/hermes \
 && ln -s /opt/hermes/bin/uv /usr/local/bin/uv \
 && chown -R 1000:1000 /opt/hermes \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Chrome always starts the way Wisp needs it (see chrome.sh). Downloads land in ~/files, the folder
# shared with the device (and the agents' working folder).
COPY chrome.sh /usr/local/bin/google-chrome
COPY desktop/ /usr/local/share/wisp/desktop/
RUN chmod +x /usr/local/bin/google-chrome \
 && ln -sf /usr/local/bin/google-chrome /usr/local/bin/google-chrome-stable \
 && sed -i 's#/usr/bin/google-chrome-stable#/usr/local/bin/google-chrome#g' /usr/share/applications/google-chrome.desktop \
 && cp /usr/local/share/wisp/desktop/*.desktop /usr/share/applications/ \
 && mkdir -p /usr/share/xfce4/helpers && cp /usr/local/share/wisp/desktop/wisp-chrome-helper.desktop /usr/share/xfce4/helpers/wisp-chrome.desktop \
 && mkdir -p /etc/opt/chrome/policies/managed \
 && printf '{ "DownloadDirectory": "/home/wisp/files", "PromptForDownloadLocation": false, "DefaultBrowserSettingEnabled": false, "MetricsReportingEnabled": false, "PromotionalTabsEnabled": false, "PrivacySandboxPromptEnabled": false, "AutofillCreditCardEnabled": false }\n' > /etc/opt/chrome/policies/managed/wisp.json \
 && userdel -r node \
 && useradd -m -u 1000 -s /bin/bash wisp \
 && echo 'wisp ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/wisp

COPY start.sh /usr/local/bin/wisp-desktop
COPY entry.sh /usr/local/bin/wisp-entry
COPY browser-mcp.sh /usr/local/bin/wisp-browser-mcp
RUN chmod +x /usr/local/bin/wisp-desktop /usr/local/bin/wisp-entry /usr/local/bin/wisp-browser-mcp

WORKDIR /home/wisp
CMD ["/usr/local/bin/wisp-entry"]
