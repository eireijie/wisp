import { useEffect, useState, type ReactNode } from "react";
import { BadgeCheck, ExternalLink, KeyRound, LogIn, LogOut, MoreHorizontal, Pencil, Plug, Plus, Server, ShieldQuestion, Trash2 } from "lucide-react";
import { CONNECTOR_CATALOG, CONNECTOR_HELP, catalogConnector, connectorUnsupportedReason, everydayAppFor, everydayFirst, harnessSupportsConnectors, isMasked, type EverydayApp, type Agent, type CatalogConnector, type CatalogField, type Connector, type ConnectorKind, trustLabel, type MarketplaceEntry, type MarketplaceInstall, type TrustLabel } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { Button, Field, Input, Loader, Menu, Modal, Pill, Textarea, cx } from "../components/ui.tsx";
import { AgentPicker, AgentStack, Group, CatalogIcon, IconTile, SearchBox, ShopHeader } from "../components/ShopParts.tsx";
import { useDevices, type DeviceInfo } from "../devices.ts";
import { Advanced, useSimple } from "../experience.tsx";

const KIND_LABEL: Record<ConnectorKind, string> = { "mcp-stdio": "MCP · runs on the device", "mcp-http": "MCP · remote", secret: "Key" };

/** Which harnesses a kind of connector reaches today, in words. */
function worksWith(kind: ConnectorKind): string {
  if (kind === "mcp-http") return "Works with Claude Code and Codex. Not wired yet for ACP agents (Gemini, OpenCode, Hermes…).";
  if (kind === "mcp-stdio") return "Works with Claude Code, Codex, and ACP agents (Gemini, OpenCode, Hermes, Cursor…).";
  return "Set in the environment of every agent Warren runs: Claude Code, Codex and ACP agents.";
}

export interface ConnectSummary {
  /** what the helpers will be able to do */
  can: string;
  /** who runs the server */
  runBy: string;
  /** a plain warning, only when the server isn't verified */
  caution: string | null;
}

/** The host of a URL, or null if it isn't one. */
function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

/**
 * "Before you connect": what helpers get and who runs the server, in plain words. Only says what
 * the entry itself tells us (its name, kind, publisher, domain and trust label); never invents
 * a list of permissions, since those are decided by the app and the account you sign in with.
 */
export function connectSummary(src: { builtIn: CatalogConnector } | { entry: MarketplaceEntry; install: MarketplaceInstall }): ConnectSummary {
  if ("builtIn" in src) {
    const c = src.builtIn;
    const host = c.kind === "mcp-http" ? hostOf(c.url) : null;
    return {
      can: c.kind === "secret" ? `Your helpers get the key you enter, so they can use ${c.name} with it.` : `Your helpers will be able to use ${c.name} through this connection: read and act on what this app allows.`,
      runBy:
        c.kind === "secret"
          ? "Warren keeps the key and gives it only to the helpers you pick."
          : c.kind === "mcp-http"
            ? `On Warren's list of well-known apps. It connects to ${host ?? "the app's own address"}, not to a server run by Warren.`
            : "On Warren's list of well-known apps. It runs as a program on the helper's own computer.",
      caution: null,
    };
  }
  const { entry, install } = src;
  const trust = trustLabel(entry);
  const name = entry.name;
  const who = entry.domain ? `${entry.publisher} (${entry.domain})` : entry.publisher;
  const can = install.fields.length ? `Your helpers get the key you enter, so they can use ${name} with it.` : `Your helpers will be able to use ${name} through this connection: read and act on what this app allows.`;
  if (trust.kind === "unverified") {
    return { can, runBy: `Run by ${entry.publisher}, not by the app's maker or Warren.`, caution: "Nobody has confirmed who they are. Only connect if you trust them." };
  }
  if (trust.kind === "maker") {
    return { can, runBy: `Made and run by ${trust.text.replace(/^Made by /, "")} (${entry.domain ?? entry.publisher}), not by Warren.`, caution: null };
  }
  return { can, runBy: `Run by ${who}, not by Warren. The registry confirmed who they are; that doesn't mean ${name}'s own maker endorses it.`, caution: null };
}

function BeforeYouConnect({ s }: { s: ConnectSummary }) {
  return (
    <section aria-label="Before you connect" className="rounded-lg border border-line p-3 space-y-1">
      <h3 className="text-sm font-medium">Before you connect</h3>
      <p className="text-xs text-muted">{s.can}</p>
      <p className="text-xs text-muted">{s.runBy}</p>
      {s.caution && <p className="text-xs text-warn">{s.caution}</p>}
    </section>
  );
}

/**
 * The device an agent runs on doesn't have the command this connector needs (as the device last
 * reported), so the connector won't start there. Null when it does, or when nobody knows yet.
 */
function missingOn(a: Agent, command: string, devices: DeviceInfo[] | null): DeviceInfo | null {
  const bin = command.trim().split(/\s+/)[0];
  const d = devices?.find((d) => d.id === a.nodeId);
  return bin && d?.capabilities?.commands && d.capabilities.commands[bin] === false ? d : null;
}

/** Why a connector won't reach this agent, if it won't (or may not start). */
function agentNote(kind: ConnectorKind, command: string, devices: DeviceInfo[] | null) {
  return (a: Agent) => {
    const why = connectorUnsupportedReason(a.harness, kind);
    if (why) return why;
    const device = kind === "mcp-stdio" ? missingOn(a, command, devices) : null;
    if (device) return `${device.name} doesn't have ${command.trim().split(/\s+/)[0]}`;
    return null;
  };
}

/** True when there are agents but none that would get this connector could use it. */
export function connectBlocked(agents: Pick<Agent, "id" | "harness">[], agentIds: string[], kind: ConnectorKind): boolean {
  if (!agents.length) return false;
  const chosen = agentIds.length ? agents.filter((a) => agentIds.includes(a.id)) : agents;
  return !chosen.some((a) => harnessSupportsConnectors(a.harness, kind));
}

/** The catalog as listed: Simple shows everyday apps first. */
export function catalogFor(simple: boolean, category: string, list: CatalogConnector[] = CONNECTOR_CATALOG): CatalogConnector[] {
  const inCat = list.filter((c) => category === "All" || c.category === category);
  return simple ? everydayFirst(inCat) : inCat;
}

/** The registry results with the recommended option first (Zapier, for apps that go through it). */
export function recommendedFirst(entries: MarketplaceEntry[], zapier: MarketplaceEntry | null, app: EverydayApp | null): MarketplaceEntry[] {
  if (!app || app.catalogId || !zapier) return entries;
  return [zapier, ...entries.filter((e) => e.id !== zapier.id)];
}

const ZAPIER_ID = "com.zapier/mcp";
const CATEGORIES = ["All", ...new Set(CONNECTOR_CATALOG.map((c) => c.category))];
const SIMPLE_CATEGORIES = ["All", ...new Set(everydayFirst(CONNECTOR_CATALOG).map((c) => c.category))];

/**
 * Connectors: MCP servers agents can call (on their device, or remote) and keys they need for
 * services. A catalog of popular ones, ready to fill in; and your own.
 */
export function ConnectorsView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const canEdit = me.role !== "guest";
  const simple = useSimple();
  const [list, setList] = useState<Connector[] | null>(null);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("All");
  const [form, setForm] = useState<{ entry?: CatalogConnector; existing?: Connector } | null>(null);
  const [adding, setAdding] = useState<MarketplaceEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"marketplace" | "catalog">(simple ? "catalog" : "marketplace");
  const [market, setMarket] = useState<{ q: string; entries: MarketplaceEntry[] | null; error: string | null }>({ q: "", entries: null, error: null });
  // coming back from a sign-in page: ?signin=ok (or why it didn't work)
  const [retry, setRetry] = useState(0);
  // Zapier, remembered once the registry lists it, so Simple mode can recommend it above the tabs
  const [zapier, setZapier] = useState<MarketplaceEntry | null>(null);
  const [signedIn] = useState(() => new URLSearchParams(location.search).get("signin"));
  useEffect(() => {
    if (signedIn) history.replaceState(null, "", location.pathname + location.hash);
  }, [signedIn]);

  // the MCP Registry, searched on the hub (popular ones until someone types)
  useEffect(() => {
    const query = q.trim();
    setMarket((m) => ({ ...m, entries: m.q === query ? m.entries : null, error: null }));
    const t = setTimeout(
      () =>
        api<{ entries: MarketplaceEntry[] }>("GET", `/api/marketplace?q=${encodeURIComponent(query)}`).then(
          (r) => {
            setMarket({ q: query, entries: r.entries, error: null });
            const z = r.entries.find((e) => e.id === ZAPIER_ID);
            if (z) setZapier(z);
          },
          (e) => setMarket({ q: query, entries: [], error: (e as Error).message }),
        ),
      query ? 350 : 0,
    );
    return () => clearTimeout(t);
  }, [q, retry]);

  /** Send the person to a remote server's sign-in page; it brings them back here. */
  async function signIn(c: Connector) {
    setError(null);
    try {
      const r = await api<{ url?: string }>("POST", `/api/connectors/${c.id}/signin`, { origin: location.origin });
      if (r.url) location.href = r.url;
      else load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const afterSave = (c?: Connector) => {
    setForm(null);
    setAdding(null);
    if (c?.auth?.required && !c.auth.signedIn) void signIn(c);
    else load();
  };

  const load = () => api<Connector[]>("GET", "/api/connectors").then(setList, (e) => (setList([]), setError(e.message)));
  useEffect(() => {
    load();
  }, []);

  const needle = q.trim().toLowerCase();
  const match = (...s: (string | null | undefined)[]) => !needle || s.some((x) => x?.toLowerCase().includes(needle));
  const connected = (list ?? []).filter((c) => match(c.name, c.url, c.command, catalogConnector(c.catalogId ?? "")?.description));
  const catalog = catalogFor(simple, category).filter((c) => match(c.name, c.description, c.category));
  const everyday = q.trim() ? everydayAppFor(q) : null;
  const builtInFor = everyday?.catalogId ? catalogConnector(everyday.catalogId) : undefined;
  const marketCard = (e: MarketplaceEntry) => <MarketCard key={e.id} e={e} added={(list ?? []).some((c) => c.catalogId === `registry:${e.id}`)} canEdit={canEdit} onAdd={() => setAdding(e)} />;
  const catalogCard = (c: CatalogConnector, label = "Built in") => <CatalogCard key={c.id} c={c} label={label} added={countFor(c.id) > 0} canEdit={canEdit} onAdd={() => setForm({ entry: c })} />;
  const registryGrid = (entries: MarketplaceEntry[], lead?: ReactNode) => (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        {q.trim() ? (
          <>Results from the MCP Registry. Servers whose publisher is verified come first. "Made by" means the app's own company publishes it; "Verified publisher" only means the registry confirmed who published it.</>
        ) : (
          <>Popular servers from the MCP Registry. Search to find any of its thousands more. Zapier connects thousands more apps, like Gmail, Google Calendar, Drive and Todoist, with one sign-in.</>
        )}
      </p>
      {market.error && (
        <p className="text-sm text-bad flex items-center gap-2">
          {market.error}
          <Button className="h-7" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </Button>
        </p>
      )}
      {market.entries === null ? (
        <Loader />
      ) : entries.length === 0 && !lead ? (
        !market.error && <p className="text-sm text-muted py-6 text-center">Nothing in the registry matches "{q}".{simple ? "" : " You can still add your own."}</p>
      ) : (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {lead}
          {entries.map(marketCard)}
        </div>
      )}
    </div>
  );
  const countFor = (id: string) => (list ?? []).filter((c) => c.catalogId === id).length;

  async function act(p: Promise<unknown>) {
    setError(null);
    try {
      await p;
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ShopHeader
        title="Connected apps"
        onBack={onBack}
        action={
          canEdit && !simple && (
            <Button variant="primary" onClick={() => setForm({})}>
              <Plus size={16} /> <span className="hidden sm:inline">Add your own</span>
              <span className="sm:hidden">Add</span>
            </Button>
          )
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl px-4 md:px-6 py-5 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="text-sm text-muted flex-1">Apps your helpers can use for you, like Gmail or Slack. Each one asks you to sign in (a few ask for a key instead); your password never goes to a helper.</p>
            <SearchBox value={q} onChange={setQ} placeholder={simple ? "Search apps" : "Search apps and MCP servers"} />
          </div>
          {error && <p className="text-sm text-bad">{error}</p>}
          {signedIn && <p className={cx("text-sm rounded-lg px-3 py-2", signedIn === "ok" ? "bg-ok/10 text-ok" : "bg-bad/10 text-bad")}>{signedIn === "ok" ? "Signed in. Agents use it from their next run." : `Sign-in didn't finish: ${signedIn}`}</p>}
          {!canEdit && <p className="text-xs text-muted">Guests can look around; members add and change connectors.</p>}

          <section aria-labelledby="connected-h">
            <h2 id="connected-h" className="text-[13px] font-semibold text-muted mb-2">
              Connected {list && <span className="text-faint tabular-nums">{list.length}</span>}
            </h2>
            {list === null ? (
              <Loader />
            ) : list.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">Nothing connected yet. Pick one from the catalog below{simple ? "." : ", or add your own."}</div>
            ) : connected.length === 0 ? (
              <p className="text-sm text-muted">No connected ones match "{q}".</p>
            ) : (
              <div className="rounded-xl border border-line divide-y divide-line bg-panel">
                {connected.map((c) => (
                  <ConnectedRow key={c.id} c={c} agents={agents} canEdit={canEdit} onSignIn={() => signIn(c)} onSignOut={() => act(api("POST", `/api/connectors/${c.id}/signout`))} onEdit={() => setForm({ existing: c, entry: catalogConnector(c.catalogId ?? "") })} onToggle={() => act(api("PATCH", `/api/connectors/${c.id}`, { enabled: !c.enabled }))} onRemove={() => confirm(`Remove ${c.name}? Agents lose it on their next run.`) && act(api("DELETE", `/api/connectors/${c.id}`))} />
                ))}
              </div>
            )}
          </section>

          {simple && everyday && (
            <>
              <section aria-labelledby="recommended-h" className="space-y-2">
                <h2 id="recommended-h" className="text-[13px] font-semibold text-muted">
                  Recommended way to connect {everyday.name}
                </h2>
                <p className="text-sm text-muted">{everyday.does}</p>
                <p className="text-sm text-muted">Needs: {everyday.account}</p>
                <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">{builtInFor ? catalogCard(builtInFor) : zapier ? marketCard(zapier) : <Loader />}</div>
              </section>
              <section aria-labelledby="other-ways-h" className="space-y-2">
                <h2 id="other-ways-h" className="text-[13px] font-semibold text-muted">
                  Other ways
                </h2>
                <Advanced title="Other servers from the registry">{registryGrid((market.entries ?? []).filter((e) => e.id !== ZAPIER_ID))}</Advanced>
              </section>
            </>
          )}
          {simple && !everyday && zapier && (
            <section aria-labelledby="recommended-h" className="space-y-2">
              <h2 id="recommended-h" className="text-[13px] font-semibold text-muted">
                Recommended for most people
              </h2>
              <p className="text-sm text-muted">One sign-in with Zapier connects Gmail, Google Calendar, Drive, Todoist and thousands more apps.</p>
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">{marketCard(zapier)}</div>
            </section>
          )}

          {!(simple && everyday) && (
            <div className="flex items-center gap-1 border-b border-line">
              {(
                [
                  ["marketplace", "Marketplace"],
                  ["catalog", "Warren's catalog"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)} className={cx("h-9 px-3 -mb-px border-b-2 text-sm", tab === id ? "border-accent text-ink font-medium" : "border-transparent text-muted hover:text-ink")}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {!(simple && everyday) && tab === "marketplace" && (
            <section aria-label="Marketplace" className="space-y-3">
              {everyday && (
                <p className="text-sm">
                  Recommended for {everyday.name}: {builtInFor ? "Warren's built-in connector." : "Zapier, which connects it with one sign-in."}
                </p>
              )}
              {registryGrid(recommendedFirst(market.entries ?? [], zapier, everyday), builtInFor ? catalogCard(builtInFor) : undefined)}
            </section>
          )}

          {!(simple && everyday) && tab === "catalog" && (
          <section aria-labelledby="catalog-h">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
              <h2 id="catalog-h" className="text-xs text-muted flex-1">
                Ones Warren knows well, with what each needs.
              </h2>
              <div className="flex gap-1 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 pb-1 sm:pb-0">
                {(simple ? SIMPLE_CATEGORIES : CATEGORIES).map((cat) => (
                  <button key={cat} onClick={() => setCategory(cat)} className={cx("h-7 px-2.5 rounded-full text-xs whitespace-nowrap border", category === cat ? "bg-accent text-accent-ink border-transparent" : "border-line text-muted hover:text-ink hover:bg-hover")}>
                    {cat}
                  </button>
                ))}
              </div>
            </div>
            {catalog.length === 0 ? (
              <p className="text-sm text-muted py-6 text-center">Nothing in the catalog matches.{simple ? "" : " You can still add your own."}</p>
            ) : (
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">{catalog.map((c) => catalogCard(c))}</div>
            )}
          </section>
          )}

          {simple && canEdit && (
            <Advanced title="Add your own server">
              <p className="text-sm text-muted mb-2">For an app that isn't listed. You'll need to know how its server is started or where it lives.</p>
              <Button onClick={() => setForm({})}>
                <Plus size={14} /> Add your own
              </Button>
            </Advanced>
          )}
        </div>
      </div>
      {adding && <MarketAdd entry={adding} agents={agents} taken={(list ?? []).map((c) => c.name.toLowerCase())} onClose={() => setAdding(null)} onSaved={afterSave} />}
      {form && (
        <ConnectorForm
          entry={form.entry}
          existing={form.existing}
          agents={agents}
          taken={(list ?? []).filter((c) => c.id !== form.existing?.id).map((c) => c.name.toLowerCase())}
          onClose={() => setForm(null)}
          onSaved={afterSave}
        />
      )}
    </div>
  );
}

function CatalogCard({ c, label, added, canEdit, onAdd }: { c: CatalogConnector; label: string; added: boolean; canEdit: boolean; onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <IconTile>
          <CatalogIcon name={c.icon} />
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{c.name}</div>
          <div className="text-[11px] text-muted">{label} · {KIND_LABEL[c.kind]}</div>
        </div>
        {added && <Pill tone="ok">Added</Pill>}
      </div>
      <p className="text-sm text-muted flex-1">{c.description}</p>
      <div className="flex items-center gap-2">
        {c.docs && (
          <a href={c.docs} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-ink inline-flex items-center gap-1">
            Docs <ExternalLink size={11} />
          </a>
        )}
        <span className="flex-1" />
        {canEdit && (
          <Button className="h-8" onClick={onAdd}>
            <Plus size={14} /> Add
          </Button>
        )}
      </div>
    </div>
  );
}

function ConnectedRow({ c, agents, canEdit, onEdit, onToggle, onRemove, onSignIn, onSignOut }: { c: Connector; agents: Agent[]; canEdit: boolean; onEdit: () => void; onToggle: () => void; onRemove: () => void; onSignIn: () => void; onSignOut: () => void }) {
  const entry = catalogConnector(c.catalogId ?? "");
  const where = c.kind === "mcp-stdio" ? [c.command, ...c.args].join(" ") : c.kind === "mcp-http" ? c.url : Object.keys(c.env).join(", ");
  return (
    <div className={cx("flex items-center gap-3 px-3 sm:px-4 py-3", !c.enabled && "opacity-60")}>
      <IconTile>
        <CatalogIcon name={entry?.icon} fallback={c.kind === "secret" ? KeyRound : c.kind === "mcp-http" ? Plug : Server} />
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate">{c.name}</span>
          <span className="hidden sm:inline">
            <Pill tone={c.kind === "secret" ? "warn" : "info"}>{KIND_LABEL[c.kind]}</Pill>
          </span>
          {!c.enabled && <Pill>Off</Pill>}
          {c.auth?.signedIn && <Pill tone="ok">Signed in</Pill>}
        </div>
        <div className="text-xs text-muted font-mono truncate mt-0.5" title={where ?? ""}>
          {where}
        </div>
        {c.auth?.error && <div className="text-xs text-bad mt-0.5">{c.auth.error}</div>}
      </div>
      {canEdit && c.auth?.required && !c.auth.signedIn && (
        <Button variant="primary" className="h-8" onClick={onSignIn}>
          <LogIn size={14} /> Sign in
        </Button>
      )}
      <div className="hidden md:block w-40 shrink-0">
        <AgentStack agents={agents} ids={c.agentIds} />
      </div>
      {canEdit && (
        <>
          <label className="hidden sm:flex items-center gap-1.5 text-xs text-muted cursor-pointer" title={c.enabled ? "Turn off for every agent" : "Turn on"}>
            <input type="checkbox" checked={c.enabled} onChange={onToggle} /> On
          </label>
          <Menu
            align="right"
            trigger={(_open, toggle) => (
              <button className="p-1.5 rounded-md hover:bg-hover text-muted" onClick={toggle} aria-label={`${c.name} options`}>
                <MoreHorizontal size={18} />
              </button>
            )}
            items={[
              { label: "Edit", icon: <Pencil size={15} />, onSelect: onEdit },
              { label: c.enabled ? "Turn off" : "Turn on", icon: <Plug size={15} />, onSelect: onToggle },
              // any remote server may have a sign-in, even if it didn't say so when it was added
              ...(c.kind === "mcp-http" ? [{ label: c.auth?.signedIn ? "Sign in again" : "Sign in", icon: <LogIn size={15} />, onSelect: onSignIn }] : []),
              ...(c.auth?.signedIn ? [{ label: "Sign out", icon: <LogOut size={15} />, onSelect: onSignOut }] : []),
              "divider",
              { label: "Remove", icon: <Trash2 size={15} />, onSelect: onRemove, danger: true },
            ]}
          />
        </>
      )}
    </div>
  );
}

type Row = { key: string; value: string; saved?: string; field?: CatalogField };

/** Add from the catalog, add your own, or edit one. Asks for the values it needs and which agents get it. */
function ConnectorForm({ entry, existing, agents, taken, onClose, onSaved, top, title: titleOverride, summary: summaryProp }: { entry?: CatalogConnector; existing?: Connector; agents: Agent[]; taken: string[]; onClose: () => void; onSaved: (c?: Connector) => void; top?: ReactNode; title?: string; summary?: ConnectSummary }) {
  const [kind, setKind] = useState<ConnectorKind>(existing?.kind ?? entry?.kind ?? "mcp-stdio");
  const [name, setName] = useState(existing?.name ?? entry?.name ?? "");
  const [command, setCommand] = useState(existing?.command ?? entry?.command ?? "");
  const [args, setArgs] = useState((existing?.args ?? entry?.args ?? []).join("\n"));
  const [url, setUrl] = useState(existing?.url ?? entry?.url ?? "");
  const [headers, setHeaders] = useState(
    Object.entries(existing?.headers ?? entry?.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  );
  const [rows, setRows] = useState<Row[]>(() => {
    const saved = existing?.env ?? {};
    const fromFields = (entry?.fields ?? []).map((f) => ({ key: f.key, value: !f.secret && saved[f.key] && !isMasked(saved[f.key]) ? saved[f.key] : "", saved: saved[f.key], field: f }));
    const extra = Object.keys(saved)
      .filter((k) => !fromFields.some((r) => r.key === k))
      .map((k) => ({ key: k, value: "", saved: saved[k] }));
    const all = [...fromFields, ...extra];
    return all.length || entry ? all : [{ key: "", value: "" }];
  });
  const [agentIds, setAgentIds] = useState<string[]>(existing?.agentIds ?? (agents.length === 1 && harnessSupportsConnectors(agents[0].harness, existing?.kind ?? entry?.kind ?? "mcp-stdio") ? [agents[0].id] : []));
  // a different kind (custom form) can rule out agents that were ticked
  useEffect(() => {
    if (existing) return;
    setAgentIds((ids) => {
      const keep = ids.filter((id) => { const a = agents.find((x) => x.id === id); return !a || harnessSupportsConnectors(a.harness, kind); });
      return keep.length === ids.length ? ids : keep;
    });
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const custom = !entry;
  const summary = summaryProp ?? (entry && !existing ? connectSummary({ builtIn: entry }) : null);
  const [showAdvanced, setShowAdvanced] = useState(custom);
  const devices = useDevices(10_000);

  const blocked = !existing && connectBlocked(agents, agentIds, kind);
  const nameTaken = taken.includes(name.trim().toLowerCase());
  const missing = rows.filter((r) => r.field && !r.field.optional && !r.value.trim() && !r.saved).map((r) => r.field!.label);
  // asked of each chosen agent's device before connecting, so a connector that can't start is caught here, not in a failed run
  const cantStart = kind === "mcp-stdio" ? agentIds.flatMap((id) => {
    const a = agents.find((x) => x.id === id);
    const d = a && missingOn(a, command, devices);
    return a && d ? [`${a.name}'s device ${d.name} doesn't have "${command.trim().split(/\s+/)[0]}". ${entry?.needs ? `Needs: ${entry.needs}.` : "Install it there first."}`] : [];
  }) : [];

  const lines = (s: string) =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  async function save() {
    setError(null);
    const env = Object.fromEntries(rows.filter((r) => r.key.trim() && (r.value.trim() || r.saved)).map((r) => [r.key.trim(), r.value.trim() || r.saved!]));
    const hdrs = Object.fromEntries(
      lines(headers).map((l) => {
        const i = l.indexOf(":");
        return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
    );
    const body: Record<string, unknown> = { name: name.trim(), env, agentIds };
    if (kind === "mcp-stdio") Object.assign(body, { command: command.trim(), args: lines(args) });
    if (kind === "mcp-http") Object.assign(body, { url: url.trim(), headers: hdrs });
    setBusy(true);
    try {
      if (existing) onSaved(await api<Connector>("PATCH", `/api/connectors/${existing.id}`, body));
      else onSaved(await api<Connector>("POST", "/api/connectors", { ...body, kind, catalogId: entry?.id ?? null }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const title = titleOverride ?? (existing ? `Edit ${existing.name}` : entry ? `Add ${entry.name}` : "Add your own connector");

  return (
    <Modal title={title} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {top}
        {entry && !top && (
          <div className="flex items-start gap-3 rounded-lg bg-bg p-3">
            <IconTile>
              <CatalogIcon name={entry.icon} />
            </IconTile>
            <div className="text-sm text-muted">
              {entry.description}
              {entry.needs && <div className="mt-1 text-xs">Needs: {entry.needs}.</div>}
            </div>
          </div>
        )}

        {custom && !existing && (
          <Group label="Kind">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {(
                [
                  ["mcp-stdio", "Local MCP server", "A command the agent's device runs"],
                  ["mcp-http", "Remote MCP server", "A URL the agent connects to"],
                  ["secret", "API key or secret", "Values set in the agent's environment"],
                ] as const
              ).map(([k, label, hint]) => (
                <button type="button" key={k} onClick={() => setKind(k)} className={cx("text-left rounded-lg border p-2.5", kind === k ? "border-ring ring-2 ring-ring/30" : "border-line hover:bg-hover")}>
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-xs text-muted">{hint}</div>
                </button>
              ))}
            </div>
          </Group>
        )}

        <Field label="Name" hint={nameTaken ? <span className="text-bad">You already have a connector with this name.</span> : "Agents see its tools under this name."}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
        </Field>

        {(rows.length > 0 || kind === "secret" || custom) && (
          <div className="space-y-3">
            <div className="text-sm font-medium">{kind === "secret" ? "Values" : entry?.fields.length ? "What it needs" : "Environment variables"}</div>
            {rows.map((r, i) =>
              r.field ? (
                <Field
                  key={r.key}
                  label={`${r.field.label}${r.field.optional ? " (optional)" : ""}`}
                  hint={
                    <>
                      {r.field.hint}{" "}
                      {r.field.link && (
                        <a href={r.field.link} target="_blank" rel="noreferrer" className="underline">
                          Get one
                        </a>
                      )}
                    </>
                  }
                >
                  <Input type={r.field.secret ? "password" : "text"} autoComplete="off" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder={r.saved ? `Saved (${r.saved}); type to replace` : r.field.placeholder} />
                </Field>
              ) : (
                <div key={i} className="flex gap-2">
                  <Input className="font-mono w-2/5" value={r.key} onChange={(e) => setRow(i, { key: e.target.value.replace(/[^A-Za-z0-9_]/g, "_") })} placeholder="NAME" aria-label="Variable name" />
                  <Input className="font-mono flex-1" type="password" autoComplete="off" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder={r.saved ? `Saved (${r.saved})` : "value"} aria-label="Value" />
                  <Button type="button" variant="ghost" className="px-2" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    <Trash2 size={15} />
                  </Button>
                </div>
              ),
            )}
            {(custom || existing) && (
              <Button type="button" variant="ghost" className="h-8 text-xs" onClick={() => setRows([...rows, { key: "", value: "" }])}>
                <Plus size={14} /> Add a value
              </Button>
            )}
            {kind !== "secret" && <p className="text-xs text-muted">Secrets are masked once saved. Use {"{{NAME}}"} in the command, arguments, URL or headers to fill one in.</p>}
          </div>
        )}

        {kind !== "secret" && !showAdvanced && (
          <button type="button" className="text-xs text-muted hover:text-ink underline" onClick={() => setShowAdvanced(true)}>
            Show how it starts
          </button>
        )}
        {kind !== "secret" && showAdvanced && (
          <div className={cx("space-y-3", !custom && "rounded-lg border border-line p-3")}>
            {kind === "mcp-stdio" ? (
              <>
                <Field label="Command" hint="Runs on the agent's device (or inside its VM).">
                  <Input className="font-mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" required readOnly={!custom && !existing} />
                </Field>
                <Field label="Arguments" hint="One per line.">
                  <Textarea className="font-mono" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"-y\n@scope/mcp-server"} readOnly={!custom && !existing} />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL" hint="Streamable HTTP; URLs ending in /sse use SSE.">
                  <Input className="font-mono" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" required readOnly={!custom && !existing} />
                </Field>
                <Field label="Headers" hint="One per line, as Name: value.">
                  <Textarea className="font-mono" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Authorization: Bearer {{API_KEY}}" readOnly={!custom && !existing} />
                </Field>
              </>
            )}
          </div>
        )}

        <Group label="Which agents get it">
          <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} note={agentNote(kind, command, devices)} unavailable={(a) => !harnessSupportsConnectors(a.harness, kind)} />
        </Group>
        <Advanced hide>
          <p className="text-xs text-muted">{worksWith(kind)}</p>
        </Advanced>
        {cantStart.map((w) => (
          <p key={w} role="alert" className="text-sm text-warn rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">
            {w} You can still connect it; it starts working once the command is there.
          </p>
        ))}

        {summary && <BeforeYouConnect s={summary} />}
        {error && <p className="text-sm text-bad">{error}</p>}
        {blocked && (
          <p role="status" className="text-sm text-warn">
            {CONNECTOR_HELP}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim() || nameTaken || missing.length > 0 || blocked} title={blocked ? CONNECTOR_HELP : missing.length ? `Needs: ${missing.join(", ")}` : undefined}>
            {existing ? "Save" : kind === "mcp-http" && !rows.length ? "Connect and sign in" : "Connect"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}


/** Who stands behind a registry listing: icon + short text, with the full explanation on hover and for screen readers. */
function TrustBadge({ t }: { t: TrustLabel }) {
  const Icon = t.kind === "unverified" ? ShieldQuestion : BadgeCheck;
  return (
    <span title={t.explanation} aria-label={`${t.text}. ${t.explanation}`} className={cx("mt-0.5 inline-flex items-center gap-1 text-[11px]", t.kind === "unverified" ? "text-muted" : "text-accent-text")}>
      <Icon size={12} className="shrink-0" aria-hidden />
      {t.text}
    </span>
  );
}

/** A registry server's logo, or its first letter. */
function MarketIcon({ e }: { e: MarketplaceEntry }) {
  const [broken, setBroken] = useState(false);
  return (
    <IconTile className="overflow-hidden">
      {e.icon && !broken ? <img src={e.icon} alt="" className="size-6 object-contain" onError={() => setBroken(true)} /> : <span className="text-sm font-semibold">{e.name.charAt(0).toUpperCase()}</span>}
    </IconTile>
  );
}

const installLabel = (i: MarketplaceInstall) => (i.kind === "mcp-http" ? (i.fields.length ? "Remote · needs a key" : "Remote · sign in") : `${i.label} · runs on the device`);

function MarketCard({ e, added, canEdit, onAdd }: { e: MarketplaceEntry; added: boolean; canEdit: boolean; onAdd: () => void }) {
  const link = e.website ?? e.repository;
  return (
    <div className="rounded-xl border border-line bg-panel p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <MarketIcon e={e} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate flex items-center gap-1">
            {e.name}
          </div>
          <div className="text-[11px] text-muted truncate">Published by {e.publisher}</div>
          <TrustBadge t={trustLabel(e)} />
        </div>
        {added && <Pill tone="ok">Added</Pill>}
      </div>
      <p className="text-sm text-muted flex-1 line-clamp-3">{e.description || "No description."}</p>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted truncate">{installLabel(e.installs[0])}</span>
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-ink inline-flex items-center gap-1 shrink-0">
            <ExternalLink size={11} />
          </a>
        )}
        <span className="flex-1" />
        {canEdit && (
          <Button className="h-8" onClick={onAdd}>
            <Plus size={14} /> Add
          </Button>
        )}
      </div>
    </div>
  );
}

/** Adding a marketplace server: pick how (remote, npm, Docker…) when there's a choice, then the usual form. */
function MarketAdd({ entry, agents, taken, onClose, onSaved }: { entry: MarketplaceEntry; agents: Agent[]; taken: string[]; onClose: () => void; onSaved: (c?: Connector) => void }) {
  const [i, setI] = useState(0);
  const install = entry.installs[i];
  const trust = trustLabel(entry);
  const asCatalog: CatalogConnector = {
    id: `registry:${entry.id}`,
    name: entry.name,
    description: entry.description,
    icon: "Plug",
    category: "Utilities",
    kind: install.kind,
    command: install.command,
    args: install.args,
    url: install.url,
    headers: install.headers,
    fields: install.fields,
    needs: install.needs,
    docs: entry.website ?? entry.repository ?? undefined,
  };
  const top = (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-lg bg-bg p-3">
        <MarketIcon e={entry} />
        <div className="text-sm text-muted min-w-0">
          <div className="text-ink font-medium flex items-center gap-1">
            {entry.name}
          </div>
          <div className="text-xs">Published by {entry.publisher}</div>
          <TrustBadge t={trust} />
          {entry.description}
          {install.kind === "mcp-http" && !install.fields.length && <div className="mt-1 text-xs">If it asks you to sign in, Warren takes you to its sign-in page next. Agents never see your password.</div>}
          {install.needs && <div className="mt-1 text-xs">Needs: {install.needs}.</div>}
          {trust.kind === "unverified" && <div className="mt-1 text-xs">{trust.explanation}</div>}
        </div>
      </div>
      {entry.installs.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {entry.installs.map((x, j) => (
            <button type="button" key={j} onClick={() => setI(j)} className={cx("h-7 px-2.5 rounded-full text-xs border", i === j ? "bg-accent text-accent-ink border-transparent" : "border-line text-muted hover:text-ink hover:bg-hover")}>
              {x.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  return <ConnectorForm key={i} entry={asCatalog} agents={agents} taken={taken} onClose={onClose} onSaved={onSaved} top={top} title={`Add ${entry.name}`} summary={connectSummary({ entry, install })} />;
}
