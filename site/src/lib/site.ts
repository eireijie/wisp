/** Everything about the project that more than one page needs. The domain lives in astro.config.mjs. */

/** Where people write to us. A placeholder until the domain is chosen. */
export const CONTACT_EMAIL = "hello@warren.example";

export const GITHUB_REPO = "eireijie/warren";
export const REPO = `https://github.com/${GITHUB_REPO}`;
export const RELEASES = `${REPO}/releases`;
const latest = (name: string) => `${RELEASES}/latest/download/${name}`;

export const DOWNLOADS = {
  mac: latest("Warren-mac-arm64.dmg"),
  macIntel: latest("Warren-mac-x64.dmg"),
  windows: latest("Warren-win-x64.exe"),
  linuxAppImage: latest("Warren-linux-x86_64.AppImage"),
  linuxDeb: latest("Warren-linux-amd64.deb"),
  /** a preview to install directly, until Warren is on Google Play */
  android: latest("Warren-android.apk"),
};

export const INSTALL_UNIX = `curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/install.sh | bash`;
export const INSTALL_WINDOWS = `irm https://raw.githubusercontent.com/${GITHUB_REPO}/main/install.ps1 | iex`;
export const INSTALL_DOCKER =
  `docker run -d --name warren -p 4747:4747 -v warren-data:/data --restart unless-stopped ghcr.io/${GITHUB_REPO}`;

/** The docs, in reading order. Slugs match the markdown files' names. */
export const DOC_ORDER = [
  { slug: "install", title: "Installing Warren", blurb: "Step by step, for a person or an AI agent doing it for you." },
  { slug: "deploy", title: "Deploying", blurb: "Docker, keeping devices connected, HTTPS for phones, settings." },
  { slug: "computers", title: "Computers", blurb: "Agents' VMs, your own screen, watching and taking control." },
  { slug: "adapters", title: "Adding a harness", blurb: "Bring any agent: MCP, the Agent Client Protocol, or an adapter." },
] as const;

export const LAST_UPDATED_LEGAL = "October 17, 2026";
