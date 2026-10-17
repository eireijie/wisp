import { useEffect, useMemo, useState } from "react";
import { ExternalLink, KeyRound, MoreHorizontal, Pencil, Plug, Plus, Server, Trash2 } from "lucide-react";
import { CONNECTOR_CATALOG, catalogConnector, harnessInfo, isMasked, type Agent, type CatalogConnector, type CatalogField, type Connector, type ConnectorKind } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { Button, Field, Input, Loader, Menu, Modal, Pill, Textarea, cx } from "../components/ui.tsx";
import { AgentPicker, AgentStack, Group, CatalogIcon, IconTile, SearchBox, ShopHeader } from "../components/ShopParts.tsx";
import { useDevices, type DeviceInfo } from "../devices.ts";

const KIND_LABEL: Record<ConnectorKind, string> = { "mcp-stdio": "MCP · runs on the device", "mcp-http": "MCP · remote", secret: "Key" };

/** Which harnesses a kind of connector reaches today, in words. */
function worksWith(kind: ConnectorKind): string {
  if (kind === "mcp-http") return "Works with Claude Code and Codex. Not wired yet for ACP agents (Gemini, OpenCode, Hermes…).";
  if (kind === "mcp-stdio") return "Works with Claude Code, Codex, and ACP agents (Gemini, OpenCode, Hermes, Cursor…).";
  return "Set in the environment of every agent Warren runs: Claude Code, Codex and ACP agents.";
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

/** Why a connector won't reach this agent, if it won't. */
function agentNote(kind: ConnectorKind, command: string, devices: DeviceInfo[] | null) {
  return (a: Agent) => {
    const h = harnessInfo(a.harness);
    const protocol = h?.protocol ?? (a.harness.startsWith("acp:") ? "acp" : "mcp");
    if (protocol === "mcp") return "joins through warren-mcp; add it there";
    if (protocol === "acp" && kind === "mcp-http") return "not wired yet for this harness";
    const device = kind === "mcp-stdio" ? missingOn(a, command, devices) : null;
    if (device) return `${device.name} doesn't have ${command.trim().split(/\s+/)[0]}`;
    return null;
  };
}

const CATEGORIES = ["All", ...new Set(CONNECTOR_CATALOG.map((c) => c.category))];

/**
 * Connectors: MCP servers agents can call (on their device, or remote) and keys they need for
 * services. A catalog of popular ones, ready to fill in; and your own.
 */
export function ConnectorsView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const canEdit = me.role !== "guest";
  const [list, setList] = useState<Connector[] | null>(null);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("All");
  const [form, setForm] = useState<{ entry?: CatalogConnector; existing?: Connector } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api<Connector[]>("GET", "/api/connectors").then(setList, (e) => (setList([]), setError(e.message)));
  useEffect(() => {
    load();
  }, []);

  const needle = q.trim().toLowerCase();
  const match = (...s: (string | null | undefined)[]) => !needle || s.some((x) => x?.toLowerCase().includes(needle));
  const connected = (list ?? []).filter((c) => match(c.name, c.url, c.command, catalogConnector(c.catalogId ?? "")?.description));
  const catalog = CONNECTOR_CATALOG.filter((c) => (category === "All" || c.category === category) && match(c.name, c.description, c.category));
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
        title="Connectors"
        onBack={onBack}
        action={
          canEdit && (
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
            <p className="text-sm text-muted flex-1">Give agents tools and keys: MCP servers they can call, and API keys for the services they work with. You pick which agents get each.</p>
            <SearchBox value={q} onChange={setQ} placeholder="Search connectors" />
          </div>
          {error && <p className="text-sm text-bad">{error}</p>}
          {!canEdit && <p className="text-xs text-muted">Guests can look around; members add and change connectors.</p>}

          <section aria-labelledby="connected-h">
            <h2 id="connected-h" className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">
              Connected {list && <span className="text-faint tabular-nums">{list.length}</span>}
            </h2>
            {list === null ? (
              <Loader />
            ) : list.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">Nothing connected yet. Pick one from the catalog below, or add your own.</div>
            ) : connected.length === 0 ? (
              <p className="text-sm text-muted">No connected ones match "{q}".</p>
            ) : (
              <div className="rounded-xl border border-line divide-y divide-line bg-panel">
                {connected.map((c) => (
                  <ConnectedRow key={c.id} c={c} agents={agents} canEdit={canEdit} onEdit={() => setForm({ existing: c, entry: catalogConnector(c.catalogId ?? "") })} onToggle={() => act(api("PATCH", `/api/connectors/${c.id}`, { enabled: !c.enabled }))} onRemove={() => confirm(`Remove ${c.name}? Agents lose it on their next run.`) && act(api("DELETE", `/api/connectors/${c.id}`))} />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="catalog-h">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
              <h2 id="catalog-h" className="text-xs font-semibold uppercase tracking-wider text-muted flex-1">
                Catalog
              </h2>
              <div className="flex gap-1 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 pb-1 sm:pb-0">
                {CATEGORIES.map((cat) => (
                  <button key={cat} onClick={() => setCategory(cat)} className={cx("h-7 px-2.5 rounded-full text-xs whitespace-nowrap border", category === cat ? "bg-accent text-accent-ink border-transparent" : "border-line text-muted hover:text-ink hover:bg-hover")}>
                    {cat}
                  </button>
                ))}
              </div>
            </div>
            {catalog.length === 0 ? (
              <p className="text-sm text-muted py-6 text-center">Nothing in the catalog matches. You can still add your own.</p>
            ) : (
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {catalog.map((c) => (
                  <div key={c.id} className="rounded-xl border border-line bg-panel p-4 flex flex-col gap-3">
                    <div className="flex items-start gap-3">
                      <IconTile>
                        <CatalogIcon name={c.icon} />
                      </IconTile>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold truncate">{c.name}</div>
                        <div className="text-[11px] text-muted">{KIND_LABEL[c.kind]}</div>
                      </div>
                      {countFor(c.id) > 0 && <Pill tone="ok">Added</Pill>}
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
                        <Button className="h-8" onClick={() => setForm({ entry: c })}>
                          <Plus size={14} /> Add
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
      {form && (
        <ConnectorForm
          entry={form.entry}
          existing={form.existing}
          agents={agents}
          taken={(list ?? []).filter((c) => c.id !== form.existing?.id).map((c) => c.name.toLowerCase())}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function ConnectedRow({ c, agents, canEdit, onEdit, onToggle, onRemove }: { c: Connector; agents: Agent[]; canEdit: boolean; onEdit: () => void; onToggle: () => void; onRemove: () => void }) {
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
        </div>
        <div className="text-xs text-muted font-mono truncate mt-0.5" title={where ?? ""}>
          {where}
        </div>
      </div>
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
function ConnectorForm({ entry, existing, agents, taken, onClose, onSaved }: { entry?: CatalogConnector; existing?: Connector; agents: Agent[]; taken: string[]; onClose: () => void; onSaved: () => void }) {
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
  const [agentIds, setAgentIds] = useState<string[]>(existing?.agentIds ?? (agents.length === 1 ? [agents[0].id] : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const custom = !entry;
  const [showAdvanced, setShowAdvanced] = useState(custom);
  const devices = useDevices(10_000);

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
      if (existing) await api("PATCH", `/api/connectors/${existing.id}`, body);
      else await api("POST", "/api/connectors", { ...body, kind, catalogId: entry?.id ?? null });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const title = existing ? `Edit ${existing.name}` : entry ? `Add ${entry.name}` : "Add your own connector";

  return (
    <Modal title={title} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {entry && (
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
          <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} note={agentNote(kind, command, devices)} />
        </Group>
        <p className="text-xs text-muted">{worksWith(kind)}</p>
        {cantStart.map((w) => (
          <p key={w} role="alert" className="text-sm text-warn rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">
            {w} You can still connect it; it starts working once the command is there.
          </p>
        ))}

        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim() || nameTaken || missing.length > 0} title={missing.length ? `Needs: ${missing.join(", ")}` : undefined}>
            {existing ? "Save" : "Connect"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

