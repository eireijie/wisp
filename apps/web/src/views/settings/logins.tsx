import { useEffect, useState } from "react";
import { ExternalLink, Globe, KeyRound, Monitor, Shield, X } from "lucide-react";
import type { LoginSummary } from "@wisp/core";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { Button, Input, Modal, Pill } from "../../components/ui.tsx";
import { Card, OwnersOnly, PageHeader, Section } from "./parts.tsx";

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

  return (
    <>
      <PageHeader title="Logins">Let agents sign in to websites with logins from your password manager. They ask you before using one, and they never see the password. Wisp doesn't store any passwords.</PageHeader>
      <OwnersOnly show={!isOwner} />
      {error && <p className="mb-4 text-sm text-bad">{error}</p>}
      {!view ? null : !view.source ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 mb-6">
            <ManagerCard icon={<KeyRound size={18} />} name="1Password" sub="Paste one token" body="Make a vault called “Agents” and a service account that can only see it. Also fills in one-time codes saved there." action={isOwner ? <Button variant="primary" onClick={() => setConnecting(true)}>Connect</Button> : null} />
            <ManagerCard icon={<Shield size={18} />} name="Bitwarden" sub="Coming soon" body="Use a collection just for agents." action={<Pill>Coming soon</Pill>} />
          </div>
          <p className="flex gap-2.5 items-start rounded-xl bg-bg px-4 py-3 text-sm text-muted">
            <Monitor size={16} className="shrink-0 mt-0.5" />
            No password manager? That's fine. When an agent needs to sign in, its screen pops up and you sign in yourself.
          </p>
        </>
      ) : (
        <Section
          title={`From your ${view.source.label} “${view.source.vaultName}” vault`}
          description={`To add or change a login, do it in ${view.source.label}: it shows up here by itself.`}
          action={
            <div className="flex items-center gap-2">
              <Pill tone={view.problem ? "bad" : "ok"}>{view.problem ? "Not answering" : `${view.source.label} connected`}</Pill>
              {isOwner && (
                <Button variant="ghost" onClick={disconnect}>
                  Disconnect
                </Button>
              )}
            </div>
          }
        >
          {view.problem && (
            <p className="mb-3 text-sm text-bad">
              {view.problem}{" "}
              {isOwner && (
                <button className="underline" onClick={() => setConnecting(true)}>
                  Paste a new token
                </button>
              )}
            </p>
          )}
          <Card>
            <div role="table" aria-label="Logins agents can use">
              <div role="row" className="hidden sm:grid grid-cols-[2fr_2fr_3fr] gap-4 px-4 py-2.5 text-xs font-medium text-muted border-b border-line">
                <span role="columnheader">Website</span>
                <span role="columnheader">Account</span>
                <span role="columnheader">Who can use it</span>
              </div>
              {view.logins.length === 0 && !view.problem && <p className="px-4 py-4 text-sm text-muted">No logins in that vault yet. Add one in {view.source.label} and it shows up here.</p>}
              {view.logins.map((l) => (
                <div role="row" key={l.id} className="grid sm:grid-cols-[2fr_2fr_3fr] gap-1 sm:gap-4 items-center px-4 py-3 border-b border-line last:border-0">
                  <span role="cell" className="flex items-center gap-2 font-medium min-w-0">
                    <Globe size={15} className="text-muted shrink-0" />
                    <span className="truncate">{l.site}</span>
                  </span>
                  <span role="cell" className="text-sm text-muted truncate">
                    {l.username || l.title}
                  </span>
                  <span role="cell" className="flex flex-wrap items-center gap-1.5 text-sm">
                    {l.always.map((a) => (
                      <span key={a} className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full bg-chip">
                        {agentName(a)} · always
                        {isOwner && (
                          <button onClick={() => forget(l.id, a)} className="size-5 grid place-items-center rounded-full text-muted hover:text-ink" aria-label={`Stop letting ${agentName(a)} use it without asking`}>
                            <X size={12} />
                          </button>
                        )}
                      </span>
                    ))}
                    <span className="text-muted">{l.always.length ? "others ask first" : "Everyone asks first"}</span>
                  </span>
                </div>
              ))}
            </div>
          </Card>
          <p className="mt-3 text-sm text-muted">Every use shows on that computer's activity, like “Nova used the Zendesk login”. Passwords never pass through chat, memory or logs.</p>
        </Section>
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

function ManagerCard({ icon, name, sub, body, action }: { icon: React.ReactNode; name: string; sub: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4">
      <div className="flex items-center gap-3">
        <span className="size-10 rounded-xl border border-line grid place-items-center text-muted">{icon}</span>
        <div>
          <div className="font-semibold">{name}</div>
          <div className="text-xs text-muted">{sub}</div>
        </div>
      </div>
      <p className="text-sm text-muted flex-1">{body}</p>
      <div>{action}</div>
    </div>
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
  const step = (n: number, title: string, body: React.ReactNode) => (
    <li className="flex gap-3">
      <span className="size-6 shrink-0 rounded-full bg-chip text-xs font-semibold grid place-items-center">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-sm text-muted mt-0.5">{body}</div>
      </div>
    </li>
  );
  return (
    <Modal title="Connect 1Password" onClose={onClose}>
      {found ? (
        <div className="space-y-4">
          <p className="rounded-xl bg-accent-soft px-3 py-2.5 text-sm">
            Found the {found.vaultName} vault · {found.count} {found.count === 1 ? "login" : "logins"}
          </p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={onDone}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void connect();
          }}
        >
          <ol className="space-y-4">
            {step(1, "Make a vault called “Agents”", "Put only the logins you want agents to use in it.")}
            {step(
              2,
              "Make a service account for that vault",
              <>
                Give it read access to Agents and nothing else, then copy its token.{" "}
                <a className="inline-flex items-center gap-1 text-accent-text hover:underline" href={SERVICE_ACCOUNT_HELP} target="_blank" rel="noreferrer">
                  How <ExternalLink size={12} />
                </a>
              </>,
            )}
            {step(
              3,
              "Paste the token",
              <Input className="mt-1.5 w-full font-mono" type="password" autoComplete="off" aria-label="1Password service account token" placeholder="ops_..." value={token} onChange={(e) => setToken(e.target.value)} />,
            )}
          </ol>
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || !token.trim()}>
              {busy ? "Checking…" : "Connect"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
