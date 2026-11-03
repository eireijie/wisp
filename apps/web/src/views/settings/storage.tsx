import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Folder, Plus, Server, X } from "lucide-react";
import { STORAGE_SERVICES, type LoginSummary, type StorageAccess, type StorageConnection, type StorageEntry, type StorageFolder, type StorageService } from "@wisp/core";
import { api } from "../../api.ts";
import { go, useRoute } from "../../router.ts";
import { useStore } from "../../store.ts";
import { AppTile, Dlg, Item, Label, Labeled, Note, Panel, Prim, Sec, Seg, TextBox, Tile } from "../../components/MarketParts.tsx";
import { cx } from "../../components/ui.tsx";
import { OwnersOnly, PageHeader } from "./parts.tsx";

interface StorageView {
  connections: StorageConnection[];
  /** this workspace's own Google / Dropbox app (never its secret) */
  apps: Partial<Record<"gdrive" | "dropbox", { clientId: string }>>;
}

const APP_HELP = {
  gdrive: "https://developers.google.com/workspace/guides/create-credentials#oauth-client-id",
  dropbox: "https://www.dropbox.com/developers/apps",
};

/** A service's real logo, or a plain server for "Other server". */
export function StorageLogo({ service, size = 40 }: { service: StorageService; size?: number }) {
  const s = STORAGE_SERVICES[service];
  return s.logo ? <AppTile name={s.name} size={size} /> : <Tile size={size}><Server size={Math.round(size * 0.5)} strokeWidth={1.7} /></Tile>;
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

/**
 * Settings → Storage (the Storage mod): owners connect Nextcloud, a NAS, Google Drive or
 * Dropbox, and choose which folders agents may use and which agents. Members can look.
 */
export function StoragePage() {
  const route = useRoute();
  const item = route.view === "settings" ? (route.item ?? null) : null;
  const isOwner = useStore((s) => s.me)?.role === "owner";
  const agents = useStore((s) => s.agents);
  const [view, setView] = useState<StorageView | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<StorageView>("GET", "/api/storage").then(setView, (e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    // back from Google or Dropbox: "ok", or why it didn't work
    const back = new URLSearchParams(location.search).get("storage");
    if (back) {
      if (back !== "ok") setError(back);
      history.replaceState(null, "", location.pathname + location.hash);
    }
  }, []);
  const open = (id: string | null) => go({ view: "settings", page: "storage", item: id });

  const conn = item ? view?.connections.find((c) => c.id === item) : undefined;
  if (item && view) {
    if (!conn) return <p className="text-sm text-muted">That storage isn't connected any more.</p>;
    return <ConnectionPage conn={conn} isOwner={isOwner} onBack={() => open(null)} onChange={load} />;
  }

  const who = (c: StorageConnection) => (c.allAgents ? "Every agent" : c.agentIds.length ? c.agentIds.map((id) => `@${agents.find((a) => a.id === id)?.handle ?? "?"}`).join(", ") : "No agents yet");
  return (
    <>
      <div className="mb-6 flex items-center gap-3 max-md:hidden">
        <h2 className="t-title flex-1">Storage</h2>
        {isOwner && (
          <Prim className="h-[38px] gap-1.5 px-4 text-body" onClick={() => setAdding(true)}>
            <Plus size={16} /> Add storage
          </Prim>
        )}
      </div>
      <OwnersOnly show={!isOwner} />
      {error && <p className="mb-4 text-sm text-bad">{error}</p>}
      {view &&
        (view.connections.length || isOwner ? (
          <Panel>
            {view.connections.map((c) => (
              <Item
                key={c.id}
                icon={<StorageLogo service={c.service} />}
                title={c.name}
                sub={c.problem ? <span className="text-warn">{c.problem}</span> : [hostOf(c.url) ?? c.account, `${c.folders.length} ${c.folders.length === 1 ? "folder" : "folders"}`, who(c)].filter(Boolean).join(" · ")}
                right={<ChevronRight size={16} className="text-faint" />}
                onClick={() => open(c.id)}
              />
            ))}
            {!view.connections.length && <p className="px-4 py-4 text-sm text-muted max-md:hidden">Nothing connected yet.</p>}
            {/* phones have no room for the button by the title: adding is the list's last row, like Add folder */}
            {isOwner && (
              <div className="md:hidden">
                <Item icon={<span className="grid size-10 place-items-center"><Plus size={18} /></span>} title="Add storage" onClick={() => setAdding(true)} />
              </div>
            )}
          </Panel>
        ) : (
          <Note>Nothing connected yet.</Note>
        ))}
      {adding && view && (
        <AddStorage
          apps={view.apps}
          onClose={() => setAdding(false)}
          onDone={(c) => {
            setAdding(false);
            void load().then(() => open(c.id));
          }}
        />
      )}
    </>
  );
}

// --- adding ----------------------------------------------------------------------------------

const PICK: StorageService[] = ["nextcloud", "gdrive", "dropbox", "truenas"];

function AddStorage({ apps, onClose, onDone }: { apps: StorageView["apps"]; onClose: () => void; onDone: (c: StorageConnection) => void }) {
  const [service, setService] = useState<StorageService | null>(null);
  const back = () => setService(null);
  if (service === "nextcloud") return <ConnectNextcloud onBack={back} onClose={onClose} onDone={onDone} />;
  if (service === "gdrive" || service === "dropbox") return <ConnectCloud service={service} app={apps[service] ?? null} onBack={back} onClose={onClose} />;
  if (service) return <ConnectServer service={service} onBack={back} onClose={onClose} onDone={onDone} />;
  return (
    <Dlg title="Add storage" onClose={onClose}>
      <div className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
        {PICK.map((s) => (
          <button key={s} type="button" onClick={() => setService(s)} className="flex h-14 items-center gap-3 rounded-xl border border-line px-3.5 text-left hover:bg-hover">
            <StorageLogo service={s} size={32} />
            <span className="text-body font-medium">{STORAGE_SERVICES[s].name}</span>
          </button>
        ))}
        <button type="button" onClick={() => setService("webdav")} className="col-span-2 flex h-14 items-center gap-3 rounded-xl border border-line px-3.5 text-left hover:bg-hover max-sm:col-span-1">
          <StorageLogo service="webdav" size={32} />
          <span className="flex min-w-0 flex-col">
            <span className="text-body font-medium">Other server</span>
            <span className="truncate text-xs text-faint">ownCloud, Synology, QNAP, anything with WebDAV</span>
          </span>
        </button>
      </div>
    </Dlg>
  );
}

/** The top of a connect dialog: back, the service's logo and name. */
function ConnectHead({ service, onBack }: { service: StorageService; onBack: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <button type="button" onClick={onBack} aria-label="Back" className="grid size-8 place-items-center rounded-lg bg-chip hover:bg-hover">
        <ChevronLeft size={16} />
      </button>
      <StorageLogo service={service} size={32} />
    </div>
  );
}

function ConnectNextcloud({ onBack, onClose, onDone }: { onBack: () => void; onClose: () => void; onDone: (c: StorageConnection) => void }) {
  const [server, setServer] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);
  useEffect(() => () => void (stop.current = true), []);
  const start = async () => {
    setError(null);
    // opened now, while the click still counts, so the browser doesn't block it
    const tab = window.open("about:blank", "_blank");
    try {
      const r = await api<{ pendingId: string; loginUrl: string }>("POST", "/api/storage/nextcloud/start", { server: server.trim() });
      if (tab) tab.location.href = r.loginUrl;
      else window.open(r.loginUrl, "_blank");
      setWaiting(true);
      while (!stop.current) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const p = await api<{ connection?: StorageConnection; waiting?: boolean }>("POST", "/api/storage/nextcloud/poll", { pendingId: r.pendingId });
        if (p.connection) return onDone(p.connection);
      }
    } catch (e) {
      tab?.close();
      setWaiting(false);
      setError((e as Error).message);
    }
  };
  return (
    <Dlg title="Nextcloud" onClose={onClose}>
      <ConnectHead service="nextcloud" onBack={onBack} />
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (server.trim() && !waiting) void start();
        }}
      >
        <Labeled label="Address">{(id) => <TextBox id={id} placeholder="https://cloud.example.com" value={server} onChange={(e) => setServer(e.target.value)} autoFocus />}</Labeled>
        <Prim type="submit" className="w-full" disabled={!server.trim() || waiting}>
          Sign in with Nextcloud
        </Prim>
        <p className="px-1 text-sm leading-snug text-muted">Your Nextcloud opens in the browser to approve Wisp. Wisp gets its own app password, which you can revoke there under Security. It never sees your password.</p>
        {waiting && (
          <p className="flex items-center gap-2.5 border-t border-line pt-3.5 text-sm text-muted" role="status">
            <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink" aria-hidden />
            Waiting for you to approve in the browser…
          </p>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
      </form>
    </Dlg>
  );
}

function ConnectServer({ service, onBack, onClose, onDone }: { service: "truenas" | "webdav"; onBack: () => void; onClose: () => void; onDone: (c: StorageConnection) => void }) {
  const [url, setUrl] = useState("");
  const [logins, setLogins] = useState<{ source: { label: string } | null; logins: LoginSummary[] } | null>(null);
  const [how, setHow] = useState<"manager" | "password">("manager");
  const [loginId, setLoginId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ source: { label: string } | null; logins: LoginSummary[] }>("GET", "/api/logins").then(
      (r) => {
        setLogins(r);
        if (!r.source) setHow("password");
      },
      () => setHow("password"),
    );
  }, []);
  const ready = url.trim() && (how === "manager" ? !!loginId : username.trim() && password);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api<StorageConnection>("POST", "/api/storage/webdav", { service, url: url.trim(), ...(how === "manager" ? { loginItemId: loginId } : { username: username.trim(), password }) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dlg title={STORAGE_SERVICES[service].name} onClose={onClose}>
      <ConnectHead service={service} onBack={onBack} />
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void connect();
        }}
      >
        <Labeled label="WebDAV address">{(id) => <TextBox id={id} placeholder={service === "truenas" ? "https://nas.local:8081/files" : "https://files.example.com/dav"} value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />}</Labeled>
        <div className="space-y-1.5">
          <span className="block px-1 text-[13px] tracking-wide text-faint">Sign in with</span>
          <Seg
            label="Sign in with"
            value={how}
            onChange={setHow}
            options={[
              ["manager", "Password manager"],
              ["password", "App password"],
            ]}
          />
        </div>
        {how === "manager" ? (
          logins?.source ? (
            <>
              <Labeled label="Login">
                {(id) => (
                  <select id={id} value={loginId} onChange={(e) => setLoginId(e.target.value)} className="h-[50px] w-full rounded-2xl border border-control-line bg-control px-4 text-base outline-none focus:ring-3 focus:ring-ring/30">
                    <option value="">Pick a login…</option>
                    {logins.logins.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.title} · {l.username || l.site}
                      </option>
                    ))}
                  </select>
                )}
              </Labeled>
              <p className="px-1 text-sm leading-snug text-muted">Wisp reads it from {logins.source.label} each time it opens the server and never keeps it. Use a user that can only reach the shares agents need.</p>
            </>
          ) : (
            <p className="px-1 text-sm leading-snug text-muted">
              No password manager is connected.{" "}
              <a className="text-accent-text hover:underline" href="#/settings/logins">
                Connect one in Logins
              </a>
              , or use an app password.
            </p>
          )
        ) : (
          <>
            <Labeled label="User name">{(id) => <TextBox id={id} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />}</Labeled>
            <Labeled label="App password">{(id) => <TextBox id={id} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Labeled>
            <p className="px-1 text-sm leading-snug text-muted">Kept encrypted on your hub. Only owners can change it.</p>
          </>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Sec onClick={onClose}>Cancel</Sec>
          <Prim type="submit" disabled={!ready || busy}>
            {busy ? "Checking…" : "Connect"}
          </Prim>
        </div>
      </form>
    </Dlg>
  );
}

function ConnectCloud({ service, app, onBack, onClose }: { service: "gdrive" | "dropbox"; app: { clientId: string } | null; onBack: () => void; onClose: () => void }) {
  const google = service === "gdrive";
  const [clientId, setClientId] = useState(app?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = !!app && clientId.trim() === app.clientId;
  const ready = clientId.trim() && (!google || saved || secret.trim());
  const redirect = `${location.origin}/api/storage/oauth/callback`;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string }>("POST", "/api/storage/oauth/start", { service, origin: location.origin, clientId: clientId.trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}) });
      location.href = r.url;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dlg title={STORAGE_SERVICES[service].name} onClose={onClose}>
      <ConnectHead service={service} onBack={onBack} />
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void start();
        }}
      >
        <div className="space-y-1 px-1">
          <div className="text-body font-medium">Your {google ? "Google" : "Dropbox"} app</div>
          <p className="text-sm leading-snug text-muted">
            Wisp runs on your own server, so it signs in to {STORAGE_SERVICES[service].name} through an app you make {google ? "in Google Cloud" : "in the Dropbox App Console"}. Once per workspace.{" "}
            <a className="inline-flex items-center gap-1 text-accent-text hover:underline" href={APP_HELP[service]} target="_blank" rel="noreferrer">
              How <ExternalLink size={12} />
            </a>
          </p>
          <p className="text-[13px] leading-snug text-faint">
            Redirect address: <span className="select-all font-mono">{redirect}</span>
          </p>
        </div>
        <Labeled label={google ? "Client ID" : "App key"}>{(id) => <TextBox id={id} autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} />}</Labeled>
        {google && <Labeled label="Client secret">{(id) => <TextBox id={id} type="password" autoComplete="new-password" placeholder={saved ? "Saved" : ""} value={secret} onChange={(e) => setSecret(e.target.value)} />}</Labeled>}
        {error && <p className="text-sm text-bad">{error}</p>}
        <Sec type="submit" className="h-[50px] w-full font-medium" disabled={!ready || busy}>
          <StorageLogo service={service} size={22} /> Sign in with {google ? "Google" : "Dropbox"}
        </Sec>
      </form>
    </Dlg>
  );
}

// --- one connection --------------------------------------------------------------------------

function ConnectionPage({ conn, isOwner, onBack, onChange }: { conn: StorageConnection; isOwner: boolean; onBack: () => void; onChange: () => Promise<unknown> }) {
  const agents = useStore((s) => s.agents);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Partial<Pick<StorageConnection, "folders" | "allAgents" | "agentIds">>) => {
    setError(null);
    try {
      await api("PATCH", `/api/storage/${conn.id}`, patch);
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${conn.name}? Agents stop being able to use it. Nothing on the storage itself changes.`)) return;
    await api("DELETE", `/api/storage/${conn.id}`).catch((e) => setError((e as Error).message));
    await onChange();
    onBack();
  };
  const forget = async (agentId: string, folder: string) => {
    await api("DELETE", `/api/storage/${conn.id}/always/${encodeURIComponent(agentId)}?folder=${encodeURIComponent(folder)}`).catch((e) => setError((e as Error).message));
    await onChange();
  };
  const setAccess = (path: string, access: StorageAccess) => save({ folders: conn.folders.map((f) => (f.path === path ? { ...f, access } : f)) });
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "An agent";
  const signedIn = conn.account ? `signed in as ${conn.account}` : null;

  return (
    <>
      <div className="mb-6 flex items-center gap-3">
        <button type="button" onClick={onBack} aria-label="Back to Storage" className="grid size-8 shrink-0 place-items-center rounded-lg bg-chip hover:bg-hover">
          <ChevronLeft size={16} />
        </button>
        <StorageLogo service={conn.service} size={36} />
        <div className="min-w-0">
          <h2 className="t-title truncate">{conn.name}</h2>
          <p className="truncate text-sm text-faint">{[hostOf(conn.url), signedIn].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
      <OwnersOnly show={!isOwner} />
      <div className="space-y-7">
        {conn.problem && <Note tone="warn">{conn.problem}</Note>}
        <section className="space-y-2">
          <Label>Folders agents can use</Label>
          <Panel>
            {conn.folders.map((f) => (
              <div key={f.path} className="flex min-h-[54px] items-center gap-3 px-4 py-2">
                <Folder size={18} strokeWidth={1.7} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-body">{f.path === "/" ? "Everything" : f.path.slice(1)}</span>
                <select
                  aria-label={`What agents can do in ${f.path}`}
                  value={f.access}
                  disabled={!isOwner}
                  onChange={(e) => void setAccess(f.path, e.target.value as StorageAccess)}
                  className="h-[34px] w-[124px] shrink-0 rounded-[10px] border border-control-line bg-control px-2 text-[13px] outline-none disabled:opacity-60"
                >
                  <option value="read">Read only</option>
                  <option value="write">Can change</option>
                </select>
                {isOwner && (
                  <button type="button" onClick={() => void save({ folders: conn.folders.filter((x) => x.path !== f.path) })} aria-label={`Remove ${f.path}`} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-hover hover:text-ink">
                    <X size={15} />
                  </button>
                )}
              </div>
            ))}
            {isOwner && <Item icon={<span className="grid size-[18px] place-items-center"><Plus size={16} /></span>} title="Add folder" onClick={() => setPicking(true)} />}
            {!isOwner && !conn.folders.length && <p className="px-4 py-4 text-sm text-muted">No folders yet.</p>}
          </Panel>
          <p className="px-1 text-sm text-muted">Agents ask you before adding, changing or deleting files.</p>
          {conn.always.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-1 text-sm">
              <span className="text-faint">Change files without asking:</span>
              {conn.always.map((a) => (
                <span key={`${a.agentId}${a.folder}`} className="inline-flex h-7 items-center gap-1 rounded-full bg-chip pl-2.5 pr-1">
                  {agentName(a.agentId)} in {a.folder === "/" ? "everything" : a.folder.slice(1)}
                  {isOwner && (
                    <button type="button" onClick={() => void forget(a.agentId, a.folder)} className="grid size-5 place-items-center rounded-full text-muted hover:text-ink" aria-label={`${agentName(a.agentId)} asks again in ${a.folder}`}>
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <Label>Who can use it</Label>
          <div className="max-w-[300px]">
            <Seg
              label="Who can use it"
              disabled={!isOwner}
              value={conn.allAgents ? "all" : "some"}
              onChange={(v) => void save({ allAgents: v === "all" })}
              options={[
                ["all", "Every agent"],
                ["some", "Some agents"],
              ]}
            />
          </div>
          {!conn.allAgents && (
            <div className="flex flex-wrap gap-2 px-1 pt-1">
              {agents.length === 0 && <p className="text-sm text-muted">No agents yet.</p>}
              {agents.map((a) => {
                const on = conn.agentIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={on}
                    disabled={!isOwner}
                    onClick={() => void save({ agentIds: on ? conn.agentIds.filter((x) => x !== a.id) : [...conn.agentIds, a.id] })}
                    className={cx("h-8 rounded-full px-3 text-sm disabled:opacity-60", on ? "bg-ink text-panel" : "border border-control-line bg-control hover:bg-hover")}
                  >
                    @{a.handle}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {error && <p className="text-sm text-bad">{error}</p>}
        {isOwner && (
          <Sec className="text-bad" onClick={() => void remove()}>
            Remove storage
          </Sec>
        )}
      </div>
      {picking && (
        <FolderPicker
          conn={conn}
          onClose={() => setPicking(false)}
          onPick={(path) => {
            setPicking(false);
            if (!conn.folders.some((f) => f.path === path)) void save({ folders: [...conn.folders, { path, access: "read" } satisfies StorageFolder] });
          }}
        />
      )}
    </>
  );
}

/** Walk the storage's folders and pick one. */
function FolderPicker({ conn, onClose, onPick }: { conn: StorageConnection; onClose: () => void; onPick: (path: string) => void }) {
  const [at, setAt] = useState("/");
  const [entries, setEntries] = useState<StorageEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEntries(null);
    setError(null);
    api<{ entries: StorageEntry[] }>("GET", `/api/storage/${conn.id}/browse?path=${encodeURIComponent(at)}`).then(
      (r) => setEntries(r.entries.filter((e) => e.type === "folder")),
      (e) => setError((e as Error).message),
    );
  }, [conn.id, at]);
  const up = at === "/" ? null : at.slice(0, at.lastIndexOf("/")) || "/";
  return (
    <Dlg
      title="Add folder"
      sub={at === "/" ? conn.name : at}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Sec onClick={onClose}>Cancel</Sec>
          <Prim onClick={() => onPick(at)}>{at === "/" ? "Use everything" : "Use this folder"}</Prim>
        </div>
      }
    >
      <Panel className="max-h-80 overflow-y-auto">
        {up !== null && <Item icon={<span className="grid size-[18px] place-items-center"><ChevronLeft size={16} /></span>} title="Up" onClick={() => setAt(up)} />}
        {entries?.map((e) => <Item key={e.path} icon={<Folder size={18} strokeWidth={1.7} className="text-muted" />} title={e.name} right={<ChevronRight size={16} className="text-faint" />} onClick={() => setAt(e.path)} />)}
        {entries && !entries.length && <p className="px-4 py-4 text-sm text-muted">No folders inside.</p>}
        {!entries && !error && <p className="px-4 py-4 text-sm text-muted">Loading…</p>}
      </Panel>
      {error && <p className="text-sm text-bad">{error}</p>}
    </Dlg>
  );
}
