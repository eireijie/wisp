import { useEffect, useState } from "react";
import { ExternalLink, Globe, KeyRound, Monitor, ShieldHalf, X } from "lucide-react";
import type { LoginSummary } from "@wisp/core";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { Add, Badge, Dlg, Item, Label, Note, Panel, Prim, Sec, TextBox, Tile } from "../../components/MarketParts.tsx";
import { OwnersOnly, PageHeader } from "./parts.tsx";

interface LoginsView {
  source: { kind: "1password"; label: string; vaultName: string; connectedBy: string; connectedAt: string } | null;
  logins: LoginSummary[];
  /** the password manager stopped answering (a revoked token, say) */
  problem: string | null;
}

const SERVICE_ACCOUNT_HELP = "https://developer.1password.com/docs/service-accounts/get-started/";

/**
 * Settings → Logins: connect a password manager so agents can sign in to websites without ever
 * seeing a password. Wisp stores no passwords; the logins listed here live in the manager.
 */
export function LoginsPage() {
  const isOwner = useStore((s) => s.me)?.role === "owner";
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const [view, setView] = useState<LoginsView | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = (fresh = false) => api<LoginsView>("GET", `/api/logins${fresh ? "?fresh=1" : ""}`).then(setView, (e) => setError((e as Error).message));
  useEffect(() => {
    void load();
  }, []);

  const disconnect = async () => {
    if (!confirm("Disconnect 1Password? Agents stop being able to fill logins until you connect it again.")) return;
    await api("DELETE", "/api/logins/source").catch((e) => setError((e as Error).message));
    void load();
  };
  const forget = async (itemId: string, agentId: string) => {
    await api("DELETE", `/api/logins/${encodeURIComponent(itemId)}/always/${encodeURIComponent(agentId)}`).catch((e) => setError((e as Error).message));
    void load();
  };
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "An agent";
  const source = view?.source ?? null;
  const connectedBy = source ? (members.find((m) => m.id === source.connectedBy)?.name ?? null) : null;

  return (
    <>
      <PageHeader title="Logins">Agents sign in to websites through your password manager. Wisp never stores a password. They ask you before using a login, and Wisp types the password in for them, so it never goes in chat.</PageHeader>
      <OwnersOnly show={!isOwner} />
      {error && <p className="mb-4 text-sm text-bad">{error}</p>}
      {view && (
        <div className="space-y-7">
          <Panel>
            <Item
              icon={<Tile size={50}><KeyRound size={22} strokeWidth={1.7} /></Tile>}
              title="1Password"
              sub={source ? `Connected${connectedBy ? ` by ${connectedBy}` : ""}` : "Paste one token"}
              right={
                source ? (
                  <>
                    <Badge tone={view.problem ? "warn" : "green"}>{view.problem ? "Not answering" : "On"}</Badge>
                    {isOwner && <Add onClick={disconnect}>Disconnect</Add>}
                  </>
                ) : isOwner ? (
                  <Prim className="h-[38px] px-[18px] text-[15px]" onClick={() => setConnecting(true)}>
                    Connect
                  </Prim>
                ) : undefined
              }
            />
            <Item icon={<Tile size={50}><ShieldHalf size={22} strokeWidth={1.7} /></Tile>} title="Bitwarden" sub="Not available yet" right={<Badge>Coming soon</Badge>} />
          </Panel>

          {!source && (
            <>
              <p className="px-1 text-sm text-faint">Make a vault called “Agents” and a service account that can only see it. Wisp also fills in one-time codes saved there.</p>
              <Note>
                <span className="flex items-start gap-2.5">
                  <Monitor size={16} className="mt-0.5 shrink-0 text-muted" />
                  No password manager? That's fine. When an agent needs to sign in, its screen pops up and you sign in yourself.
                </span>
              </Note>
            </>
          )}

          {source && (
            <section className="space-y-2">
              <Label>Logins agents can use</Label>
              <p className="px-1 text-sm text-faint">From your {source.label} “{source.vaultName}” vault. To add or change a login, do it in {source.label}: it shows up here by itself.</p>
              {view.problem && (
                <p className="px-1 text-sm text-bad">
                  {view.problem}{" "}
                  {isOwner && (
                    <button className="underline" onClick={() => setConnecting(true)}>
                      Paste a new token
                    </button>
                  )}
                </p>
              )}
              <Panel>
                <div role="table" aria-label="Logins agents can use">
                  <div role="row" className="hidden grid-cols-[2fr_2fr_3fr] gap-4 px-4 py-3 text-[13px] text-faint md:grid">
                    <span role="columnheader">Website</span>
                    <span role="columnheader">Account</span>
                    <span role="columnheader">Who can use it</span>
                  </div>
                  {view.logins.length === 0 && !view.problem && <p className="px-4 py-4 text-sm text-muted">No logins in that vault yet. Add one in {source.label} and it shows up here.</p>}
                  {view.logins.map((l) => (
                    <div role="row" key={l.id} className="relative grid items-center gap-1 px-4 py-3 before:absolute before:left-4 before:right-0 before:top-0 before:h-px before:bg-line first:before:hidden md:grid-cols-[2fr_2fr_3fr] md:gap-4">
                      <span role="cell" className="flex min-w-0 items-center gap-3">
                        <Tile size={40}>
                          <Globe size={19} strokeWidth={1.7} />
                        </Tile>
                        <span className="min-w-0">
                          <span className="block truncate text-[15px] font-medium">{l.site}</span>
                          <span className="block truncate text-sm text-faint md:hidden">{l.username || l.title}</span>
                        </span>
                      </span>
                      <span role="cell" className="hidden truncate text-sm text-faint md:block">
                        {l.username || l.title}
                      </span>
                      <span role="cell" className="flex flex-wrap items-center gap-1.5 text-sm max-md:pl-[52px]">
                        {l.always.map((a) => (
                          <span key={a} className="inline-flex h-7 items-center gap-1 rounded-full bg-chip pl-2.5 pr-1">
                            {agentName(a)}
                            {isOwner && (
                              <button onClick={() => forget(l.id, a)} className="grid size-5 place-items-center rounded-full text-muted hover:text-ink" aria-label={`Stop letting ${agentName(a)} use it without asking`}>
                                <X size={12} />
                              </button>
                            )}
                          </span>
                        ))}
                        <span className="text-faint">{l.always.length ? "others ask first" : "Only you"}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>
              <p className="px-1 text-sm text-faint">Every use shows on that computer's activity, like “Nova used the Zendesk login”. Passwords never pass through chat, memory or logs.</p>
            </section>
          )}
        </div>
      )}
      {connecting && (
        <ConnectOnePassword
          onClose={() => setConnecting(false)}
          onDone={() => {
            setConnecting(false);
            void load(true);
          }}
        />
      )}
    </>
  );
}

function ConnectOnePassword({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ vaultName: string; count: number } | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      setFound(await api<{ vaultName: string; count: number }>("PUT", "/api/logins/source", { kind: "1password", token: token.trim() }));
      setToken("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dlg title="Connect 1Password" sub="Only the owner can do this" onClose={onClose}>
      {found ? (
        <>
          <p className="rounded-2xl bg-accent-soft px-4 py-3 text-sm">
            Found the {found.vaultName} vault · {found.count} {found.count === 1 ? "login" : "logins"}
          </p>
          <div className="flex justify-end">
            <Prim onClick={onDone}>Done</Prim>
          </div>
        </>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void connect();
          }}
        >
          <p className="px-1 text-[15px] leading-snug text-ink/90">Wisp asks 1Password for one login at a time, only after you approve it in Inbox. Nothing is saved in Wisp.</p>
          <div className="space-y-1.5">
            <label htmlFor="op-token" className="block px-1 text-[13px] tracking-wide text-faint">
              Service account token
            </label>
            <TextBox id="op-token" className="font-mono" type="password" autoComplete="off" placeholder="ops_…" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Service account token" />
            <a className="inline-flex items-center gap-1 px-1 text-sm text-accent-text hover:underline" href={SERVICE_ACCOUNT_HELP} target="_blank" rel="noreferrer">
              Where do I find this? <ExternalLink size={12} />
            </a>
          </div>
          <p className="px-1 text-[13px] text-faint">Make a vault called “Agents” and a service account that can read only that vault, then copy its token.</p>
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex justify-end gap-2">
            <Sec onClick={onClose}>Cancel</Sec>
            <Prim type="submit" disabled={busy || !token.trim()}>
              {busy ? "Checking…" : "Connect"}
            </Prim>
          </div>
        </form>
      )}
    </Dlg>
  );
}
