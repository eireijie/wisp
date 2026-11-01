import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { CopyBlock, cx, timeAgo } from "../../components/ui.tsx";
import { MoreOptions } from "../../components/MoreOptions.tsx";
import { obsidianLink, onHubMachine, type MemoryStorage } from "../../obsidian.ts";
import { MemoryDialog, Overline, field, pill, pillPrimary } from "./parts.tsx";

const Code = ({ children }: { children: ReactNode }) => <code className="rounded bg-code px-1 py-0.5 text-[12px] break-all">{children}</code>;

/** Where memory is kept, and how to use it in Obsidian: here, or on another computer with a sign-in token. */
export function StorageDialog({ onClose }: { onClose: () => void }) {
  const isOwner = useStore((s) => s.me?.role === "owner");
  const [storage, setStorage] = useState<MemoryStorage | null>(null);
  const load = useCallback(() => api<MemoryStorage>("GET", "/api/memory/storage").then(setStorage, () => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <MemoryDialog title="Memory storage" onClose={onClose}>
      {!storage ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <>
          {isOwner && <Location storage={storage} reload={load} />}
          <Obsidian storage={storage} reload={load} />
          <p className="mt-6 px-1 text-xs text-muted">Memory is plain markdown in git, so you can also write in Obsidian.</p>
        </>
      )}
    </MemoryDialog>
  );
}

function Location({ storage, reload }: { storage: MemoryStorage; reload: () => void }) {
  const [draft, setDraft] = useState(storage.setting ?? "");
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const fixed = storage.source === "env" || storage.movable === false;
  const save = async (path: string | null) => {
    setError(null);
    setBusy(true);
    try {
      await api("PUT", "/api/memory/storage", { path });
      if (path === null) setDraft("");
      setChanging(false);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <Overline>Where memory is kept</Overline>
      {storage.path && (
        <div className="rounded-3xl bg-card px-4 py-3">
          <div className="text-xs text-muted">Folder on this computer</div>
          <div className="mt-0.5 font-mono text-[14px] break-all">{storage.path}</div>
        </div>
      )}
      {storage.path && <p className="mt-2 px-1 text-xs text-muted">{storage.movable === false ? "Each extra workspace keeps its memory in Wisp's own data folder, so it can't be moved." : fixed ? "Set by WISP_VAULT_DIR where Wisp runs, so it can only be changed there." : storage.source === "default" ? "Wisp's own data folder, the default." : "Chosen here."}</p>}
      {!fixed && (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={cx(pill, "flex-1")} onClick={() => setChanging(!changing)} aria-expanded={changing}>
              Use a different folder
            </button>
            {storage.setting && (
              <button className={cx(pill, "flex-1")} disabled={busy} onClick={() => save(null)}>
                Use the default
              </button>
            )}
          </div>
          {changing && (
            <form
              className="mt-3 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                save(draft.trim() || null);
              }}
            >
              <input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Folder on this computer" placeholder="/Users/you/Documents/My Obsidian vault" className={field} autoFocus />
              <div className="flex justify-end">
                <button className={pillPrimary} disabled={busy || draft.trim() === (storage.setting ?? "")}>
                  Save
                </button>
              </div>
              <MoreOptions about="what happens to your notes">
                <p className="text-xs text-muted leading-relaxed">
                  Type the full path on the machine that runs Wisp. If the folder is an Obsidian vault, its notes are used as they are and its <Code>.obsidian</Code> settings are never touched or saved. If you were already using Wisp, your earlier notes are copied across the next time Wisp starts: an empty folder gets everything (history included); a folder with notes only gets the files it doesn't have. Your earlier folder is left exactly as it was. Running in Docker? The folder has to be inside a volume you mounted.
                </p>
              </MoreOptions>
              {error && <p className="text-sm text-bad">{error}</p>}
            </form>
          )}
          <p className="mt-2 px-1 text-xs text-muted">Wisp restarts to pick up a new folder. Your notes stay where they are.</p>
        </>
      )}
      {storage.pendingRestart && (
        <div className="mt-3 rounded-3xl bg-info/15 p-4 text-sm space-y-2">
          <p>
            Wisp will use <Code>{storage.nextPath}</Code> after it restarts. Nothing changes until then.
          </p>
          {storage.restartable ? (
            <button
              className={pillPrimary}
              disabled={restarting}
              onClick={async () => {
                setRestarting(true);
                await api("POST", "/api/memory/storage/restart").catch(() => {});
                setTimeout(() => window.location.reload(), 4000);
              }}
            >
              {restarting ? "Restarting…" : "Restart Wisp now"}
            </button>
          ) : (
            <p className="text-muted">Stop Wisp and start it again to switch.</p>
          )}
        </div>
      )}
      {storage.moved && storage.moved.how !== "none" && (
        <p className="mt-3 px-1 text-xs text-muted">
          {storage.moved.how === "copied" ? "Your earlier memory was copied here" : `${storage.moved.files} notes from your earlier memory were added here, and nothing in this folder was overwritten`} the last time Wisp started.
        </p>
      )}
      {storage.previous && (
        <p className="mt-3 px-1 text-xs text-muted">
          Your earlier memory is still in <Code>{storage.previous}</Code>. Wisp never deletes it; remove it yourself once you're happy with the new place.
        </p>
      )}
    </section>
  );
}

function Obsidian({ storage, reload }: { storage: MemoryStorage; reload: () => void }) {
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<{ id?: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const local = onHubMachine();
  const remoteUrl = (token: string) => {
    const u = new URL(window.location.origin);
    u.username = "wisp";
    u.password = token;
    u.pathname = storage.sync.urlPath;
    return u.toString();
  };
  const create = async () => {
    setError(null);
    try {
      const r = await api<{ token: string }>("POST", "/api/memory/tokens", { label });
      setFresh({ token: r.token });
      setLabel("");
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <Overline>Obsidian sync</Overline>
      <div className="rounded-3xl bg-card px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-muted">Branch</div>
          <div className="font-medium">{storage.sync.branch ?? "main"}</div>
        </div>
        {storage.path && local ? (
          <a href={obsidianLink(storage.path)} className={pill}>
            <ExternalLink size={15} /> Open in Obsidian
          </a>
        ) : null}
      </div>
      {storage.path && (
        <p className="mt-2 px-1 text-xs text-muted leading-relaxed">
          On the computer that runs Wisp: in Obsidian choose <b>Open folder as vault</b> and pick <Code>{storage.path}</Code>. Edits you make there are picked up within a few seconds and saved as "Edited in Obsidian".
        </p>
      )}

      <Overline>On another computer</Overline>
      {!storage.sync.allowed ? (
        <p className="rounded-3xl bg-card p-4 text-sm">{storage.sync.reason}</p>
      ) : (
        <>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Token name" aria-label="Token name" className={cx(field, "flex-1 min-w-0")} />
            <button className={cx(pillPrimary, "h-11")}>Create token</button>
          </form>
          {error && <p className="mt-2 text-sm text-bad">{error}</p>}
          {fresh && (
            <div className="mt-3 rounded-3xl bg-card p-4 space-y-2">
              <p className="text-sm font-medium">Your new token. You only see it once.</p>
              <CopyBlock text={fresh.token} />
              <p className="text-xs text-muted">Then, in a terminal in the folder where you keep your vaults:</p>
              <CopyBlock text={`git clone "${remoteUrl(fresh.token)}" "Wisp memory"`} />
            </div>
          )}
          {window.location.protocol === "http:" && !local && <p className="mt-2 px-1 text-xs text-muted">This address isn't encrypted. That's fine on your home network or a private network like Tailscale; otherwise use an https address so the token can't be read on the way.</p>}
          <div className="mt-3">
            <MoreOptions about="steps for Obsidian's Git plugin">
              <ol className="list-decimal pl-5 space-y-2 text-sm text-muted marker:text-faint">
                <li>
                  Make sure <b>git</b> is installed on that computer (<Code>git --version</Code> in a terminal tells you), and install <b>Obsidian</b>.
                </li>
                <li>Create a token for that computer above, and copy it. It's shown once.</li>
                <li>
                  Copy memory to that computer with the <Code>git clone</Code> command shown after you create the token (replace YOUR-TOKEN with it).
                </li>
                <li>
                  In Obsidian choose <b>Open folder as vault</b> and pick the new <Code>Wisp memory</Code> folder. Then open <b>Settings → Community plugins → Browse</b>, install <b>Git</b> (by Vinzent03) and turn it on.
                </li>
                <li>
                  In the Git plugin's settings set <b>Auto pull interval</b> and <b>Auto commit-and-sync interval</b> to a few minutes, and turn on <b>Pull on startup</b>.
                </li>
              </ol>
              <ul className="mt-3 list-disc pl-5 space-y-1.5 text-xs text-muted marker:text-faint">
                <li>Your changes show up in Wisp under your name, in Activity.</li>
                <li>Wisp checks every change against the same rules as the app. If you edit a note you're not allowed to edit, the sync is refused and the plugin says so; undo that edit and sync again.</li>
                <li>If you and an agent changed the same note, the plugin shows a merge conflict the way any git project does. Keep the text you want and sync again.</li>
                <li>
                  Obsidian's own settings and plugins (the <Code>.obsidian</Code> folder) stay on your computer and are never synced.
                </li>
                <li>Syncing hands over all of memory, history included, so it's only for people who are allowed to read every note. Revoke a token the moment a computer is lost.</li>
              </ul>
            </MoreOptions>
          </div>
        </>
      )}
      {storage.tokens.length > 0 && (
        <>
          <Overline>Your sign-in tokens</Overline>
          <div className="rounded-3xl bg-card divide-y divide-line overflow-hidden">
            {storage.tokens.map((t) => (
              <div key={t.id} className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{t.label || "Obsidian"}</div>
                  <div className="text-xs text-muted">
                    Created {timeAgo(t.createdAt)} · {t.lastUsed ? `last used ${timeAgo(t.lastUsed)}` : "never used"}
                  </div>
                </div>
                <button
                  className={cx(pill, "text-bad")}
                  onClick={async () => {
                    if (!confirm(`Stop "${t.label || "Obsidian"}" from syncing? That computer keeps its copy but can't pull or push any more.`)) return;
                    await api("DELETE", `/api/memory/tokens/${t.id}`).catch(() => {});
                    reload();
                  }}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
          <p className="mt-2 px-1 text-xs text-muted">Tokens work only for syncing memory, not for signing in to Wisp.</p>
        </>
      )}
    </>
  );
}

