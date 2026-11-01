import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { MODEL_PROVIDER_INFO, type ModelConnection, type ModelLogin, type ModelProvider } from "@wisp/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { PROVIDERS, connectWays, siteName } from "../models.ts";
import { cx } from "./ui.tsx";
import { SegBar } from "./RunParts.tsx";

/**
 * Connect a model once: a sign-in (one of the person's devices runs the provider's own sign-in and
 * shows a link and a code here) or an API key the hub checks with the provider. Every agent can
 * then use it, on any computer, in any harness that runs it.
 */
export function ConnectModel({ provider: fixed, big, onDone }: { provider?: ModelProvider; big?: boolean; onDone: (connectionId: string | null) => void }) {
  const [provider, setProvider] = useState<ModelProvider | null>(fixed ?? null);
  if (!provider)
    return (
      <div className="space-y-1" role="list" aria-label="Providers">
        {PROVIDERS.map((p) => (
          <button key={p.id} type="button" onClick={() => setProvider(p.id)} className={cx("w-full flex items-center gap-2 rounded-lg px-2.5 text-left hover:bg-hover", big ? "min-h-12 text-[15px]" : "min-h-9 text-[13px]")}>
            <span className="font-medium">{p.label}</span>
            <span className="text-[12px] text-faint">{p.signIn?.length ? "Sign in or API key" : "API key"}</span>
            <ChevronRight size={13} className="ml-auto text-faint" />
          </button>
        ))}
      </div>
    );
  return <ConnectProvider key={provider} provider={provider} big={big} onDone={onDone} />;
}

function ConnectProvider({ provider, big, onDone }: { provider: ModelProvider; big?: boolean; onDone: (connectionId: string | null) => void }) {
  const info = MODEL_PROVIDER_INFO[provider];
  const ways = connectWays(info);
  const [way, setWay] = useState(ways[0]);
  return (
    <div className="space-y-3">
      {ways.length > 1 && <SegBar label="How to connect" value={way} options={[["oauth", "Sign in"], ["key", "API key"]]} onChange={setWay} big={big} />}
      {way === "oauth" ? <SignIn provider={provider} big={big} onDone={onDone} onKey={() => setWay("key")} /> : <KeyForm provider={provider} big={big} onDone={onDone} />}
      <p className="px-1 text-[12px] leading-snug text-faint">Connect once. Every agent can use {info.label}, on any computer and in any harness that runs it.</p>
    </div>
  );
}

const card = "rounded-xl border border-line bg-card px-3.5 py-3";

function SignIn({ provider, big, onDone, onKey }: { provider: ModelProvider; big?: boolean; onDone: (connectionId: string | null) => void; onKey: () => void }) {
  const info = MODEL_PROVIDER_INFO[provider];
  const [loginId, setLoginId] = useState<string | null>(null);
  const [first, setFirst] = useState<ModelLogin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pushed = useStore((s) => (loginId ? s.modelLogins[loginId] : undefined));
  const [polled, setPolled] = useState<ModelLogin | null>(null);
  const login = pushed ?? polled ?? first;
  const started = useRef<number | null>(null);
  const finished = useRef(false);

  // start once per attempt (a second effect run in development mustn't start a second sign-in)
  useEffect(() => {
    if (started.current === attempt) return;
    started.current = attempt;
    setError(null);
    setFirst(null);
    setPolled(null);
    api<ModelLogin & { nodeId: string }>("POST", "/api/model-connections/login", { provider }).then(
      (l) => (setFirst(l), setLoginId(l.id)),
      (e) => setError((e as Error).message),
    );
  }, [provider, attempt]);

  // the socket brings progress; poll too, in case it's down
  useEffect(() => {
    if (!loginId || login?.status !== "running") return;
    const t = setInterval(() => void api<ModelLogin>("GET", `/api/model-connections/login/${loginId}`).then(setPolled, () => {}), 2500);
    return () => clearInterval(t);
  }, [loginId, login?.status]);

  useEffect(() => {
    if (login?.status === "done" && !finished.current) {
      finished.current = true;
      onDone(login.connectionId ?? null);
    }
  }, [login?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // leaving before it's done stops it on the device
  const live = useRef<{ id: string | null; running: boolean }>({ id: null, running: false });
  live.current = { id: loginId, running: login?.status === "running" };
  useEffect(
    () => () => {
      if (live.current.id && live.current.running) void api("DELETE", `/api/model-connections/login/${live.current.id}`).catch(() => {});
    },
    [],
  );

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!loginId || !paste.trim()) return;
    setSending(true);
    try {
      setPolled(await api<ModelLogin>("POST", `/api/model-connections/login/${loginId}/input`, { text: paste.trim() }));
      setPaste("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };
  const copy = async () => {
    if (!login?.code) return;
    try {
      await navigator.clipboard.writeText(login.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const site = siteName(login?.url ?? info.site);
  const btn = cx("inline-flex items-center gap-1.5 rounded-lg px-3 font-medium", big ? "h-10 text-[15px]" : "h-8 text-[13px]");

  if (error && !login)
    return (
      <div className={cx(card, "space-y-2.5")}>
        <p className="text-[13px] leading-snug text-bad">{error}</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setAttempt((a) => a + 1)} className={cx(btn, "bg-chip hover:bg-hover")}>
            Try again
          </button>
          <button type="button" onClick={onKey} className={cx(btn, "bg-chip hover:bg-hover")}>
            Use an API key
          </button>
        </div>
      </div>
    );

  if (login?.status === "failed")
    return (
      <div className={cx(card, "space-y-2.5")}>
        <p className="text-[13px] leading-snug text-bad">{login.error ?? "The sign-in stopped."}</p>
        <button type="button" onClick={() => (setLoginId(null), setAttempt((a) => a + 1))} className={cx(btn, "bg-chip hover:bg-hover")}>
          Try again
        </button>
      </div>
    );

  if (login?.status === "done")
    return (
      <div className={card}>
        <p className={cx(big ? "text-[15px]" : "text-[13px]")}>Connected.</p>
      </div>
    );

  return (
    <div className={cx(card, "space-y-3")} aria-live="polite">
      {!login?.url ? (
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" /> Starting the sign-in…
        </p>
      ) : (
        <>
          <p className={cx("text-ink/90", big ? "text-[15px]" : "text-[13px]")}>{login.code ? "Open the link and enter this code." : login.wantsInput ? `Open the link, sign in, then paste the code ${site} shows.` : "Open the link and sign in."}</p>
          {login.code && <div className={cx("font-mono font-semibold tracking-[0.12em] select-all", big ? "text-[26px]" : "text-[22px]")}>{login.code}</div>}
          <div className="flex flex-wrap gap-2">
            <a href={login.url} target="_blank" rel="noreferrer" className={cx(btn, "bg-accent text-accent-ink hover:bg-accent/90")}>
              Open {site}
              <ExternalLink size={13} />
            </a>
            {login.code && (
              <button type="button" onClick={copy} className={cx(btn, "bg-chip hover:bg-hover")}>
                {copied ? "Copied" : "Copy code"}
              </button>
            )}
          </div>
          {login.wantsInput && (
            <form onSubmit={send} className="flex gap-2">
              <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste the code" aria-label="Code from the sign-in page" autoComplete="off" spellCheck={false} className={cx("min-w-0 flex-1 rounded-lg border border-control-line bg-control px-3 font-mono outline-none focus:border-ring", big ? "h-10 text-[15px]" : "h-8 text-[13px]")} />
              <button type="submit" disabled={!paste.trim() || sending} className={cx(btn, "bg-chip hover:bg-hover disabled:opacity-50")}>
                {sending ? <Loader2 size={13} className="animate-spin" /> : "Send"}
              </button>
            </form>
          )}
          {error && <p className="text-[12px] text-bad">{error}</p>}
          <p className="flex items-center gap-2 text-[12px] text-muted">
            <span className="m-wait size-1.5 rounded-full bg-warn" aria-hidden />
            Waiting for you to finish…
          </p>
        </>
      )}
    </div>
  );
}

function KeyForm({ provider, big, onDone }: { provider: ModelProvider; big?: boolean; onDone: (connectionId: string | null) => void }) {
  const info = MODEL_PROVIDER_INFO[provider];
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const c = await api<ModelConnection>("POST", "/api/model-connections", { provider, kind: "key", key: key.trim() });
      onDone(c.id);
    } catch (err) {
      const m = (err as Error).message.replace(/^key: /, "");
      setError(m.charAt(0).toUpperCase() + m.slice(1));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className={cx(card, "space-y-2.5")}>
      <input
        type="password"
        value={key}
        onChange={(e) => (setKey(e.target.value), setError(null))}
        placeholder={info.keyPrefix ? `${info.keyPrefix}…` : `${info.label} API key`}
        aria-label={`${info.label} API key`}
        autoComplete="off"
        spellCheck={false}
        className={cx("w-full rounded-lg border border-control-line bg-control px-3 font-mono outline-none focus:border-ring", big ? "h-11 text-[15px]" : "h-9 text-[13px]")}
      />
      {error && <p className="text-[12px] leading-snug text-bad">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={!key.trim() || busy} className={cx("inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 font-medium text-accent-ink disabled:opacity-50", big ? "h-10 text-[15px]" : "h-8 text-[13px]")}>
          {busy && <Loader2 size={13} className="animate-spin" />}
          {busy ? "Checking" : "Connect"}
        </button>
        <a href={info.keyUrl} target="_blank" rel="noreferrer" className="text-[12px] text-muted hover:text-ink">
          Get a key
        </a>
      </div>
    </form>
  );
}
