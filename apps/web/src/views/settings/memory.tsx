import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ExternalLink, KeyRound, Trash2 } from "lucide-react";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { Button, CopyBlock, Input, Pill, timeAgo } from "../../components/ui.tsx";
import { obsidianLink, onHubMachine, type MemoryStorage } from "../../obsidian.ts";
import { Card, OwnersOnly, PageHeader, Row, Section } from "./parts.tsx";
import { MemoryRules } from "./workspace.tsx";
import { Advanced, useSimple } from "../../experience.tsx";

const Code = ({ children }: { children: ReactNode }) => <code className="rounded bg-code px-1 py-0.5 text-[12px] break-all">{children}</code>;

/** Settings → Memory: where notes are kept, how to use them in Obsidian, and who may see or edit what. */
export function MemoryPage() {
  const isOwner = useStore((s) => s.me)?.role === "owner";
  const [storage, setStorage] = useState<MemoryStorage | null>(null);
  const load = useCallback(() => api<MemoryStorage>("GET", "/api/memory/storage").then(setStorage, () => {}), []);
  useEffect(() => {
    load();
  }, [load]);

  const simple = useSimple();
  return (
    <>
      <PageHeader title="Memory">
        {simple ? (
          <>What your helpers and people remember, and who can see each note.</>
        ) : (
          <>
            Plain markdown notes in one folder. Open them in <b>Obsidian</b> if you like.
          </>
        )}
      </PageHeader>
      {!simple && storage && isOwner && <Location storage={storage} reload={load} />}
      <MemoryRules />
      {storage && (
        <Advanced title="Use another notes app (Obsidian) and sync">
          {simple && isOwner && <Location storage={storage} reload={load} />}
          <ObsidianSteps storage={storage} reload={load} />
        </Advanced>
      )}
    </>
  );
}

function Location({ storage, reload }: { storage: MemoryStorage; reload: () => void }) {
  const [draft, setDraft] = useState(storage.setting ?? "");
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
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Where memory is kept" description="A folder on the computer that runs Warren. It can be an existing Obsidian vault.">
      {storage.path && (
        <Card>
          <div className="px-4 py-3.5 space-y-1.5">
            <div className="text-sm font-medium">Current folder</div>
            <div>
              <Code>{storage.path}</Code>
            </div>
            <div className="text-xs text-muted">{storage.movable === false ? "Each extra organization keeps its memory in Warren's own data folder, so it can't be moved." : fixed ? "Set by WARREN_VAULT_DIR where Warren runs, so it can only be changed there." : storage.source === "default" ? "Warren's own data folder, the default." : "Chosen here."}</div>
          </div>
          {!fixed && (
            <form
              className="px-4 py-3.5 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                save(draft.trim() || null);
              }}
            >
              <label className="text-sm font-medium" htmlFor="vault-folder">
                Use a different folder
              </label>
              <div className="flex flex-wrap gap-2">
                <Input id="vault-folder" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="/Users/you/Documents/My Obsidian vault" className="flex-1 min-w-48" />
                <Button variant="primary" disabled={busy || draft.trim() === (storage.setting ?? "")}>
                  Save
                </Button>
                {storage.setting && (
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => save(null)}>
                    Use the default
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted">
                Type the full path on the machine that runs Warren. If the folder is an Obsidian vault, its notes are used as they are and its <Code>.obsidian</Code> settings are never touched or saved. If you were already using Warren, your earlier notes are copied across the next time Warren starts: an empty folder gets everything (history included); a folder with notes only gets the files it doesn't have. Your earlier folder is left exactly as it was. Running in Docker? The folder has to be inside a volume you mounted.
              </p>
              {error && <p className="text-sm text-bad">{error}</p>}
            </form>
          )}
        </Card>
      )}
      {storage.pendingRestart && (
        <div className="mt-3 rounded-xl bg-accent-soft p-4 text-sm space-y-2">
          <p>
            Warren will use <Code>{storage.nextPath}</Code> after it restarts. Nothing changes until then.
          </p>
          {storage.restartable ? (
            <Button
              variant="primary"
              disabled={restarting}
              onClick={async () => {
                setRestarting(true);
                await api("POST", "/api/memory/storage/restart").catch(() => {});
                setTimeout(() => window.location.reload(), 4000);
              }}
            >
              {restarting ? "Restarting…" : "Restart Warren now"}
            </Button>
          ) : (
            <p className="text-muted">Stop Warren and start it again to switch.</p>
          )}
        </div>
      )}
      {storage.moved && storage.moved.how !== "none" && (
        <p className="mt-3 text-sm text-muted">
          {storage.moved.how === "copied" ? "Your earlier memory was copied here" : `${storage.moved.files} notes from your earlier memory were added here, and nothing in this folder was overwritten`} the last time Warren started.
        </p>
      )}
      {storage.previous && (
        <p className="mt-3 text-sm text-muted">
          Your earlier memory is still in <Code>{storage.previous}</Code>. Warren never deletes it; remove it yourself once you're happy with the new place.
        </p>
      )}
    </Section>
  );
}

function ObsidianSteps({ storage, reload }: { storage: MemoryStorage; reload: () => void }) {
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const local = onHubMachine();
  const remoteUrl = (token: string) => {
    const u = new URL(window.location.origin);
    u.username = "warren";
    u.password = token;
    u.pathname = storage.sync.urlPath;
    return u.toString();
  };
  const create = async () => {
    setError(null);
    try {
      const r = await api<{ token: string }>("POST", "/api/memory/tokens", { label });
      setFresh(r.token);
      setLabel("");
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Section title="Use it in Obsidian" description="Obsidian is where you browse and edit notes. Anything you change there shows up in Warren, and your name goes on it.">
      <div className="space-y-6">
        {storage.path && (
          <Card>
            <div className="px-4 py-3.5 space-y-2">
              <div className="text-sm font-medium">On the computer that runs Warren</div>
              <p className="text-sm text-muted">
                In Obsidian choose <b>Open folder as vault</b> and pick <Code>{storage.path}</Code>. Edits you make are picked up within a few seconds and saved as "Edited in Obsidian".
              </p>
              {local && (
                <a href={obsidianLink(storage.path)} className="inline-flex items-center gap-1.5 h-9 rounded-lg border border-line px-3 text-sm font-medium hover:bg-hover whitespace-nowrap">
                  <ExternalLink size={15} /> Open in Obsidian
                </a>
              )}
            </div>
          </Card>
        )}

        <div className="rounded-xl border border-line p-4 space-y-4">
          <div>
            <h4 className="text-sm font-semibold">On another computer</h4>
            <p className="mt-0.5 text-sm text-muted">
              Warren shares memory as a git repository, which Obsidian's free <b>Git</b> plugin can copy to your computer and keep in step, both ways.
            </p>
          </div>

          {!storage.sync.allowed ? (
            <p className="text-sm rounded-lg bg-hover p-3">{storage.sync.reason}</p>
          ) : (
            <>
              <ol className="list-decimal pl-5 space-y-3 text-sm marker:text-faint">
                <li>
                  Make sure <b>git</b> is installed on that computer (<Code>git --version</Code> in a terminal tells you), and install <b>Obsidian</b>.
                </li>
                <li>
                  Make a sign-in token for that computer. It's shown once, so copy it right away.
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name, e.g. My laptop" className="max-w-56" aria-label="Token name" />
                    <Button onClick={create}>
                      <KeyRound size={15} /> Create token
                    </Button>
                  </div>
                  {error && <p className="mt-1 text-bad">{error}</p>}
                </li>
                <li>
                  Copy memory to that computer. In a terminal, in the folder where you keep your vaults:
                  <div className="mt-2">
                    <CopyBlock text={`git clone "${remoteUrl(fresh ?? "YOUR-TOKEN")}" "Warren memory"`} />
                  </div>
                  {!fresh && <p className="mt-1 text-xs text-muted">Replace YOUR-TOKEN with the token from step 2.</p>}
                  {window.location.protocol === "http:" && !local && (
                    <p className="mt-1 text-xs text-muted">This address isn't encrypted. That's fine on your home network or a private network like Tailscale; otherwise use an https address so the token can't be read on the way.</p>
                  )}
                </li>
                <li>
                  In Obsidian choose <b>Open folder as vault</b> and pick the new <Code>Warren memory</Code> folder. Then open <b>Settings → Community plugins → Browse</b>, install <b>Git</b> (by Vinzent03) and turn it on.
                </li>
                <li>
                  In the Git plugin's settings set <b>Auto pull interval</b> and <b>Auto commit-and-sync interval</b> (called "Vault backup interval" in older versions) to a few minutes, and turn on <b>Pull on startup</b>. From then on it brings in what agents and others wrote, and sends what you write.
                </li>
              </ol>
              <ul className="list-disc pl-5 space-y-1.5 text-sm text-muted marker:text-faint">
                <li>Your changes show up in Warren under your name, in Activity.</li>
                <li>Warren checks every change against the same rules as the app. If you edit a note you're not allowed to edit, the sync is refused and the plugin says so; undo that edit and sync again.</li>
                <li>If you and an agent changed the same note, the plugin shows a merge conflict the way any git project does. Keep the text you want and sync again.</li>
                <li>Obsidian's own settings and plugins (the <Code>.obsidian</Code> folder) stay on your computer and are never synced.</li>
                <li>Syncing hands over all of memory, history included, so it's only for people who are allowed to read every note. Revoke a token below the moment a computer is lost.</li>
              </ul>
            </>
          )}
        </div>

        {storage.tokens.length > 0 && (
          <div>
            <h4 className="mb-2 text-sm font-semibold">Your sign-in tokens</h4>
            <Card>
              {storage.tokens.map((t) => (
                <Row key={t.id} label={t.label || "Obsidian"} hint={`Made ${timeAgo(t.createdAt)} · ${t.lastUsed ? `last used ${timeAgo(t.lastUsed)}` : "never used"}`}>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (!confirm(`Stop "${t.label || "Obsidian"}" from syncing? That computer keeps its copy but can't pull or push any more.`)) return;
                      await api("DELETE", `/api/memory/tokens/${t.id}`).catch(() => {});
                      reload();
                    }}
                  >
                    <Trash2 size={15} /> Revoke
                  </Button>
                </Row>
              ))}
            </Card>
            <p className="mt-2 text-xs text-muted">
              Sync with the <Pill>{storage.sync.branch ?? "main"}</Pill> branch. Tokens work only for syncing memory, not for signing in to Warren.
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}
