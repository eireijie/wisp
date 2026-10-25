/** Everything about the project that more than one page needs. The domain lives in astro.config.mjs. */

export const GITHUB_REPO = "eireijie/wisp";
export const REPO = `https://github.com/${GITHUB_REPO}`;
/** Where people reach us: there's no email, questions go to GitHub Issues. */
export const CONTACT = `${REPO}/issues`;
export const RELEASES = `${REPO}/releases`;
const latest = (name: string) => `${RELEASES}/latest/download/${name}`;

export const DOWNLOADS = {
  mac: latest("Wisp-mac-arm64.dmg"),
  macIntel: latest("Wisp-mac-x64.dmg"),
  windows: latest("Wisp-win-x64.exe"),
  linuxAppImage: latest("Wisp-linux-x86_64.AppImage"),
  linuxDeb: latest("Wisp-linux-amd64.deb"),
  /** a preview to install directly, until Wisp is on Google Play */
  android: latest("Wisp-android.apk"),
};

export const INSTALL_UNIX = `curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/install.sh | bash`;
export const INSTALL_WINDOWS = `irm https://raw.githubusercontent.com/${GITHUB_REPO}/main/install.ps1 | iex`;
export const INSTALL_DOCKER =
  `docker run -d --name wisp -p 4747:4747 -v wisp-data:/data --restart unless-stopped ghcr.io/${GITHUB_REPO}`;

/** The docs, in reading order. Slugs match the markdown files' names. */
export const DOC_ORDER = [
  { slug: "install", title: "Installing Wisp", blurb: "Step by step, for a person or an AI agent doing it for you." },
  { slug: "deploy", title: "Deploying", blurb: "Docker, keeping devices connected, HTTPS for phones, settings." },
  { slug: "computers", title: "Computers", blurb: "Agents' VMs, your own screen, watching and taking control." },
  { slug: "memory", title: "Memory", blurb: "Vault permissions, startup context and Obsidian sync." },
  { slug: "adapters", title: "Adding a harness", blurb: "Bring any agent: MCP, the Agent Client Protocol, or an adapter." },
] as const;

export const LAST_UPDATED_LEGAL = "October 17, 2026";
