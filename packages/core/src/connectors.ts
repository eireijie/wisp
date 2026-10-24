import { z } from "zod";
import { harnessInfo, harnessLabel } from "./harnesses.ts";

/**
 * Connectors: things an agent can connect to. An MCP server it starts (stdio), an MCP server it
 * reaches over the network (http), or a secret it needs for a service (an API key in its
 * environment). A workspace adds connectors once and picks which agents get each.
 */

export type ConnectorKind = "mcp-stdio" | "mcp-http" | "secret";

/** A connector as the API returns it. Values in `env` and literal header values are masked. */
export interface Connector {
  id: string;
  workspaceId: string;
  /** shown to people; also the MCP server's name for the harness (slugged) */
  name: string;
  kind: ConnectorKind;
  /** the catalog entry it came from, if any */
  catalogId: string | null;
  command: string | null;
  args: string[];
  url: string | null;
  headers: Record<string, string>;
  /** variables and secrets; `{{KEY}}` in args, url and headers is replaced with these */
  env: Record<string, string>;
  enabled: boolean;
  /** remote servers people sign in to (OAuth): whether someone has; null when it doesn't ask */
  auth?: { required: boolean; signedIn: boolean; error: string | null } | null;
  agentIds: string[];
  createdBy: string | null;
  createdAt: string;
}

/** What travels to a device for one run: everything resolved, secrets included. */
export const ConnectorSpec = z.object({
  name: z.string().max(64),
  kind: z.enum(["mcp-stdio", "mcp-http", "secret"]),
  command: z.string().max(1000).optional(),
  args: z.array(z.string().max(4000)).max(100).optional(),
  url: z.string().max(2000).optional(),
  headers: z.record(z.string().max(8000)).optional(),
  env: z.record(z.string().max(8000)).optional(),
});
export type ConnectorSpec = z.infer<typeof ConnectorSpec>;

/** What masked secret values look like on read; sending one back means "unchanged". */
export const SECRET_MASK = "••••";

export function maskSecret(v: string): string {
  if (!v) return "";
  return v.length >= 12 ? `${SECRET_MASK}${v.slice(-4)}` : SECRET_MASK;
}

export const isMasked = (v: string) => v.startsWith(SECRET_MASK);

/** A connector's name as an MCP server name: lowercase letters, digits, dashes and underscores. */
export function connectorSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  // "warren" and "browser" are the servers Warren itself gives every agent
  return !s ? "connector" : s === "warren" || s === "browser" ? `${s}-2` : s;
}

/** Replace `{{KEY}}` with the connector's own values (unknown keys are left as they are). */
export function fillTemplate(s: string, env: Record<string, string>): string {
  return s.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, k: string) => env[k] ?? m);
}

/** How a harness talks to Warren: from the harness list, "acp" for acp:<name> ones, else "mcp". */
function harnessProtocol(harnessId: string): "native" | "acp" | "mcp" {
  return harnessInfo(harnessId)?.protocol ?? (harnessId.startsWith("acp:") ? "acp" : "mcp");
}

/**
 * Whether an agent on this harness can use a connector of this kind. Remote ("mcp-http") is the
 * default because connected apps people sign in to (Zapier, Notion…) are remote.
 */
export function harnessSupportsConnectors(harnessId: string, kind: ConnectorKind = "mcp-http"): boolean {
  const protocol = harnessProtocol(harnessId);
  if (protocol === "native") return true;
  if (protocol === "acp") return kind !== "mcp-http";
  return false;
}

/** Why not, in plain words for the person ("Gemini CLI can't use connected apps yet"), or null when it can. */
export function connectorUnsupportedReason(harnessId: string, kind: ConnectorKind = "mcp-http"): string | null {
  if (harnessSupportsConnectors(harnessId, kind)) return null;
  const label = harnessLabel(harnessId);
  return harnessProtocol(harnessId) === "mcp" ? `${label} connects through warren-mcp, so it can't use connected apps here` : `${label} can't use connected apps yet`;
}

export const CONNECTOR_HELP = "Pick a helper that can use connected apps, or make one with Claude Code or Codex.";

/** One value a catalog connector asks for. */
export interface CatalogField {
  key: string;
  label: string;
  /** kept secret: masked once saved */
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
  hint?: string;
  /** where to get it */
  link?: string;
}

export interface CatalogConnector {
  id: string;
  name: string;
  description: string;
  /** Lucide icon name */
  icon: string;
  category: "Code" | "Chat & docs" | "Work tracking" | "Data" | "Web & browser" | "Payments" | "Utilities" | "Cloud keys";
  kind: ConnectorKind;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  fields: CatalogField[];
  /** what's needed on the device besides the values (Node, uv, Docker, a sign-in) */
  needs?: string;
  docs?: string;
}

/** Popular MCP servers and keys people actually connect agents to. */
export const CONNECTOR_CATALOG: CatalogConnector[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Issues, pull requests, code search and repos, through GitHub's own MCP server.",
    icon: "Github",
    category: "Code",
    kind: "mcp-http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer {{GITHUB_TOKEN}}" },
    fields: [{ key: "GITHUB_TOKEN", label: "Personal access token", secret: true, placeholder: "github_pat_…", link: "https://github.com/settings/personal-access-tokens" }],
    docs: "https://github.com/github/github-mcp-server",
  },
  {
    id: "git",
    name: "Git",
    description: "Read history, diffs and branches of local repositories, and make commits.",
    icon: "GitBranch",
    category: "Code",
    kind: "mcp-stdio",
    command: "uvx",
    args: ["mcp-server-git"],
    fields: [],
    needs: "uv on the device",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    id: "context7",
    name: "Context7",
    description: "Up-to-date docs and code examples for thousands of libraries, so code isn't written against old APIs.",
    icon: "BookOpen",
    category: "Code",
    kind: "mcp-http",
    url: "https://mcp.context7.com/mcp",
    headers: { CONTEXT7_API_KEY: "{{CONTEXT7_API_KEY}}" },
    fields: [{ key: "CONTEXT7_API_KEY", label: "API key", secret: true, optional: true, hint: "Optional; raises rate limits.", link: "https://context7.com/dashboard" }],
    docs: "https://github.com/upstash/context7",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Look up errors, issues and releases, and see what broke and where.",
    icon: "Bug",
    category: "Code",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@sentry/mcp-server@latest"],
    fields: [
      { key: "SENTRY_ACCESS_TOKEN", label: "User auth token", secret: true, link: "https://sentry.io/settings/account/api/auth-tokens/" },
      { key: "SENTRY_HOST", label: "Host", optional: true, placeholder: "sentry.io", hint: "Only for self-hosted Sentry." },
    ],
    needs: "Node on the device",
    docs: "https://github.com/getsentry/sentry-mcp",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Read channels and threads, post messages and reply, as a Slack bot.",
    icon: "MessageSquare",
    category: "Chat & docs",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    fields: [
      { key: "SLACK_BOT_TOKEN", label: "Bot token", secret: true, placeholder: "xoxb-…", link: "https://api.slack.com/apps" },
      { key: "SLACK_TEAM_ID", label: "Team ID", placeholder: "T01234567" },
    ],
    needs: "Node on the device",
    docs: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read and write Notion pages and databases.",
    icon: "NotebookText",
    category: "Chat & docs",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    fields: [{ key: "NOTION_TOKEN", label: "Integration token", secret: true, placeholder: "ntn_…", hint: "Share the pages it may use with the integration.", link: "https://www.notion.so/profile/integrations" }],
    needs: "Node on the device",
    docs: "https://github.com/makenotion/notion-mcp-server",
  },
  {
    id: "gdrive",
    name: "Google Drive",
    description: "Search and read files in Google Drive, with Docs and Sheets exported as text.",
    icon: "HardDrive",
    category: "Chat & docs",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gdrive"],
    fields: [
      { key: "GDRIVE_OAUTH_PATH", label: "OAuth client file", placeholder: "/path/to/gcp-oauth.keys.json", hint: "On the device. Run the server once by hand to sign in." },
      { key: "GDRIVE_CREDENTIALS_PATH", label: "Saved sign-in file", placeholder: "/path/to/.gdrive-server-credentials.json" },
    ],
    needs: "Node on the device, and a one-time Google sign-in there",
    docs: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gdrive",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Find, create and update Linear issues, projects and comments.",
    icon: "SquareKanban",
    category: "Work tracking",
    kind: "mcp-http",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: "Bearer {{LINEAR_API_KEY}}" },
    fields: [{ key: "LINEAR_API_KEY", label: "API key", secret: true, placeholder: "lin_api_…", link: "https://linear.app/settings/account/security" }],
    docs: "https://linear.app/docs/mcp",
  },
  {
    id: "jira",
    name: "Jira & Confluence",
    description: "Search and update Jira issues and Confluence pages (Cloud or Server).",
    icon: "Trello",
    category: "Work tracking",
    kind: "mcp-stdio",
    command: "uvx",
    args: ["mcp-atlassian"],
    fields: [
      { key: "JIRA_URL", label: "Jira URL", placeholder: "https://your-company.atlassian.net" },
      { key: "JIRA_USERNAME", label: "Email", placeholder: "you@company.com" },
      { key: "JIRA_API_TOKEN", label: "API token", secret: true, link: "https://id.atlassian.com/manage-profile/security/api-tokens" },
      { key: "CONFLUENCE_URL", label: "Confluence URL", optional: true, placeholder: "https://your-company.atlassian.net/wiki" },
      { key: "CONFLUENCE_USERNAME", label: "Confluence email", optional: true },
      { key: "CONFLUENCE_API_TOKEN", label: "Confluence API token", secret: true, optional: true },
    ],
    needs: "uv on the device",
    docs: "https://github.com/sooperset/mcp-atlassian",
  },
  {
    id: "postgres",
    name: "Postgres",
    description: "Look at a Postgres database's tables and run read-only SQL queries.",
    icon: "Database",
    category: "Data",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "{{DATABASE_URL}}"],
    fields: [{ key: "DATABASE_URL", label: "Connection URL", secret: true, placeholder: "postgresql://user:pass@host:5432/db", hint: "Use a read-only user." }],
    needs: "Node on the device",
    docs: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres",
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Manage Supabase projects: tables, SQL, migrations, edge functions and logs.",
    icon: "Zap",
    category: "Data",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@supabase/mcp-server-supabase@latest", "--read-only"],
    fields: [{ key: "SUPABASE_ACCESS_TOKEN", label: "Personal access token", secret: true, placeholder: "sbp_…", link: "https://supabase.com/dashboard/account/tokens" }],
    needs: "Node on the device",
    docs: "https://github.com/supabase-community/supabase-mcp",
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read and write files in one folder on the device, and nowhere else.",
    icon: "FolderOpen",
    category: "Data",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{{FOLDER}}"],
    fields: [{ key: "FOLDER", label: "Folder", placeholder: "/Users/you/Documents/shared", hint: "A path on the agent's device." }],
    needs: "Node on the device",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "memory",
    name: "Knowledge graph",
    description: "A small graph memory of people, things and how they relate. (Warren's vault is the shared memory; this is extra.)",
    icon: "Network",
    category: "Data",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    fields: [],
    needs: "Node on the device",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "playwright",
    name: "Playwright browser",
    description: "Drive a browser by page elements: open pages, click, type, fill forms, take snapshots.",
    icon: "Globe",
    category: "Web & browser",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    fields: [],
    needs: "Node on the device. Agents with their own VM already have a browser.",
    docs: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Headless Chrome: navigate, screenshot, click and run JavaScript on pages.",
    icon: "MousePointerClick",
    category: "Web & browser",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    fields: [],
    needs: "Node on the device",
    docs: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/puppeteer",
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Fetch a web page and get it back as clean markdown.",
    icon: "Download",
    category: "Web & browser",
    kind: "mcp-stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    fields: [],
    needs: "uv on the device",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web, news, image and local search through the Brave Search API.",
    icon: "Search",
    category: "Web & browser",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@brave/brave-search-mcp-server"],
    fields: [{ key: "BRAVE_API_KEY", label: "API key", secret: true, link: "https://brave.com/search/api/" }],
    needs: "Node on the device",
    docs: "https://github.com/brave/brave-search-mcp-server",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Customers, payments, invoices, products and refunds in your Stripe account.",
    icon: "CreditCard",
    category: "Payments",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@stripe/mcp", "--tools=all"],
    fields: [{ key: "STRIPE_SECRET_KEY", label: "Secret or restricted key", secret: true, placeholder: "rk_live_… or sk_test_…", hint: "A restricted key limits what agents can do.", link: "https://dashboard.stripe.com/apikeys" }],
    needs: "Node on the device",
    docs: "https://github.com/stripe/agent-toolkit",
  },
  {
    id: "time",
    name: "Time",
    description: "Current time and conversions between time zones.",
    icon: "Clock",
    category: "Utilities",
    kind: "mcp-stdio",
    command: "uvx",
    args: ["mcp-server-time"],
    fields: [],
    needs: "uv on the device",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
  },
  {
    id: "sequential-thinking",
    name: "Sequential thinking",
    description: "A scratchpad tool for working through hard problems step by step.",
    icon: "ListOrdered",
    category: "Utilities",
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    fields: [],
    needs: "Node on the device",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "aws",
    name: "AWS keys",
    description: "AWS credentials in the agent's environment, for the aws CLI and SDKs.",
    icon: "Cloud",
    category: "Cloud keys",
    kind: "secret",
    fields: [
      { key: "AWS_ACCESS_KEY_ID", label: "Access key ID", secret: true },
      { key: "AWS_SECRET_ACCESS_KEY", label: "Secret access key", secret: true },
      { key: "AWS_REGION", label: "Region", optional: true, placeholder: "us-east-1" },
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare token",
    description: "A Cloudflare API token in the agent's environment, for wrangler and the API.",
    icon: "CloudCog",
    category: "Cloud keys",
    kind: "secret",
    fields: [
      { key: "CLOUDFLARE_API_TOKEN", label: "API token", secret: true, link: "https://dash.cloudflare.com/profile/api-tokens" },
      { key: "CLOUDFLARE_ACCOUNT_ID", label: "Account ID", optional: true },
    ],
  },
  {
    id: "huggingface",
    name: "Hugging Face token",
    description: "HF_TOKEN in the agent's environment, for models and datasets on the Hub.",
    icon: "Smile",
    category: "Cloud keys",
    kind: "secret",
    fields: [{ key: "HF_TOKEN", label: "Access token", secret: true, placeholder: "hf_…", link: "https://huggingface.co/settings/tokens" }],
  },
];

export function catalogConnector(id: string): CatalogConnector | undefined {
  return CONNECTOR_CATALOG.find((c) => c.id === id);
}

/** An app a non-technical person asks for by name. */
export interface EverydayApp {
  name: string;
  aliases: string[];
  /** built-in catalog id when Warren's catalog has it, else connected through Zapier */
  catalogId: string | null;
  /** one plain line: what the helper will be able to do */
  does: string;
  /** what account is needed */
  account: string;
}

/** Catalog ids of the everyday apps, in the order a non-technical person would want them. */
export const EVERYDAY_CATALOG_ORDER: string[] = ["slack", "notion", "gdrive"];

const CATEGORY_ORDER: CatalogConnector["category"][] = ["Chat & docs", "Work tracking", "Web & browser", "Utilities", "Data", "Payments", "Code", "Cloud keys"];

/** The catalog with everyday apps first and developer things last. Stable; does not change the input. */
export function everydayFirst(list: CatalogConnector[]): CatalogConnector[] {
  const rank = (c: CatalogConnector) => {
    const cat = CATEGORY_ORDER.indexOf(c.category);
    const i = EVERYDAY_CATALOG_ORDER.indexOf(c.id);
    return [cat < 0 ? CATEGORY_ORDER.length : cat, i < 0 ? EVERYDAY_CATALOG_ORDER.length : i] as const;
  };
  return list
    .map((c, i) => [c, i, rank(c)] as const)
    .sort((a, b) => a[2][0] - b[2][0] || a[2][1] - b[2][1] || a[1] - b[1])
    .map(([c]) => c);
}
