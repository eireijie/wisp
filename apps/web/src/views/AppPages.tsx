import { useState, type ReactNode } from "react";
import { ExternalLink, LogIn, LogOut, MessageSquare, Pencil, Power, RefreshCw, Trash2, Users } from "lucide-react";
import { trustLabel, type Agent, type AppCategory, type CatalogConnector, type Connector, type ConnectorKind, type MarketplaceInstall, type StoreApp } from "@wisp/core";
import { api } from "../api.ts";
import { AgentAvatar } from "../components/ui.tsx";
import { AppTile, Badge, Chip, Dlg, Item, Label, Note, Panel, Prim, Sec, Switch, Tile, TrustPill } from "../components/MarketParts.tsx";
import { BeforeYouConnect, connectSummary, connectorWhere, registryCatalog } from "./ConnectorsView.tsx";

export type AppItem = { key: string; name: string; description: string; category: AppCategory | null; who: string } & ({ registry: StoreApp } | { builtIn: CatalogConnector });

/** How signing in or setting up works for this kind of app, in a sentence. */
export function howToConnect(name: string, kind: ConnectorKind, fieldLabels: string[], needs?: string): string {
  if (kind === "secret" || fieldLabels.length)
    return `You enter ${fieldLabels.length ? fieldLabels.join(", ") : "the key"} once. Wisp keeps ${fieldLabels.length > 1 ? "them" : "it"} and gives ${fieldLabels.length > 1 ? "them" : "it"} only to the helpers you pick.`;
  if (kind === "mcp-stdio") return `${name} runs as a program on each helper's own computer.${needs ? ` It needs ${needs}.` : ""} After that you choose which helpers can use it.`;
  return `If ${name} asks you to sign in, a page opens in your browser. Wisp never sees your password. After that you choose which helpers can use ${name}.`;
}

/** An app's page: who stands behind it, what you're agreeing to, and how connecting works. */
export function AppDetail({ app, have, canEdit, onConnect, onManage }: { app: AppItem; have: Connector | undefined; canEdit: boolean; onConnect: (install: number) => void; onManage: (c: Connector) => void }) {
  const [pick, setPick] = useState(0);
  const registry = "registry" in app ? app.registry : null;
  const install: MarketplaceInstall | null = registry ? (registry.installs[pick] ?? registry.installs[0] ?? null) : null;
  const entry = "builtIn" in app ? app.builtIn : registry && install ? registryCatalog(registry, install) : null;
  const summary = "builtIn" in app ? connectSummary({ builtIn: app.builtIn }) : registry && install ? connectSummary({ entry: registry, install }) : null;
  const trust = registry ? trustLabel(registry) : null;
  const link = registry?.website ?? registry?.repository ?? ("builtIn" in app ? app.builtIn.docs : undefined);
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <AppTile name={app.name} category={app.category} size={56} entry={registry} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <h2 className="t-title">{app.name}</h2>
          <div className="flex flex-wrap items-center gap-2">
            {trust ? <TrustPill t={trust} /> : <Badge tone="blue" title="On Wisp's list of well-known apps">On Wisp's list</Badge>}
            {registry && <span className="text-sm text-faint">by {registry.publisher}</span>}
          </div>
        </div>
        {canEdit &&
          (have ? (
            <Sec onClick={() => onManage(have)}>Manage</Sec>
          ) : (
            <Prim onClick={() => onConnect(pick)} disabled={!entry} className="max-sm:hidden">
              Connect
            </Prim>
          ))}
      </header>

      <p className="px-1 text-body leading-relaxed text-ink/90">{app.description || `Lets your helpers use ${app.name}.`}</p>

      {registry && registry.installs.length > 1 && (
        <section className="space-y-2">
          <Label>Ways to connect</Label>
          <div className="flex flex-wrap gap-2">
            {registry.installs.map((x, j) => (
              <Chip key={j} on={pick === j} onClick={() => setPick(j)}>
                {x.label}
              </Chip>
            ))}
          </div>
        </section>
      )}

      {summary && <BeforeYouConnect s={summary} />}

      {entry && (
        <section className="space-y-2">
          <Label>How to connect</Label>
          <Note>{howToConnect(app.name, entry.kind, entry.fields.map((f) => f.label), entry.needs)}</Note>
        </section>
      )}

      {link && (
        <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-1 text-sm text-muted hover:text-ink">
          {registry?.website ? "Website" : "More about it"} <ExternalLink size={13} />
        </a>
      )}

      {canEdit && !have && (
        <Prim onClick={() => onConnect(pick)} disabled={!entry} className="w-full sm:hidden">
          Connect
        </Prim>
      )}
    </div>
  );
}

/** After saving an app that asks for a sign-in: the page opens in the browser, Wisp never sees the password. */
export function ConnectSignIn({ connector, onClose, onSignIn }: { connector: Connector; onClose: () => void; onSignIn: () => void }) {
  return (
    <Dlg title={`Connect ${connector.name}`} onClose={onClose}>
      <Panel>
        <Item icon={<AppTile name={connector.name} size={50} />} title={`Sign in to ${connector.name}`} sub={<span className="whitespace-normal">A page opens in your browser. Choose the account and allow Wisp to use {connector.name} for your helpers.</span>} />
      </Panel>
      <div className="flex flex-wrap justify-end gap-2">
        <Sec onClick={onClose}>Not now</Sec>
        <Prim onClick={onSignIn} className="max-sm:w-full">
          <LogIn size={17} /> Open sign-in
        </Prim>
      </div>
    </Dlg>
  );
}

/** The connected state: who can use it now, and a way to try it. */
export function Connected({ connector, agents, onClose, onPick, onTry }: { connector: Connector; agents: Agent[]; onClose: () => void; onPick: () => void; onTry: () => void }) {
  const names = connector.agentIds.map((id) => agents.find((a) => a.id === id)?.name).filter((n): n is string => !!n);
  return (
    <Dlg title={`${connector.name} is connected`} sub={names.length ? `${sentence(names)} can use it now.` : "No helper can use it yet."} onClose={onClose}>
      <Panel>
        <Item icon={<Tile size={40}><Users size={20} strokeWidth={1.7} /></Tile>} title="Pick who can use it" sub={names.length ? names.join(", ") : "No one yet"} onClick={onPick} />
        {names.length > 0 && <Item icon={<Tile size={40}><MessageSquare size={20} strokeWidth={1.7} /></Tile>} title="Try it in a chat" sub={`Ask ${names[0]} to use ${connector.name}`} onClick={onTry} />}
      </Panel>
      <div className="flex justify-end">
        <Prim onClick={onClose} className="max-sm:w-full">
          Done
        </Prim>
      </div>
    </Dlg>
  );
}

const sentence = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** Manage a connected app: status, which helpers use it, and its account (refresh, sign out, remove). */
export function ManageApp({ connector: c, agents, canEdit, onClose, onChanged, onEdit, onSignIn, onSignOut, onToggle, onRemove }: { connector: Connector; agents: Agent[]; canEdit: boolean; onClose: () => void; onChanged: () => void; onEdit: () => void; onSignIn: () => void; onSignOut: () => void; onToggle: () => void; onRemove: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsSignIn = !!c.auth?.required && !c.auth.signedIn;
  const status = !c.enabled ? "Off" : needsSignIn ? "Needs sign-in" : c.auth?.signedIn ? "Connected" : "Connected";
  const toggle = async (a: Agent, on: boolean) => {
    setBusy(a.id);
    setError(null);
    try {
      await api(on ? "PUT" : "DELETE", `/api/connectors/${c.id}/agents/${a.id}`);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const row = (icon: ReactNode, title: string, sub: string, onClick: () => void, danger?: boolean) => <Item icon={<Tile size={40}>{icon}</Tile>} title={title} sub={sub} onClick={onClick} danger={danger} />;
  return (
    <Dlg title={c.name} onClose={onClose} wide>
      <Panel>
        <Item
          icon={<AppTile name={c.name} size={50} />}
          title={status}
          sub={connectorWhere(c)}
          right={<Badge tone={!c.enabled ? "grey" : needsSignIn ? "warn" : "green"}>{!c.enabled ? "Off" : needsSignIn ? "Sign in" : "On"}</Badge>}
        />
      </Panel>
      {c.auth?.error && <p className="px-1 text-sm text-bad">{c.auth.error}</p>}

      <section className="space-y-2">
        <Label>Helpers who can use it</Label>
        {agents.length === 0 ? (
          <p className="px-1 text-sm text-muted">No helpers yet.</p>
        ) : (
          <Panel>
            {agents.map((a) => (
              <Item key={a.id} icon={<AgentAvatar agent={a} size={30} />} title={a.name} sub={`@${a.handle}`} right={<Switch on={c.agentIds.includes(a.id)} label={a.name} disabled={!canEdit || busy === a.id} onChange={(v) => toggle(a, v)} />} />
            ))}
          </Panel>
        )}
      </section>
      {error && <p className="text-sm text-bad">{error}</p>}

      {canEdit && (
        <section className="space-y-2">
          <Label>Account</Label>
          <Panel>
            {row(<RefreshCw size={20} strokeWidth={1.7} />, "Refresh", "Check the connection", onChanged)}
            {c.kind === "mcp-http" && row(<LogIn size={20} strokeWidth={1.7} />, c.auth?.signedIn ? "Sign in again" : "Sign in", "Opens the app's sign-in page", onSignIn)}
            {c.auth?.signedIn && row(<LogOut size={20} strokeWidth={1.7} />, "Sign out", "Helpers stop using your account", onSignOut)}
            {row(<Pencil size={20} strokeWidth={1.7} />, "Edit settings", "Name, values and how it starts", onEdit)}
            {row(<Power size={20} strokeWidth={1.7} />, c.enabled ? "Turn off" : "Turn on", c.enabled ? "Off for every helper" : "On for the helpers above", onToggle)}
            {row(<Trash2 size={20} strokeWidth={1.7} className="text-bad" />, "Remove", "Helpers will lose access to it.", onRemove, true)}
          </Panel>
        </section>
      )}
      <div className="flex justify-end">
        <Prim onClick={onClose} className="max-sm:w-full">
          Done
        </Prim>
      </div>
    </Dlg>
  );
}

