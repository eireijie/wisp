import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, Check, Loader2, ChevronLeft, MessageSquare, Monitor, Plug, Server, Smartphone, Sparkles, Users, Bot } from "lucide-react";
import type { Agent, MessagePart } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { go } from "../router.ts";
import { renderMarkdown } from "../markdown.ts";
import { setDismissed, useOnboarding, type OnboardingState, type StepId } from "../onboarding.ts";
import { useDevices } from "../devices.ts";
import { AgentAvatar, Button, CopyBlock, Field, HARNESS_LABELS, Input, Textarea, cx } from "../components/ui.tsx";

const STEPS: { id: StepId; title: string; blurb: string }[] = [
  { id: "device", title: "Connect a device", blurb: "A computer that runs your agents." },
  { id: "agent", title: "Add your first agent", blurb: "Claude Code, Codex, or anything that speaks MCP." },
  { id: "hello", title: "Say hello", blurb: "@mention it in #general and watch it work." },
  { id: "memory", title: "Explore shared memory", blurb: "See what your agent remembered." },
];

export function WelcomeView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const { state, error, refresh, done } = useOnboarding(3000);
  const firstOpen = STEPS.find((s) => !done[s.id])?.id ?? null;
  // null = follow progress (first unfinished step); "none" = user collapsed everything.
  // A step can pin itself open while the user is mid-way (e.g. watching the agent reply).
  const [open, setOpen] = useState<StepId | "none" | null>(null);
  const [pinned, setPinned] = useState<StepId | null>(null);
  const current = open === "none" ? null : (open ?? pinned ?? firstOpen);
  const toggle = (id: StepId) => {
    setPinned(null);
    setOpen(current === id ? "none" : id);
  };
  const scroller = useRef<HTMLDivElement>(null);
  const count = STEPS.filter((s) => done[s.id]).length;
  const allDone = count === STEPS.length;

  // when a step completes on its own (device connects, agent replies), move on to the next one
  const doneKey = STEPS.map((s) => +done[s.id]).join("");
  useEffect(() => {
    setOpen(null);
  }, [doneKey]);
  useEffect(() => {
    if (allDone && !pinned) scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [allDone, pinned]);

  const leave = () => {
    setDismissed(true);
    go({ view: "chat", channelId: null, threadId: null });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-14 shrink-0 px-3 md:px-5 flex items-center gap-2 border-b border-line safe-top md:hidden">
        {onBack && (
          <button className="p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <span className="font-semibold">Get started</span>
      </header>
      <div ref={scroller} className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 md:px-8 py-8 md:py-12">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-accent bg-accent-soft rounded-full px-2.5 py-1">
              <Sparkles size={13} /> {allDone ? "You're all set" : `${count} of ${STEPS.length} done`}
            </div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">{allDone ? `${me.workspace.name} is ready` : `Welcome to ${me.workspace.name}, ${me.user.name.split(" ")[0]}`}</h1>
            <p className="text-muted">
              {allDone
                ? "Your agents can talk to you and to each other, hand work across devices, and build up memory you can read and edit."
                : "Four short steps to get an agent talking in your workspace. Each one checks itself off when it actually happens."}
            </p>
            <div className="h-1.5 rounded-full bg-hover overflow-hidden" role="progressbar" aria-valuenow={count} aria-valuemin={0} aria-valuemax={STEPS.length}>
              <div className="h-full bg-accent transition-all duration-500" style={{ width: `${(count / STEPS.length) * 100}%` }} />
            </div>
          </div>

          {error && (
            <div role="alert" className="mt-6 rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
              {error}
            </div>
          )}

          <ol className="mt-8 space-y-3">
            {STEPS.map((s, i) => (
              <Step key={s.id} n={i + 1} title={s.title} blurb={s.blurb} done={done[s.id]} open={current === s.id} summary={summary(s.id, state)} onToggle={() => toggle(s.id)}>
                {s.id === "device" && <DeviceStep state={state} onCreated={refresh} />}
                {s.id === "agent" && <AgentStep state={state} onCreated={refresh} onPin={() => setPinned("agent")} />}
                {s.id === "hello" && <HelloStep state={state} onPin={() => setPinned("hello")} />}
                {s.id === "memory" && <MemoryStep state={state} />}
              </Step>
            ))}
          </ol>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            {allDone ? (
              <Button variant="primary" onClick={leave} className="h-10">
                Go to #general <ArrowRight size={16} />
              </Button>
            ) : (
              <button onClick={leave} className="text-sm text-muted hover:text-ink underline underline-offset-4">
                Skip for now. You can come back from the sidebar.
              </button>
            )}
          </div>

          <MoreTips />
        </div>
      </div>
    </div>
  );
}

function summary(id: StepId, s: OnboardingState | null): string | null {
  if (!s) return null;
  if (id === "device") {
    const on = s.devices.filter((d) => d.online);
    return on.length ? `${on.map((d) => d.name).join(", ")} ${on.length === 1 ? "is" : "are"} connected` : null;
  }
  if (id === "agent") return s.agents.length ? s.agents.map((a) => `@${a.handle}`).join(", ") : null;
  if (id === "hello") return s.firstReply ? `@${s.agents.find((a) => a.id === s.firstReply!.agentId)?.handle ?? "your agent"} replied` : null;
  if (id === "memory") return s.memoryNotes.length ? `${s.memoryNotes.length} note${s.memoryNotes.length === 1 ? "" : "s"} written by agents` : null;
  return null;
}

function Step({ n, title, blurb, done, open, summary, onToggle, children }: { n: number; title: string; blurb: string; done: boolean; open: boolean; summary: string | null; onToggle: () => void; children: ReactNode }) {
  return (
    <li className={cx("rounded-2xl border transition-colors", open ? "border-accent/50 bg-panel shadow-sm" : "border-line")}>
      <button onClick={onToggle} className="w-full flex items-center gap-4 px-4 md:px-5 py-4 text-left" aria-expanded={open}>
        <span className={cx("size-8 shrink-0 rounded-full grid place-items-center text-sm font-semibold", done ? "bg-ok/15 text-ok" : open ? "bg-accent text-accent-ink" : "bg-hover text-muted")}>{done ? <Check size={16} strokeWidth={3} /> : n}</span>
        <span className="flex-1 min-w-0">
          <span className={cx("block font-medium", done && !open && "text-muted")}>{title}</span>
          <span className="block text-sm text-muted truncate">{done && summary ? summary : blurb}</span>
        </span>
      </button>
      {open && <div className="px-4 md:px-5 pb-5 md:pl-[4.25rem]">{children}</div>}
    </li>
  );
}

// --- step 1: device -----------------------------------------------------------

function DeviceStep({ state, onCreated }: { state: OnboardingState | null; onCreated: () => void }) {
  const [name, setName] = useState("my-laptop");
  const [created, setCreated] = useState<{ id: string; name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // any device connecting counts, even one set up with a different token
  const live = created && (state?.devices.find((d) => d.id === created.id && d.online) ?? state?.devices.find((d) => d.online));
  const offline = state?.devices.filter((d) => !d.online) ?? [];

  if (created)
    return (
      <div className="space-y-4 text-sm">
        <p>
          On <b>{created.name}</b>, run these in a terminal. It needs Node 22+, git, and <code className="bg-code px-1 rounded">claude</code> or <code className="bg-code px-1 rounded">codex</code> installed and signed in.
        </p>
        <div className="space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">1 · Install Warren's CLI (once, inside the Warren repo)</div>
          <CopyBlock text={"npm install && npm link\nwarren doctor"} />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">2 · Connect</div>
          <CopyBlock text={`warren node start --hub ${location.origin} --token ${created.token} --name "${created.name}"`} />
          <p className="text-xs text-muted">The token is shown once and saved on the device, so next time it's just <code>warren node start</code>.</p>
        </div>
        <div className={cx("flex items-center gap-2 rounded-lg px-3 py-2", live?.online ? "bg-ok/10 text-ok" : "bg-hover text-muted")} role="status">
          {live?.online ? <Check size={16} /> : <Loader2 size={16} className="animate-spin" />}
          {live?.online ? `${live.name} is connected` : `Waiting for ${created.name} to connect…`}
        </div>
      </div>
    );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Agents run on real computers: your laptop, a home server, a VM. The device connects <i>out</i> to Warren, so it works behind routers and firewalls.
      </p>
      {offline.length > 0 && (
        <div className="text-sm rounded-lg bg-hover px-3 py-2">
          {offline.map((d) => d.name).join(", ")} {offline.length === 1 ? "was added but isn't" : "were added but aren't"} running. Start it with <code className="bg-code px-1 rounded">warren node start</code>, or add a new one.
        </div>
      )}
      <form
        className="flex flex-col sm:flex-row gap-2 sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api<{ node: { id: string; name: string }; token: string }>("POST", "/api/nodes", { name });
            setCreated({ ...r.node, token: r.token });
            onCreated();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex-1">
          <Field label="Name this device">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
        </div>
        <Button variant="primary" disabled={busy}>
          <Server size={16} /> Create device
        </Button>
      </form>
      {error && <p className="text-sm text-bad">{error}</p>}
      <p className="text-xs text-muted">
        Already running an agent in its own session? You can skip this and connect it with MCP in the next step.
      </p>
    </div>
  );
}

// --- step 2: agent ------------------------------------------------------------

/** `headless` here means Warren starts it on a device (as opposed to a session joining through MCP). */
const PRESETS: { harness: Agent["harness"]; name: string; note: string; headless: boolean }[] = [
  { harness: "claude-code", name: "Atlas", note: "Wakes up on @mention", headless: true },
  { harness: "codex", name: "Nova", note: "Wakes up on @mention", headless: true },
  { harness: "hermes", name: "Hermes", note: "Wakes up on @mention", headless: true },
  { harness: "gemini", name: "Gem", note: "Wakes up on @mention", headless: true },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32);

function AgentStep({ state, onCreated, onPin }: { state: OnboardingState | null; onCreated: () => void; onPin: () => void }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const [preset, setPreset] = useState(PRESETS[0]);
  const [name, setName] = useState(PRESETS[0].name);
  const devices = state?.devices ?? [];
  const [nodeId, setNodeId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Agent | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const caps = useDevices(5000)?.find((d) => d.id === nodeId)?.capabilities;
  const [computer, setComputer] = useState<"vm" | "screen" | "later" | null>(null);
  const computerChoice = computer ?? (caps?.vm.ok ? "vm" : caps?.screen.ok ? "screen" : "later");

  // default to a connected device
  useEffect(() => {
    if (!nodeId && devices.length) setNodeId((devices.find((d) => d.online) ?? devices[0]).id);
  }, [devices, nodeId]);

  if (created)
    return (
      <div className="space-y-4 text-sm">
        <div className="flex items-center gap-3">
          <AgentAvatar agent={created} size={44} live />
          <div>
            <div className="font-medium">{created.name} is in your workspace</div>
            <div className="text-muted">
              @{created.handle} · {HARNESS_LABELS[created.harness]}
            </div>
          </div>
        </div>
        {!preset.headless && (
          <div className="space-y-2">
            <p>Add Warren to {HARNESS_LABELS[created.harness]}'s MCP servers so the running session can chat, delegate and use memory as @{created.handle}:</p>
            {token ? (
              <CopyBlock text={JSON.stringify({ mcpServers: { warren: { command: "warren-mcp", env: { WARREN_URL: location.origin, WARREN_TOKEN: token } } } }, null, 2)} />
            ) : (
              <Button onClick={async () => setToken((await api<{ token: string }>("POST", `/api/agents/${created.id}/token`)).token)}>
                <Plug size={15} /> Show connection config
              </Button>
            )}
          </div>
        )}
      </div>
    );

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          // every agent gets a computer it can use, unless there's nowhere to put one yet
          const computerId =
            nodeId && computerChoice !== "later"
              ? (await api<{ id: string }>("POST", "/api/computers", computerChoice === "vm" ? { kind: "vm", nodeId, name: `${name}'s desk`, cpus: 2, memoryGb: 4 } : { kind: "device", nodeId })).id
              : null;
          const a = await api<Agent>("POST", "/api/agents", { harness: preset.harness, name, handle: slug(name), nodeId: preset.headless ? nodeId || null : null, computerId });
          useStore.getState().refreshComputers();
          // MCP harnesses still need their connection config, so keep this step open
          if (!preset.headless) onPin();
          await refreshAgents();
          setCreated(a);
          onCreated();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        {PRESETS.map((p) => (
          <button
            type="button"
            key={p.harness}
            onClick={() => {
              if (name === preset.name || !name) setName(p.name);
              setPreset(p);
            }}
            className={cx("rounded-xl border p-3 text-left flex items-center gap-2.5", preset.harness === p.harness ? "border-accent bg-accent-soft" : "border-line hover:bg-hover")}
            aria-pressed={preset.harness === p.harness}
          >
            <AgentAvatar agent={{ harness: p.harness, name: p.name }} size={28} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{HARNESS_LABELS[p.harness]}</span>
              <span className="block text-[11px] text-muted">{p.note}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Name" hint={name ? `Mention it as @${slug(name)}` : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        {preset.headless && (
          <Field label="Runs on">
            <select value={nodeId} onChange={(e) => setNodeId(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
              <option value="">Decide later</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} {d.online ? "(connected)" : "(offline)"}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {preset.headless && !!nodeId && (
        <Field label="Its computer" hint="Where it opens apps and websites. You can watch it and take over anytime.">
          <select value={computerChoice} onChange={(e) => setComputer(e.target.value as "vm" | "screen" | "later")} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
            <option value="vm" disabled={!caps?.vm.ok}>
              A new VM on this device{caps && !caps.vm.ok ? " (needs Docker)" : ""}
            </option>
            <option value="screen" disabled={caps?.screen.ok === false}>
              This device's own screen
            </option>
            <option value="later">Choose later</option>
          </select>
        </Field>
      )}
      {preset.headless && !devices.length && <p className="text-xs text-warn">No device yet. The agent will wait until you connect one in step 1.</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
      <Button variant="primary">
        <Bot size={16} /> Add {name || "agent"}
      </Button>
    </form>
  );
}

// --- step 3: hello ------------------------------------------------------------

function HelloStep({ state, onPin }: { state: OnboardingState | null; onPin: () => void }) {
  const channels = useStore((s) => s.channels);
  const loadChannel = useStore((s) => s.loadChannel);
  const live = useStore((s) => s.live);
  const general = channels.find((c) => c.name === "general");
  const agent = state?.agents.find((a) => a.nodeId) ?? state?.agents[0];
  const [text, setText] = useState("");
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messages = useStore((s) => (general ? s.messages[general.id] : undefined));

  useEffect(() => {
    if (agent && !text) setText(`@${agent.handle} Hi! Introduce yourself in two sentences, then save a short note about what you're good at to your memory as me/strengths.md.`);
  }, [agent, text]);
  useEffect(() => {
    if (general) loadChannel(general.id);
  }, [general, loadChannel]);

  const reply = useMemo(() => (sentAt && agent ? messages?.find((m) => m.author.kind === "agent" && m.author.id === agent.id && m.createdAt >= sentAt) : undefined), [messages, sentAt, agent]);
  const running = agent ? Object.values(live).find((r) => r.agentId === agent.id) : undefined;
  const html = useMemo(() => (reply ? renderMarkdown(reply.body) : ""), [reply]);

  if (!agent) return <p className="text-sm text-muted">Add an agent first, then come back here.</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Agents wake up when they're @mentioned. They read the recent conversation, can use their memory, and can bring in other agents the same way.
      </p>
      {agent.status === "offline" && <p className="text-sm text-warn">@{agent.handle} is offline right now, so it'll answer once its device connects.</p>}
      {!sentAt ? (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!general) return;
            setError(null);
            try {
              const m = await api<{ createdAt: string }>("POST", `/api/channels/${general.id}/messages`, { body: text });
              onPin(); // stay here to watch the reply arrive
              setSentAt(m.createdAt);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="First message" />
          {error && <p className="text-sm text-bad">{error}</p>}
          <Button variant="primary" disabled={!text.trim()}>
            <MessageSquare size={16} /> Send to #general
          </Button>
        </form>
      ) : (
        <div className="rounded-xl border border-line p-4 flex gap-3" role="status" aria-live="polite">
          <AgentAvatar agent={agent} live />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium flex items-center gap-2">
              {agent.name}
              {!reply && <Loader2 size={13} className="animate-spin text-muted" />}
              {!reply && <span className="text-xs text-muted font-normal">{running?.tools.length ? `using ${running.tools.at(-1)!.replace(/^mcp__warren__/, "")}` : agent.status === "offline" ? "waiting for its device" : "thinking"}</span>}
            </div>
            {reply ? (
              reply.body ? <div className="prose-w text-[15px]" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="text-sm text-bad">{failureText(reply.parts)}</p>
            ) : (
              running?.text && <p className="text-sm text-muted line-clamp-3">{running.text}</p>
            )}
          </div>
        </div>
      )}
      {sentAt && general && (
        <Button variant="ghost" onClick={() => go({ view: "chat", channelId: general.id, threadId: null })}>
          Open #general <ArrowRight size={15} />
        </Button>
      )}
    </div>
  );
}

function failureText(parts: MessagePart[]): string {
  const status = parts.find((p) => p.type === "status");
  return status?.type === "status" ? status.text : "Something went wrong.";
}

// --- step 4: memory -----------------------------------------------------------

function MemoryStep({ state }: { state: OnboardingState | null }) {
  const notes = state?.memoryNotes ?? [];
  // agents/<id>/x.md reads better as @handle/x.md
  const pretty = (p: string) => p.replace(/^agents\/([^/]+)\//, (m, id: string) => {
    const a = state?.agents.find((x) => x.id === id);
    return a ? `@${a.handle}/` : m;
  });
  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted">
        The memory vault is a folder of markdown notes with <code className="bg-code px-1 rounded">[[links]]</code>, like Obsidian. Each agent has a private folder, everyone shares <b>Shared</b>, and every edit is saved in history.
      </p>
      {notes.length ? (
        <div className="rounded-xl border border-line divide-y divide-line">
          {notes.map((n) => (
            <button key={n.path} onClick={() => go({ view: "vault", path: n.path })} className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-hover">
              <BookOpen size={15} className="text-accent shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium truncate">{n.title}</span>
                <span className="block text-xs text-muted truncate">{pretty(n.path)}</span>
              </span>
              <ArrowRight size={14} className="text-faint" />
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-lg bg-hover px-3 py-2 text-muted">No agent has written a note yet. This step checks off when one does (the hello message in step 3 asks for one).</p>
      )}
      <Button onClick={() => go({ view: "vault", path: null })}>
        <BookOpen size={15} /> Open the vault
      </Button>
    </div>
  );
}

// --- extras -------------------------------------------------------------------

function MoreTips() {
  return (
    <section className="mt-12 space-y-3">
      <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">When you're ready</h2>
      <div className="grid sm:grid-cols-2 gap-3">
        <Tip icon={<Smartphone size={17} />} title="Install on your phone">
          iPhone: open this page in Safari → Share → <b>Add to Home Screen</b>. Android: Chrome menu → <b>Install app</b>.
        </Tip>
        <Tip icon={<Monitor size={17} />} title="Install on your computer">
          In Chrome or Edge, click the install icon in the address bar to run Warren in its own window.
        </Tip>
        <Tip icon={<Users size={17} />} title="Bring in your team" onClick={() => go({ view: "settings" })}>
          Add people and choose which agents can read each other's memory.
        </Tip>
        <Tip icon={<Bot size={17} />} title="Add more agents" onClick={() => go({ view: "agents", agentId: null })}>
          Give each one a job in its instructions. They can @mention each other and delegate tasks.
        </Tip>
      </div>
    </section>
  );
}

function Tip({ icon, title, children, onClick }: { icon: ReactNode; title: string; children: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <div className="size-8 rounded-lg bg-accent-soft text-accent grid place-items-center shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="font-medium text-sm flex items-center gap-1">
          {title} {onClick && <ArrowRight size={13} className="text-faint" />}
        </div>
        <div className="text-sm text-muted">{children}</div>
      </div>
    </>
  );
  const cls = "rounded-xl border border-line p-4 flex gap-3 text-left";
  return onClick ? (
    <button onClick={onClick} className={cx(cls, "hover:bg-hover")}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

