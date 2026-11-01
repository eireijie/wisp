import { useEffect, useState, type ReactNode } from "react";
import { Plug, Plus, ShieldCheck, TriangleAlert, Trash2 } from "lucide-react";
import { CONNECTOR_HELP, connectorUnsupportedReason, harnessSupportsConnectors, isMasked, trustLabel, type Agent, type CatalogConnector, type CatalogField, type Connector, type ConnectorKind, type MarketplaceEntry, type MarketplaceInstall } from "@wisp/core";
import { api } from "../api.ts";
import { MoreOptions } from "../components/MoreOptions.tsx";
import { AreaBox, Circle, Dlg, Item, Label, Labeled, Panel, Prim, Sec, Seg, TextBox, Tile } from "../components/MarketParts.tsx";
import { AgentPicker } from "../components/ShopParts.tsx";
import { useDevices, type DeviceInfo } from "../devices.ts";


/** Which harnesses a kind of connector reaches today, in words. */
function worksWith(kind: ConnectorKind): string {
  if (kind === "mcp-http") return "Works with Claude Code and Codex. Not wired yet for ACP agents (Gemini, OpenCode, Hermes…).";
  if (kind === "mcp-stdio") return "Works with Claude Code, Codex, and ACP agents (Gemini, OpenCode, Hermes, Cursor…).";
  return "Set in the environment of every agent Wisp runs: Claude Code, Codex and ACP agents.";
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
          ? "Wisp keeps the key and gives it only to the helpers you pick."
          : c.kind === "mcp-http"
            ? `On Wisp's list of well-known apps. It connects to ${host ?? "the app's own address"}, not to a server run by Wisp.`
            : "On Wisp's list of well-known apps. It runs as a program on the helper's own computer.",
      caution: null,
    };
  }
  const { entry, install } = src;
  const trust = trustLabel(entry);
  const name = entry.name;
  const who = entry.domain ? `${entry.publisher} (${entry.domain})` : entry.publisher;
  const can = install.fields.length ? `Your helpers get the key you enter, so they can use ${name} with it.` : `Your helpers will be able to use ${name} through this connection: read and act on what this app allows.`;
  if (trust.kind === "unverified") {
    return { can, runBy: `Run by ${entry.publisher}, not by the app's maker or Wisp.`, caution: "Nobody has confirmed who they are. Only connect if you trust them." };
  }
  if (trust.kind === "maker") {
    return { can, runBy: `Made and run by ${trust.text.replace(/^Made by /, "")} (${entry.domain ?? entry.publisher}), not by Wisp.`, caution: null };
  }
  return { can, runBy: `Run by ${who}, not by Wisp. The registry confirmed who they are; that doesn't mean ${name}'s own maker endorses it.`, caution: null };
}

/** "Before you connect": the summary as a card of rows. */
export function BeforeYouConnect({ s }: { s: ConnectSummary }) {
  return (
    <section aria-label="Before you connect" className="space-y-2">
      <Label>Before you connect</Label>
      <Panel>
        <Item icon={<Tile size={40}><Plug size={20} strokeWidth={1.7} /></Tile>} title="What helpers can do" sub={<span className="whitespace-normal">{s.can}</span>} />
        <Item icon={<Tile size={40}><ShieldCheck size={20} strokeWidth={1.7} /></Tile>} title="Who runs it" sub={<span className="whitespace-normal">{s.runBy}</span>} />
        {s.caution && <Item icon={<Tile size={40}><TriangleAlert size={20} strokeWidth={1.7} className="text-warn" /></Tile>} title="Take care" sub={<span className="whitespace-normal text-warn">{s.caution}</span>} />}
      </Panel>
    </section>
  );
}

/** A registry server in one of its install options, as something the form can fill in. */
export function registryCatalog(entry: MarketplaceEntry, install: MarketplaceInstall): CatalogConnector {
  return {
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

/**
 * True when agents would get this connector but none of them could use it. "All agents" means every
 * agent; otherwise only the ones checked (none checked means nobody yet, which is allowed).
 */
export function connectBlocked(agents: Pick<Agent, "id" | "harness">[], agentIds: string[], kind: ConnectorKind, allAgents = false): boolean {
  const chosen = allAgents ? agents : agents.filter((a) => agentIds.includes(a.id));
  if (!chosen.length) return false;
  return !chosen.some((a) => harnessSupportsConnectors(a.harness, kind));
}

/** What an installed app is reachable at, in a few words (its address, its command, or the names of its keys). */
export function connectorWhere(c: Connector): string {
  return c.kind === "mcp-stdio" ? [c.command, ...c.args].join(" ") : c.kind === "mcp-http" ? (c.url ?? "") : Object.keys(c.env).join(", ");
}

type Row = { key: string; value: string; saved?: string; field?: CatalogField };

/**
 * Add your own app, set one up from the catalog, or edit one ("Connect any MCP server"). Asks for
 * the values it needs and which agents get it.
 */
export function ConnectorForm({ entry, existing, agents, taken, onClose, onSaved, top, title: titleOverride, summary, presetEnv, presetAgents }: { entry?: CatalogConnector; existing?: Connector; agents: Agent[]; taken: string[]; onClose: () => void; onSaved: (c?: Connector) => void; top?: ReactNode; title?: string; summary?: ConnectSummary; presetEnv?: Record<string, string>; presetAgents?: string[] }) {
  const [kind, setKind] = useState<ConnectorKind>(existing?.kind ?? entry?.kind ?? "mcp-http");
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
    // values brought over as they were (from a harness on a device), editable here
    const preset = Object.entries(presetEnv ?? {}).filter(([k]) => !fromFields.some((r) => r.key === k)).map(([k, v]) => ({ key: k, value: v }));
    const all = [...fromFields, ...extra, ...preset];
    return all.length || entry ? all : [{ key: "", value: "" }];
  });
  const [agentIds, setAgentIds] = useState<string[]>(existing?.agentIds ?? presetAgents ?? (agents.length === 1 && harnessSupportsConnectors(agents[0].harness, existing?.kind ?? entry?.kind ?? "mcp-stdio") ? [agents[0].id] : []));
  const [allAgents, setAllAgents] = useState(existing?.allAgents ?? false);
  // a different kind (custom form) can rule out agents that were ticked
  useEffect(() => {
    if (existing) return;
    setAgentIds((ids) => {
      const keep = ids.filter((id) => {
        const a = agents.find((x) => x.id === id);
        return !a || harnessSupportsConnectors(a.harness, kind);
      });
      return keep.length === ids.length ? ids : keep;
    });
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const custom = !entry;
  const [showAdvanced, setShowAdvanced] = useState(custom);
  const devices = useDevices(10_000);

  const blocked = !existing && connectBlocked(agents, agentIds, kind, allAgents);
  const nameTaken = taken.includes(name.trim().toLowerCase());
  const missing = rows.filter((r) => r.field && !r.field.optional && !r.value.trim() && !r.saved).map((r) => r.field!.label);
  // asked of each chosen agent's device before connecting, so a connector that can't start is caught here, not in a failed run
  const cantStart =
    kind === "mcp-stdio"
      ? (allAgents ? agents.map((a) => a.id) : agentIds).flatMap((id) => {
          const a = agents.find((x) => x.id === id);
          const d = a && missingOn(a, command, devices);
          return a && d ? [`${a.name}'s device ${d.name} doesn't have "${command.trim().split(/\s+/)[0]}". ${entry?.needs ? `Needs: ${entry.needs}.` : "Install it there first."}`] : [];
        })
      : [];

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
    const body: Record<string, unknown> = { name: name.trim(), env, agentIds, allAgents };
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
  const title = titleOverride ?? (existing ? `Edit ${existing.name}` : entry ? `Connect ${entry.name}` : "Add your own app");
  const sub = custom && !existing ? "Connect any MCP server" : undefined;
  const saveLabel = existing ? "Save" : custom ? "Save app" : "Connect";

  return (
    <Dlg title={title} sub={sub} onClose={onClose} wide>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {top}

        {custom && !existing && (
          <Seg
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              ["mcp-http", "URL"],
              ["mcp-stdio", "Command"],
              ["secret", "Key"],
            ]}
          />
        )}

        <Labeled label="Name" hint={nameTaken ? <span className="text-bad">You already have an app with this name.</span> : "Agents see its tools under this name."}>
          {(id) => <TextBox id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />}
        </Labeled>

        {kind !== "secret" && !showAdvanced && (
          <button type="button" className="px-1 text-[13px] text-muted underline hover:text-ink" onClick={() => setShowAdvanced(true)}>
            Show how it starts
          </button>
        )}
        {kind !== "secret" && showAdvanced && (
          <div className="space-y-4">
            {kind === "mcp-stdio" ? (
              <>
                <Labeled label="Command">
                  {(id) => <TextBox id={id} className="font-mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" required readOnly={!custom && !existing} />}
                </Labeled>
                <Labeled label="Arguments" hint="One per line.">
                  {(id) => <AreaBox id={id} className="font-mono" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"-y\n@scope/mcp-server"} readOnly={!custom && !existing} />}
                </Labeled>
              </>
            ) : (
              <>
                <Labeled label="URL">
                  {(id) => <TextBox id={id} className="font-mono" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" required readOnly={!custom && !existing} />}
                </Labeled>
                <Labeled label="Headers" hint="One per line, as Name: value.">
                  {(id) => <AreaBox id={id} className="font-mono" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Authorization: Bearer {{API_KEY}}" readOnly={!custom && !existing} />}
                </Labeled>
              </>
            )}
          </div>
        )}

        {(rows.length > 0 || kind === "secret" || custom) && (
          <div className="space-y-3">
            <Label>{kind === "secret" ? "Values" : entry?.fields.length ? "What it needs" : "Variables"}</Label>
            {rows.map((r, i) =>
              r.field ? (
                <Labeled
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
                  {(id) => <TextBox id={id} type={r.field!.secret ? "password" : "text"} autoComplete="off" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder={r.saved ? `Saved (${r.saved}); type to replace` : r.field!.placeholder} />}
                </Labeled>
              ) : (
                <div key={i} className="flex items-center gap-2">
                  <TextBox className="w-2/5 font-mono" value={r.key} onChange={(e) => setRow(i, { key: e.target.value.replace(/[^A-Za-z0-9_]/g, "_") })} placeholder="NAME" aria-label="Variable name" />
                  <TextBox className="flex-1 font-mono" type="password" autoComplete="off" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder={r.saved ? `Saved (${r.saved})` : "••••••••"} aria-label="Value" />
                  <Circle label="Remove" className="circle-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    <Trash2 size={15} />
                  </Circle>
                </div>
              ),
            )}
            {(custom || existing) && (
              <button type="button" className="inline-flex items-center gap-1.5 px-1 text-sm text-muted hover:text-ink" onClick={() => setRows([...rows, { key: "", value: "" }])}>
                <Plus size={14} /> Add a value
              </button>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Label>Which helpers get it</Label>
          <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} note={agentNote(kind, command, devices)} unavailable={(a) => !harnessSupportsConnectors(a.harness, kind)} allAgents={{ on: allAgents, onChange: setAllAgents }} />
        </div>
        <MoreOptions about="what it works with">
          <p className="text-xs text-muted">{worksWith(kind)}</p>
        </MoreOptions>
        {cantStart.map((w) => (
          <p key={w} role="alert" className="rounded-2xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
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
          <Sec onClick={onClose}>Cancel</Sec>
          <Prim type="submit" className="h-11 text-body" disabled={busy || !name.trim() || nameTaken || missing.length > 0 || blocked} title={blocked ? CONNECTOR_HELP : missing.length ? `Needs: ${missing.join(", ")}` : undefined}>
            {saveLabel}
          </Prim>
        </div>
      </form>
    </Dlg>
  );
}


