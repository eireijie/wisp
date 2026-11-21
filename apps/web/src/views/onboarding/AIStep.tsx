import { useEffect, useRef, useState, type ComponentType, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { Message } from "@wisp/core";
import { HARNESSES, MODEL_PROVIDER_INFO, harnessLabel, type Agent, type HarnessSettings, type ModelConnection, type ModelProvider } from "@wisp/core";
import type { GhostAppearance } from "@wisp/core/src/appearance.ts";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { unavailable } from "../../join.ts";
import { ConnectModel } from "../../components/ConnectModel.tsx";
import { switchOnRecommended } from "../../onboardingSetup.ts";
import { HOST_LOOK, HostGhost, hostReact } from "../../components/onboarding/HostGhost.tsx";
import { DrawnCheck, SlideMark, Typed } from "../../components/onboarding/obMotion.tsx";
import { WHITE_WISP } from "../../components/SetupStage.tsx";
import { canUse, readyConnection, signInProvider, useConnections } from "../../models.ts";
import { loadAnswers, saveAnswers, type AgentDraft } from "../../onboardingV3.ts";
import type { DeviceInfo } from "../../devices.ts";
import type { HarnessesResponse, HarnessSignIn as HarnessSignInDialog } from "../settings/harnesses.tsx";
import { makeFirstAgent } from "./firstAgent.ts";
import { PageTop } from "../../components/onboarding/PageTop.tsx";
import { useNarrow } from "../../components/SetupShell.tsx";

const STYLE = `
@keyframes ob-pop { 0% { opacity: 0; transform: translateY(6px) scale(.98); } 100% { opacity: 1; transform: none; } }
.ob-pop { animation: ob-pop .32s cubic-bezier(.32,.72,0,1) both; }
@keyframes ob-hop-a { 0%,100% { transform: none; } 35% { transform: translateY(-12px) scale(.95,1.06); } 70% { transform: translateY(0) scale(1.07,.93); } }
@keyframes ob-hop-b { 0%,100% { transform: none; } 35% { transform: translateY(-12px) scale(.95,1.06); } 70% { transform: translateY(0) scale(1.07,.93); } }
.ob-hop-a { animation: ob-hop-a .5s cubic-bezier(.32,.72,0,1); }
.ob-hop-b { animation: ob-hop-b .5s cubic-bezier(.32,.72,0,1); }
@keyframes ob-page { 0% { opacity: 0; transform: translateX(40px); } 100% { opacity: 1; transform: none; } }
.ob-page { animation: ob-page .45s cubic-bezier(.32,.72,0,1) both; }
@keyframes ob-spin { to { transform: rotate(360deg); } }
.ob-spin { animation: ob-spin .9s linear infinite; transform-origin: center; }
.ob-choice { transition: background .15s ease, border-color .15s ease, transform .1s ease; }
.ob-choice:hover { border-color: rgb(28 28 28 / .32); }
.ob-choice[aria-pressed="true"], .ob-choice[aria-pressed="true"]:hover { border-color: transparent; }
.ob-slide > .ob-choice[aria-pressed="true"] { background: transparent; }
.ob-choice:active { transform: scale(.98); }
@media (prefers-reduced-motion: reduce) {
  .ob-pop, .ob-hop-a, .ob-hop-b, .ob-page, .ob-spin { animation: none; }
  .ob-choice { transition: none; }
  .ob-choice:active { transform: none; }
}`;

const ICON = {
  found: "M4 5h16v11H4zM2 20h20",
  claude: "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z",
  chatgpt: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12h8",
  grok: "M5 4l14 16M19 4 5 20",
  key: "M15 7a4 4 0 1 1-3.9 5H4v3h3v-3h4.1A4 4 0 0 1 15 7z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
};

/** The providers "I have an API key" offers, in the design's order. */
const KEY_PROVIDERS: ModelProvider[] = ["anthropic", "openai", "openrouter", "google", "xai"];

/** The harnesses a connection is tried on, best first: the one the provider makes, then the open ones. */
const PREFERRED = ["claude-code", "codex", "hermes", "opencode", "goose"];

/** The best harness for a provider and kind of connection, from the shared support table. */
export function harnessFor(provider: ModelProvider, kind: "oauth" | "key", support: Parameters<typeof canUse>[0]): string {
  const own = MODEL_PROVIDER_INFO[provider].signIn?.[0]?.harness;
  if (kind === "oauth" && own) return own;
  return PREFERRED.find((h) => canUse(support, h, { provider, kind }) && support.length) ?? own ?? "hermes";
}

/** What's already set to go on the person's computer, best first: a connection Wisp keeps, then a harness signed in there. */
export function foundOn(device: DeviceInfo | undefined, connections: ModelConnection[]): { harness: string; connectionId: string | null; share?: boolean } | null {
  for (const h of ["claude-code", "codex"]) {
    const c = readyConnection(h, connections);
    if (c) return { harness: h, connectionId: c.id };
  }
  const signedIn = (id: string) => device?.harnesses?.find((x) => x.id === id)?.accounts?.default === true;
  if (signedIn("claude-code")) return { harness: "claude-code", connectionId: null };
  // Codex's own sign-in is shared with Wisp ("Use this sign-in"), so it works on every computer
  if (signedIn("codex")) return { harness: "codex", connectionId: null, share: true };
  for (const h of HARNESSES) if (h.protocol !== "mcp" && signedIn(h.id)) return { harness: h.id, connectionId: null };
  return null;
}

/** "Juno", her look and what she's for: page 4's draft, else the first agent's defaults. */
export function draftOf(workspaceId: string): { name: string; look: GhostAppearance; draft: AgentDraft | null } {
  const raw = (loadAnswers(workspaceId) as { agentDraft?: Partial<AgentDraft> }).agentDraft;
  const draft = raw && typeof raw === "object" && typeof raw.name === "string" && raw.name.trim() ? (raw as AgentDraft) : null;
  const look: GhostAppearance = { ...WHITE_WISP, color: "#8bd4ff", color2: "#ff51bf" };
  if (draft?.color) Object.assign(look, { color: draft.color, color2: undefined });
  if (draft?.shape) look.shape = draft.shape;
  return { name: draft?.name.trim() || "Atlas", look, draft };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Pick = "found" | "claude" | "chatgpt" | "grok" | "key" | `h:${string}`;
type Phase = "idle" | "checking" | "ready" | "failed";

/**
 * Page 5 of the first run: what the agent thinks with. What's already signed in on the person's
 * computer is found and picked; a subscription signs in once to Wisp (Claude pastes a code, ChatGPT
 * through Codex, Grok through Hermes); a key becomes a model connection. Any pick makes the agent
 * from page 4's draft (or updates the one made before) and checks it can answer before Continue.
 */
export function AIStep({ device, person, onDone, onBack }: { device: DeviceInfo | undefined; person: string; onDone: (agentId: string | null, channelId: string | null) => void; onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const ws = me.workspace.id;
  const { connections, support, reload } = useConnections();
  const [{ name, look, draft }] = useState(() => draftOf(ws));
  const narrow = useNarrow("(max-width: 1023px)");
  const first = person.trim().split(/\s+/)[0] ?? "";
  const found = foundOn(device, connections ?? []);
  const [pick, setPick] = useState<Pick | null>(null);
  // what is found on the computer is picked for you; otherwise nothing starts until you pick
  const cur: Pick | null = pick ?? (found ? "found" : null);
  const [keyFor, setKeyFor] = useState<ModelProvider>("openrouter");
  const [more, setMore] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [harness, setHarness] = useState(found?.harness ?? "claude-code");
  const [problem, setProblem] = useState<string | null>(null);
  // its AI said "signed in" but its first run couldn't sign in (an expired session): sign in again
  const [resign, setResign] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(() => loadAnswers(ws).agentId ?? null);
  const [leaving, setLeaving] = useState(false);
  // the three live steps while it's tried: signing in, trying a hello, ready
  const [stage, setStage] = useState<"signin" | "hello" | "ready">("signin");
  // its real hello, typed in beside the host once it's said
  const [hello, setHello] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ Dialog: ComponentType<Parameters<typeof HarnessSignInDialog>[0]>; device: HarnessesResponse["device"]; settings: HarnessSettings } | null>(null);
  const run = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const bump = (kind: "hop" | "nod" = "nod") => hostReact(kind);

  /** Make (or point) the agent at this AI, then wait until it can answer. */
  const tryIt = async (h: string, connectionId: string | null) => {
    if (!device) return setProblem("Waiting for a computer to connect.");
    const n = ++run.current;
    const live = () => alive.current && run.current === n;
    setHarness(h);
    setPhase("checking");
    setStage("signin");
    setHello(null);
    setProblem(null);
    setResign(null);
    bump();
    const needsSignIn = () => {
      const e = new Error(`${harnessLabel(h)} on ${device.mine ? here : device.name} needs signing in again.`);
      (e as Error & { resign?: string }).resign = h;
      return e;
    };
    try {
      const st = useStore.getState();
      const existing = agentId ? st.agents.find((a) => a.id === agentId) : undefined;
      let agent: Agent;
      if (existing) {
        await api("PATCH", `/api/agents/${existing.id}`, { harness: h, settings: { connectionId } });
        agent = { ...existing, harness: h as Agent["harness"] };
      } else {
        agent = await makeFirstAgent(device, h, name, st.agents, st.computers, look, connectionId ?? undefined, { greetLater: true });
        saveAnswers(ws, { agentId: agent.id });
        setAgentId(agent.id);
      }
      if (draft) await api("PATCH", `/api/agents/${agent.id}`, { instructions: draft.instructions ?? "", settings: { role: draft.role || undefined } }).catch(() => {});
      await Promise.allSettled([st.refreshAgents(), st.refreshComputers()]);
      // the same check setup always used: its AI answers where it runs, with no sign-in of its own left to do
      const deadline = Date.now() + 3 * 60_000;
      while (live() && Date.now() < deadline) {
        const r = await api<{ signedIn: boolean | null; inComputer?: boolean }>("GET", `/api/agents/${agent.id}/harness`).catch(() => null);
        if (r && (r.signedIn === true || (r.signedIn === null && !connectionId && !r.inComputer))) {
          // a status check can say "signed in" for a session that can't refresh: its hello is the real
          // first run, and only a hello it wrote (or Wisp's, if it ran out of time) means it's ready
          setStage("hello");
          while (live() && Date.now() < deadline) {
            // signed out since (its run failed on sign-in): sign in again before anything else runs
            const now = await api<{ signedIn: boolean | null }>("GET", `/api/agents/${agent.id}/harness`).catch(() => null);
            if (now?.signedIn === false) throw needsSignIn();
            const g = await api<{ status: string }>("POST", `/api/agents/${agent.id}/greet`).catch(() => null);
            if (g?.status === "signin") throw needsSignIn();
            if (g?.status === "already" || g?.status === "sent") {
              if (!live()) return;
              setStage("ready");
              setPhase("ready");
              bump("hop");
              void readHello(agent.id).then((text) => live() && setHello(text));
              return;
            }
            await wait(1500);
          }
          break;
        }
        if (r?.signedIn === false) throw new Error(`${harnessLabel(h)} isn't signed in on ${device.name} yet.`);
        await wait(2000);
      }
      if (live()) throw new Error(`${harnessLabel(h)} took too long to start.`);
    } catch (e) {
      if (!live()) return;
      const re = (e as { resign?: string }).resign;
      setResign(re ?? null);
      setProblem(re ? (e as Error).message : unavailable(e, harnessLabel(h)));
      setPhase("failed");
    }
  };

  /** The hello it just said, from its chat (null if it can't be read yet). */
  const readHello = async (id: string): Promise<string | null> => {
    await useStore.getState().refreshAgents().catch(() => {});
    const setup = useStore.getState().agents.find((a) => a.id === id)?.settings.setup;
    if (!setup?.channelId || !setup.greetingId) return null;
    const r = await api<{ messages: Message[] }>("GET", `/api/channels/${setup.channelId}/messages?limit=20`).catch(() => null);
    const text = r?.messages.find((m) => m.id === setup.greetingId)?.body.trim();
    return text ? (text.length > 280 ? `${text.slice(0, 277).trimEnd()}…` : text) : null;
  };

  /** Sign in again where this AI signs in: Claude and ChatGPT through Wisp, the rest on the computer. */
  const signInAgain = (h: string) => (h === "claude-code" ? choose("claude") : h === "codex" ? choose("chatgpt") : void deviceHarness(h));

  const takeFound = async () => {
    if (!found || !device) return;
    if (!found.share) return void tryIt(found.harness, found.connectionId);
    setPhase("checking");
    setHarness(found.harness);
    try {
      const c = await api<ModelConnection>("POST", "/api/model-connections/import", { provider: signInProvider(found.harness), nodeId: device.id });
      reload();
      void tryIt(found.harness, c.id);
    } catch {
      // can't share it: use it where it is
      void tryIt(found.harness, null);
    }
  };

  const choose = (p: Pick) => {
    run.current++;
    setPick(p);
    setPhase("idle");
    setProblem(null);
    bump();
    if (p === "found") void takeFound();
  };

  /** A harness from "More agents" that keeps its sign-in where it runs: install, then its own sign-in. */
  const deviceHarness = async (id: string) => {
    choose(`h:${id}`);
    if (!device) return;
    const signedIn = device.harnesses?.find((x) => x.id === id)?.accounts?.default === true;
    if (signedIn) return void tryIt(id, null);
    try {
      if (!device.harnesses?.some((x) => x.id === id)) {
        setPhase("checking");
        setHarness(id);
        await api("POST", `/api/nodes/${device.id}/install`, { harness: id });
        await api("POST", `/api/nodes/${device.id}/refresh`).catch(() => {});
        setPhase("idle");
      }
      const r = await api<HarnessesResponse>("GET", `/api/nodes/${device.id}/harness-settings?harness=${encodeURIComponent(id)}`);
      const s = r.harnesses.find((h) => h.harness === id);
      if (!s) throw new Error(`${harnessLabel(id)} isn't on ${device.name} yet`);
      const { HarnessSignIn } = await import("../settings/harnesses.tsx");
      setDialog({ Dialog: HarnessSignIn, device: r.device, settings: s });
    } catch (e) {
      setProblem(unavailable(e, harnessLabel(id)));
      setPhase("failed");
    }
  };

  const proceed = async () => {
    if (phase === "idle") {
      if (cur === "found") return void takeFound();
      // no computer yet: go on without an agent (it can be made later)
      if (!device) return onDone(agentId, null);
      return;
    }
    if (phase === "checking") return;
    setLeaving(true);
    let channelId: string | null = null;
    if (agentId && phase === "ready") {
      // its hello comes now, in its chat
      await api("POST", `/api/agents/${agentId}/greet`).catch(() => {});
      for (let i = 0; i < 8 && alive.current; i++) {
        await useStore.getState().refreshChannels().catch(() => {});
        channelId = useStore.getState().channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agentId}`))?.id ?? null;
        if (channelId) break;
        await wait(1000);
      }
    }
    // what onboarding switches on by itself (calls, routines, a morning plan), each undoable on Here's your Wisp
    if (agentId && phase === "ready") await switchOnRecommended(ws, agentId, person).catch(() => undefined);
    if (alive.current) onDone(agentId, channelId);
  };

  const here = /mac/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "") && device?.mine ? "this Mac" : "this computer";
  const opts: { id: Pick; title: string; sub: string; icon: string; found?: boolean; harness: string }[] = [
    ...(found
      ? [{ id: "found" as const, title: harnessLabel(found.harness), sub: found.connectionId ? "Already connected to Wisp." : found.harness === "claude-code" ? `Signed in on ${here}. Uses your Claude plan.` : `Signed in on ${here}.`, icon: ICON.found, found: true, harness: found.harness }]
      : []),
    // Claude's sign-in runs `claude setup-token` in a terminal on the device, which Windows can't do yet
    { id: "claude", title: "Claude subscription", sub: device?.capabilities?.platform === "win32" ? "Needs a Mac or Linux computer for now. On Windows, use an API key." : "Pro or Max. Sign in, then paste the code it shows.", icon: ICON.claude, harness: "claude-code" },
    { id: "chatgpt", title: "ChatGPT subscription", sub: "Plus or higher. Sign in with ChatGPT.", icon: ICON.chatgpt, harness: "codex" },
    { id: "grok", title: "Grok subscription", sub: "Sign in with your Grok account.", icon: ICON.grok, harness: "hermes" },
    { id: "key", title: "I have an API key", sub: "Claude, OpenAI, OpenRouter, Gemini or Grok.", icon: ICON.key, harness: harnessFor(keyFor, "key", support) },
  ];
  const others = HARNESSES.filter((h) => h.protocol !== "mcp");
  const list = useRef<HTMLDivElement>(null);
  const signInOf: Partial<Record<Pick, ModelProvider>> = { claude: "anthropic", chatgpt: "openai", grok: "xai" };
  const provider = cur ? signInOf[cur] : undefined;
  const cta = phase === "ready" ? `Meet ${name}` : phase === "failed" ? "Continue" : cur === "found" ? "Use this" : "Continue";
  const idleNote = phase === "idle";

  return (
    <div className="fixed inset-0 z-10 flex flex-col bg-panel text-ink text-[14px] leading-[22px]">
      <style>{STYLE}</style>
      <PageTop step={4} onBack={onBack} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="ob-stagger min-h-full grid grid-cols-1 lg:grid-cols-[minmax(0,560px)_minmax(0,400px)] gap-10 lg:gap-20 justify-center items-center px-4 sm:px-6 pt-4 pb-10">
          <div className="flex flex-col gap-[18px] min-w-0">
            <div className="flex flex-col gap-0.5">
              <h1 className="text-[24px] leading-[30px] font-[650] tracking-[-0.015em]">What should {name} think with?</h1>
              <p className="text-[15px] leading-[22px] text-muted">Sign in once. Every agent you make can use it.</p>
            </div>

            <div ref={list} className="ob-slide" style={{ "--ob-slide-r": "14px" } as CSSProperties} role="radiogroup" aria-label="What it thinks with">
              <SlideMark list={list} pick={`${cur}${more}`} />
              {opts.map((o) => (
                <Choice key={o.id} on={cur === o.id} title={o.title} sub={o.sub} icon={o.icon} badge={o.found ? `Found on ${here}` : undefined} onClick={() => choose(o.id)} />
              ))}
              {more &&
                others.map((h) => {
                  const there = device?.harnesses?.find((x) => x.id === h.id);
                  const sub = !there ? "Wisp installs it" : there.accounts?.default === true ? `Signed in on ${device?.name ?? "this computer"}` : there.accounts?.default === false ? "Not signed in yet" : `On ${device?.name ?? "this computer"}`;
                  return <Choice key={h.id} on={cur === `h:${h.id}`} title={h.label} sub={sub} icon={ICON.more} onClick={() => void deviceHarness(h.id)} />;
                })}
            </div>

            {provider && idleNote && (
              <div className="ob-pop flex flex-col gap-2 p-[14px_16px] rounded-[14px] bg-[var(--card)]">
                {provider === "anthropic" && <span className="text-[13px] leading-[18px]">Sign in on the page that just opened. When it shows a code, paste it here.</span>}
                <ConnectModel key={provider} provider={provider} onDone={(cid) => (reload(), void tryIt(opts.find((o) => o.id === cur)!.harness, cid))} />
              </div>
            )}

            {cur === "key" && idleNote && (
              <KeyBox provider={keyFor} setProvider={setKeyFor} onSaved={(cid) => (reload(), void tryIt(harnessFor(keyFor, "key", support), cid))} />
            )}

            {!device && <p className="text-[13px] text-muted">Waiting for a computer to connect…</p>}

            <div className="flex flex-wrap gap-x-1 gap-y-2 items-center">
              <button type="button" disabled={leaving || phase === "checking" || (phase === "idle" && cur !== "found" && !!device)} onClick={() => void proceed()} className="setup-press h-11 px-[22px] rounded-full bg-ink text-panel font-semibold disabled:opacity-40">
                {leaving ? "Opening…" : cta}
              </button>
              {!more && (
                <button type="button" onClick={() => setMore(true)} className="h-11 px-3.5 rounded-full text-muted hover:text-ink whitespace-nowrap">
                  More agents ({others.length})
                </button>
              )}
              {/* nothing working yet: no one is stuck here; it can be set up later in Settings */}
              {phase !== "ready" && phase !== "checking" && cur !== "found" && (
                <button type="button" disabled={leaving} onClick={() => onDone(agentId, null)} className="h-11 px-3.5 rounded-full text-muted hover:text-ink whitespace-nowrap">
                  Set up later
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-col items-center gap-5 min-w-0">
            <HostGhost look={draft ? look : HOST_LOOK} size={narrow ? 88 : 140} mood={phase === "checking" ? "working" : "awake"} happy={phase === "ready"} talking={phase === "ready" && hello === null} />
            <div className="w-full max-w-[400px] min-h-[120px] flex flex-col gap-3 items-center text-center" aria-live="polite">
              {phase === "idle" && <span className="text-muted">Pick one and I'll try it right away.</span>}
              {(phase === "checking" || phase === "ready") && (
                <ol className="ob-steps self-center text-left" aria-label="Trying it">
                  <LiveStep state={stage === "signin" ? "now" : "done"}>Signing in to {harnessLabel(harness)}</LiveStep>
                  <LiveStep state={stage === "signin" ? "later" : stage === "hello" ? "now" : "done"}>Trying a hello</LiveStep>
                  <LiveStep state={stage === "ready" ? "done" : "later"}>Ready</LiveStep>
                </ol>
              )}
              {phase === "ready" && (
                <span className="ob-pop bg-[var(--card)] rounded-[18px] px-3.5 py-[9px] text-left">
                  <Typed text={hello ?? `I can think. Running on ${harnessLabel(harness)}. Ready when you are${first ? `, ${first}` : ""}.`} />
                </span>
              )}
              {phase === "failed" && (
                <>
                  <span role="alert" className="ob-pop text-left">
                    {problem ?? "That didn't work."}
                  </span>
                  {resign ? (
                    <button type="button" className="h-9 px-4 rounded-full bg-ink text-panel text-[13px] font-semibold" onClick={() => signInAgain(resign)}>
                      Sign in again
                    </button>
                  ) : (
                    <button type="button" className="h-9 px-4 rounded-full border border-[var(--line2)] text-[13px] font-medium hover:bg-hover" onClick={() => (cur === "found" ? void takeFound() : cur?.startsWith("h:") ? void deviceHarness(cur.slice(2)) : cur && choose(cur))}>
                      Try again
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      {dialog && (
        <dialog.Dialog
          device={dialog.device}
          settings={dialog.settings}
          account={dialog.settings.accounts.find((a) => a.isDefault) ?? dialog.settings.accounts[0]}
          onClose={() => setDialog(null)}
          onDone={() => {
            const id = dialog.settings.harness;
            setDialog(null);
            void tryIt(id, null);
          }}
        />
      )}
    </div>
  );
}

/** One of the three live steps: a dot before it, a spinner while it runs, a check that draws when it's done. */
function LiveStep({ state, children }: { state: "later" | "now" | "done"; children: ReactNode }) {
  return (
    <li data-state={state}>
      <span className="w-4 h-4 shrink-0 grid place-items-center">
        {state === "done" ? (
          <DrawnCheck size={15} />
        ) : state === "now" ? (
          <svg className="ob-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
            <path d="M12 3a9 9 0 1 1-9 9" />
          </svg>
        ) : (
          <span className="block w-1.5 h-1.5 rounded-full bg-[var(--input)]" />
        )}
      </span>
      {children}
    </li>
  );
}

function Choice({ on, title, sub, icon, badge, onClick }: { on: boolean; title: string; sub: string; icon: string; badge?: string; onClick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-pressed={on} onClick={onClick} className="ob-choice flex items-center gap-3.5 px-4 py-3 rounded-[14px] border border-[var(--line2)] bg-panel text-ink text-left">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 opacity-75">
        <path d={icon} />
      </svg>
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="flex items-center gap-2 font-semibold leading-5 flex-wrap">
          {title}
          {badge && (
            <span className="h-5 px-2 rounded-[10px] text-[11px] font-semibold flex items-center" style={{ background: "rgb(169 139 245 / .18)" }}>
              {badge}
            </span>
          )}
        </span>
        <span className="text-[13px] leading-[18px] text-muted">{sub}</span>
      </span>
      <span aria-hidden className="w-[18px] h-[18px] rounded-full shrink-0 flex items-center justify-center border" style={{ background: on ? "var(--ink)" : "transparent", borderColor: on ? "var(--ink)" : "var(--input)" }}>
        {on && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--panel)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12 5 5 9-10" />
          </svg>
        )}
      </span>
    </button>
  );
}

/** "I have an API key": which provider, the key, and where to get one. Saved as a model connection. */
function KeyBox({ provider, setProvider, onSaved }: { provider: ModelProvider; setProvider: (p: ModelProvider) => void; onSaved: (connectionId: string) => void }) {
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
      setKey("");
      onSaved(c.id);
    } catch (err) {
      const m = (err as Error).message.replace(/^key: /, "");
      setError(m.charAt(0).toUpperCase() + m.slice(1));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="ob-pop flex flex-col gap-2 p-[14px_16px] rounded-[14px] bg-[var(--card)]">
      <div className="flex gap-1.5 flex-wrap">
        {KEY_PROVIDERS.map((p) => (
          <button key={p} type="button" aria-pressed={p === provider} onClick={() => (setProvider(p), setError(null))} className="ob-choice h-[30px] px-3 rounded-[15px] border border-[var(--line2)] bg-panel text-ink text-[13px]">
            {MODEL_PROVIDER_INFO[p].label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <label htmlFor="ob-key" className="sr-only">
          API key
        </label>
        <input
          id="ob-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => (setKey(e.target.value), setError(null))}
          placeholder={`Paste your ${info.label} key`}
          className="flex-1 min-w-0 h-10 px-4 rounded-full border border-[var(--input)] bg-panel text-ink outline-none focus:border-ink"
        />
        <button type="submit" disabled={busy || !key.trim()} className="setup-press h-10 px-4 rounded-full bg-ink text-panel font-semibold disabled:opacity-40">
          {busy ? "Checking…" : "Save"}
        </button>
      </div>
      {error && <span className="text-[12px] leading-4 text-bad">{error}</span>}
      <span className="text-[12px] leading-4 text-muted">
        Kept on your Wisp only. Get one at the{" "}
        <a href={info.keyUrl} target="_blank" rel="noreferrer" className="underline hover:text-ink">
          {info.label} site
        </a>
        .
      </span>
    </form>
  );
}
