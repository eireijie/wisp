import { useEffect, useState, type ReactNode } from "react";
import { BadgeCheck, KeyRound, LogIn, LogOut, MoreHorizontal, Pencil, Plug, Plus, ShieldQuestion, Trash2 } from "lucide-react";
import { CONNECTOR_CATALOG, CONNECTOR_HELP, catalogConnector, connectorUnsupportedReason, entryLogos, harnessSupportsConnectors, isMasked, logoUrl, type Agent, type CatalogConnector, type CatalogField, type Connector, type ConnectorKind, trustLabel, type MarketplaceEntry, type MarketplaceInstall, type TrustLabel } from "@wisp/core";
import { api } from "../api.ts";
import { Button, Field, Input, Menu, Modal, Pill, Textarea, cx } from "../components/ui.tsx";
import { AgentPicker, AgentStack, AppLogo, Group, IconTile } from "../components/ShopParts.tsx";
import { useDevices, type DeviceInfo } from "../devices.ts";
import { Advanced } from "../experience.tsx";

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

export function ConnectedRow({ c, agents, canEdit, onEdit, onToggle, onRemove, onSignIn, onSignOut }: { c: Connector; agents: Agent[]; canEdit: boolean; onEdit: () => void; onToggle: () => void; onRemove: () => void; onSignIn: () => void; onSignOut: () => void }) {
  const entry = catalogConnector(c.catalogId ?? "");
  const where = c.kind === "mcp-stdio" ? [c.command, ...c.args].join(" ") : c.kind === "mcp-http" ? c.url : Object.keys(c.env).join(", ");
  return (
    <div className={cx("flex items-center gap-3 px-3 sm:px-4 py-3", !c.enabled && "opacity-60")}>
      {c.kind === "secret" ? (
        <IconTile>
          <KeyRound size={18} />
        </IconTile>
      ) : (
        <AppLogo srcs={[logoUrl([c.name, entry?.name])]} size={40} />
      )}
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
export function ConnectorForm({ entry, existing, agents, taken, onClose, onSaved, top, title: titleOverride, summary: summaryProp, presetEnv, presetAgents }: { entry?: CatalogConnector; existing?: Connector; agents: Agent[]; taken: string[]; onClose: () => void; onSaved: (c?: Connector) => void; top?: ReactNode; title?: string; summary?: ConnectSummary; presetEnv?: Record<string, string>; presetAgents?: string[] }) {
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
    // values brought over as they were (from a harness on a device), editable here
    const preset = Object.entries(presetEnv ?? {}).filter(([k]) => !fromFields.some((r) => r.key === k)).map(([k, v]) => ({ key: k, value: v }));
    const all = [...fromFields, ...extra, ...preset];
    return all.length || entry ? all : [{ key: "", value: "" }];
  });
  const [agentIds, setAgentIds] = useState<string[]>(existing?.agentIds ?? presetAgents ?? (agents.length === 1 && harnessSupportsConnectors(agents[0].harness, existing?.kind ?? entry?.kind ?? "mcp-stdio") ? [agents[0].id] : []));
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
            <AppLogo srcs={[logoUrl([entry.name])]} size={40} />
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

/** Adding a marketplace server: pick how (remote, npm, Docker…) when there's a choice, then the usual form. */
export function MarketAdd({ entry, agents, taken, onClose, onSaved }: { entry: MarketplaceEntry & { logos?: string[] }; agents: Agent[]; taken: string[]; onClose: () => void; onSaved: (c?: Connector) => void }) {
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
        <AppLogo srcs={entry.logos ?? entryLogos(entry)} size={44} />
        <div className="text-sm text-muted min-w-0">
          <div className="text-ink font-medium flex items-center gap-1">
            {entry.name}
          </div>
          <div className="text-xs">Published by {entry.publisher}</div>
          <TrustBadge t={trust} />
          <div className="mt-1">{entry.description}</div>
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
