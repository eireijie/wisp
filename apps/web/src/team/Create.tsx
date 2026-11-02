import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { ArrowRight, ChevronLeft, Hash, LayoutGrid, Loader2, Lock, PenLine, Sparkles, Workflow } from "lucide-react";
import { TEAM_TEMPLATES, MIN_TEAM_AGENTS, teamProblem, teamSizeProblem, type Agent, type ChannelTeam, type FlowLine, type Section, type TeamDraft, type TeamTemplate } from "@wisp/core";
import { api } from "../api.ts";
import { go } from "../router.ts";
import { useStore } from "../store.ts";
import { AgentAvatar, Button, Modal, cx } from "../components/ui.tsx";
import { MoreOptions } from "../components/MoreOptions.tsx";
import { EMPTY_TEAM, TeamChart, TeamRules, addToTeam } from "../components/TeamChart.tsx";
import { Toggle } from "../views/settings/parts.tsx";
import { TeamBuilder } from "./Builder.tsx";
import { HowLines, MiniChart, useFlowLines } from "./How.tsx";
import { NewAgentForTeam } from "./NewAgent.tsx";
import { TemplateBrowser } from "./Templates.tsx";
import { TeamGhosts } from "./parts.tsx";
import { startNewAgent } from "../components/ChatList.tsx";
import { emptyTeam, fillTemplate, stepProblems, teamAgentIds, teamFromSteps, withChart } from "./flow.ts";

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

type Page = "name" | "start" | "templates" | "describe" | "builder" | "review" | "chart";

/** Shown wherever a team can't be made yet for want of agents. */
const NEEDS_AGENTS = `Pick at least ${MIN_TEAM_AGENTS} agents`;

const TRIES = ["One builds, one reviews", "Research, then I approve", "Triage, reply, check"];

/**
 * Making a team: its name, how it starts (from scratch, a template, or an agent builds it), the
 * flowchart, and a last look before it is created.
 */
export function NewTeamFlow({ onClose, sectionId = null, onBrowse, SectionPick, initialName = "" }: { onClose: () => void; sectionId?: string | null; onBrowse: () => void; SectionPick: ComponentType<{ sections: Section[]; value: string | null; onChange: (v: string | null) => void }>; initialName?: string }) {
  const channels = useStore((s) => s.channels).filter((c) => c.kind === "channel");
  const sections = useStore((s) => s.sections);
  const agents = useStore((s) => s.agents);
  const refreshChannels = useStore((s) => s.refreshChannels);
  const [page, setPage] = useState<Page>("name");
  const [name, setName] = useState(initialName);
  const [topic, setTopic] = useState("");
  const [section, setSection] = useState<string | null>(sectionId);
  const [isPrivate, setPrivate] = useState(false);
  const [team, setTeam] = useState<ChannelTeam>(emptyTeam);
  const [chart, setChart] = useState<ChannelTeam>(EMPTY_TEAM);
  const [from, setFrom] = useState<Page>("start");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState(false);
  const id = slug(name);
  const exists = channels.some((c) => c.name === id);
  const needMore = agents.length < MIN_TEAM_AGENTS;
  const valid = !!id && !exists && !needMore;

  async function create(settingsTeam: ChannelTeam | null) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const settings = { replyInThread: true, ...(settingsTeam ? { team: settingsTeam } : {}) };
      const ch = await api<{ id: string }>("POST", "/api/channels", { name: id, topic, sectionId: section, private: isPrivate, settings });
      await refreshChannels();
      onClose();
      go({ view: "chat", channelId: ch.id, threadId: null });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const createStepped = () => void create(withChart({ ...team, roles: team.roles ?? [] }));

  if (newAgent)
    return (
      <NewAgentForTeam
        onClose={() => setNewAgent(false)}
        onCreated={(a: Agent) => {
          setChart((t) => addToTeam(t, a.id));
          setNewAgent(false);
        }}
      />
    );

  if (page === "name")
    return (
      <Modal title="New team" onClose={onClose} className="sm:max-w-[600px]!">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) setPage("start");
          }}
        >
          <p className="text-sm text-muted">Step 1 of 2 · Name and description</p>
          {needMore && (
            <div role="status" className="rounded-xl bg-card p-4 text-sm">
              <p>
                A team needs at least {MIN_TEAM_AGENTS} agents, and you have {agents.length === 0 ? "none" : agents.length}.
              </p>
              <button
                type="button"
                className="mt-1 text-accent-text hover:underline"
                onClick={() => {
                  onClose();
                  startNewAgent();
                }}
              >
                Make {agents.length === 0 ? "an agent" : "another agent"}
              </button>
            </div>
          )}
          <div className="space-y-2.5">
            <div className="rounded-xl border border-line bg-card px-4 py-2.5">
              <label htmlFor="team-name" className="block text-xs text-muted">
                Name
              </label>
              <div className="flex items-center gap-1">
                <Hash size={15} className="text-faint" aria-hidden />
                <input id="team-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="release-crew" autoCapitalize="none" autoCorrect="off" className="w-full bg-transparent text-body outline-none placeholder:text-faint" />
              </div>
            </div>
            {id && (exists || id !== name) && <p className={cx("px-2 text-xs", exists ? "text-bad" : "text-faint")}>{exists ? `#${id} already exists.` : id}</p>}
            <div className="rounded-xl border border-line bg-card px-4 py-2.5">
              <label htmlFor="team-topic" className="block text-xs text-muted">
                What is it for?
              </label>
              <textarea id="team-topic" value={topic} onChange={(e) => setTopic(e.target.value)} rows={2} maxLength={250} placeholder="Ship releases on time, checked before they go out." className="block w-full resize-none bg-transparent text-body outline-none placeholder:text-faint" />
            </div>
            <p className="px-2 text-xs text-faint">Agents on the team read this so they know what the team is for.</p>
          </div>
          <MoreOptions>
            <div className="space-y-3 rounded-2xl bg-card p-4">
              {sections.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">Section</span>
                  <SectionPick sections={sections} value={section} onChange={setSection} />
                </div>
              )}
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className="flex items-center gap-1.5 font-medium">
                    <Lock size={13} /> Private
                  </span>
                  <span className="block text-xs text-muted">Only people and agents you add can see it.</span>
                </span>
                <Toggle on={isPrivate} onChange={setPrivate} label="Private team" />
              </label>
              <button type="button" className="text-sm text-accent-text hover:underline" onClick={onBrowse}>
                Browse existing teams
              </button>
            </div>
          </MoreOptions>
          <div className="flex justify-end gap-2.5">
            <Button type="button" onClick={onClose} className="h-[42px]">
              Cancel
            </Button>
            <Button variant="primary" disabled={!valid} className="h-[42px]">
              Next <ArrowRight size={15} />
            </Button>
          </div>
        </form>
      </Modal>
    );

  if (page === "start")
    return (
      <Modal title="New team" onClose={onClose} className="sm:max-w-[760px]!">
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setPage("name")} aria-label="Back" className="circle circle-sm shrink-0">
              <ChevronLeft size={18} />
            </button>
            <p className="text-sm text-muted">Step 2 of 2</p>
          </div>
          <div>
            <h2 className="t-title">How should {id} work?</h2>
            <p className="mt-1 text-body text-muted">Pick a start. You can change every step later.</p>
          </div>
          <div className="grid gap-3.5 sm:grid-cols-3">
            {[
              { icon: <PenLine size={22} />, title: "Start from scratch", text: "An empty canvas. Draw it your way.", go: () => (setTeam(emptyTeam()), setFrom("start"), setPage("builder")) },
              { icon: <LayoutGrid size={22} />, title: "Browse templates", text: `${TEAM_TEMPLATES.length} ready-made teams.`, go: () => setPage("templates") },
              { icon: <Sparkles size={22} />, title: "Have an agent build it", text: "Say it in one sentence.", go: () => setPage("describe") },
            ].map((c) => (
              <button key={c.title} type="button" onClick={c.go} className="flex flex-col items-start gap-3.5 rounded-xl border border-line bg-card p-4 text-left hover:bg-hover">
                <span className="grid size-[52px] place-items-center rounded-2xl bg-chip text-ink/85">{c.icon}</span>
                <span>
                  <span className="block text-body font-medium">{c.title}</span>
                  <span className="mt-0.5 block text-[14px] text-muted">{c.text}</span>
                </span>
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <MoreOptions>
              <button type="button" className="text-sm text-accent-text hover:underline" onClick={() => (setChart(EMPTY_TEAM), setPage("chart"))}>
                Draw who hands work to whom (a plain chart)
              </button>
            </MoreOptions>
          </div>
        </div>
      </Modal>
    );

  if (page === "templates")
    return (
      <TemplateBrowser
        onClose={() => setPage("start")}
        onUse={(t: TeamTemplate) => {
          setTeam(fillTemplate(t, agents));
          setFrom("templates");
          setPage("builder");
        }}
      />
    );

  if (page === "describe")
    return (
      <Describe
        slug={id}
        onBack={() => setPage("start")}
        busy={busy}
        error={error}
        onCreate={(t) => void create(withChart({ ...t, roles: t.roles ?? [] }))}
        onEdit={(t) => {
          setTeam(t);
          setFrom("describe");
          setPage("builder");
        }}
      />
    );

  if (page === "builder")
    return <TeamBuilder team={team} onChange={setTeam} name={id} doneLabel="Done" saving={false} onBack={() => setPage(from)} onDone={() => setPage("review")} />;

  if (page === "review") return <Review slug={id} topic={topic} team={team} busy={busy} error={error} onBack={() => setPage("builder")} onCreate={createStepped} />;

  // a plain chart of who hands work to whom
  const problem = teamProblem(chart) ?? (teamSizeProblem(chart) && NEEDS_AGENTS);
  return (
    <Modal title={`#${id}: its team`} label={`The team for #${id}`} onClose={onClose} className="sm:max-w-5xl!">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Pick who works in #{id}. Drag agents onto the chart, make one or more of them leads, and draw an arrow from each agent to whoever it hands work to.{" "}
          <button type="button" className="text-accent-text hover:underline" onClick={() => setPage("start")}>
            Use steps instead
          </button>
        </p>
        <TeamChart team={chart} onChange={setChart} onCreateAgent={() => setNewAgent(true)} />
        <details className="rounded-xl bg-bg px-3.5 py-2.5">
          <summary className="cursor-pointer text-sm font-medium">How the team works</summary>
          <TeamRules className="mt-2" />
        </details>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPage("start")}>
            <ChevronLeft size={15} /> Back
          </Button>
          <Button variant="primary" disabled={!!problem || busy} onClick={() => void create(chart)} title={problem ?? undefined}>
            Create #{id}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** "Have an agent build it": one sentence in, the agent's flowchart out, read before anything is created. */
function Describe({ slug: id, onBack, onEdit, onCreate, busy, error }: { slug: string; onBack: () => void; onEdit: (t: ChannelTeam) => void; onCreate: (t: ChannelTeam) => void; busy: boolean; error: string | null }) {
  const agents = useStore((s) => s.agents);
  const [text, setText] = useState("");
  const [builderId, setBuilderId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "working" | "ready" | "failed">("idle");
  const [draft, setDraft] = useState<TeamDraft | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const token = useRef(0);
  useEffect(() => () => void (token.current += 1), []);
  useEffect(() => {
    api<{ lead: string | null }>("GET", "/api/settings/lead")
      .then((r) => setBuilderId((cur) => cur ?? r.lead))
      .catch(() => {});
  }, []);
  const builder: Agent | undefined = agents.find((a) => a.id === builderId) ?? agents[0];
  const team = useMemo(() => (draft?.steps?.length ? teamFromSteps(draft.steps) : null), [draft]);
  const localLines = useFlowLines(team ?? emptyTeam());
  const lines: FlowLine[] = draft?.lines ?? localLines;
  const problem = team ? (draft?.problem ?? stepProblems(team).lines[0] ?? (teamSizeProblem(team) && NEEDS_AGENTS)) : null;

  const build = async () => {
    const mine = ++token.current;
    setPhase("working");
    setFailure(null);
    setDraft(null);
    try {
      let d = await api<TeamDraft>("POST", "/api/team-drafts", { description: text.trim(), ...(builder ? { agentId: builder.id } : {}) });
      while (d.status === "working") {
        await new Promise((r) => setTimeout(r, 1500));
        if (mine !== token.current) return;
        d = await api<TeamDraft>("GET", `/api/team-drafts/${d.id}`);
      }
      if (mine !== token.current) return;
      if (d.status === "ready" && d.steps?.length) {
        setDraft(d);
        setPhase("ready");
      } else {
        setFailure(d.problem ?? "Try saying it another way.");
        setPhase("failed");
      }
    } catch (e) {
      if (mine !== token.current) return;
      setFailure((e as Error).message);
      setPhase("failed");
    }
  };

  return (
    <Modal title="New team" onClose={onBack} className="sm:max-w-[1080px]!">
      <div className="flex flex-col gap-8 lg:min-h-[500px] lg:flex-row">
        <div className="w-full shrink-0 space-y-3 lg:w-[380px]">
          <div>
            <h2 className="t-title">Have an agent build it</h2>
            <p className="mt-0.5 text-sm text-muted">One sentence is enough. You can fix the result.</p>
          </div>
          <div className="rounded-xl border border-line bg-card px-4 py-3">
            <textarea aria-label="Describe how the team works" value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={2000} placeholder="Opus plans, GPT pokes holes until it approves, then Opus hands out the work" autoFocus className="block w-full resize-none bg-transparent text-body leading-snug outline-none placeholder:text-faint" />
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Try">
            {TRIES.map((t) => (
              <button key={t} type="button" onClick={() => setText(t)} className="min-h-9 rounded-full border border-line bg-card px-3.5 text-[13px] hover:bg-hover">
                {t}
              </button>
            ))}
          </div>
          {agents.length === 0 ? (
            <p className="text-sm text-bad">Add an agent first: it draws the team.</p>
          ) : (
            <label className="relative flex items-center gap-3 rounded-xl border border-line bg-card px-4 py-2.5">
              {builder && <AgentAvatar agent={builder} size={30} interactive={false} />}
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-muted">Built by</span>
                <span className="block truncate text-body font-medium">{builder?.name}</span>
              </span>
              <select aria-label="Built by" value={builder?.id ?? ""} onChange={(e) => setBuilderId(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0">
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex gap-2.5 pt-1">
            <Button type="button" onClick={onBack} className="h-[42px]">
              Back
            </Button>
            <Button type="button" variant="primary" onClick={() => void build()} disabled={!text.trim() || !agents.length || phase === "working"} className="h-[42px]">
              <Sparkles size={15} /> {phase === "ready" || phase === "failed" ? "Build again" : "Build it"}
            </Button>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-4" aria-live="polite">
          {phase === "idle" && (
            <div className="grid h-full min-h-48 place-items-center rounded-3xl border border-dashed border-line p-6 text-center text-sm text-muted">
              <div className="space-y-2">
                <Workflow size={28} className="mx-auto text-faint" aria-hidden />
                <p>Say how {id} works. The agent draws the steps here, and nothing is made until you say so.</p>
              </div>
            </div>
          )}
          {phase === "working" && (
            <div className="grid h-full min-h-64 place-items-center text-center">
              <div className="space-y-3">
                {builder && (
                  <div className="mx-auto w-fit">
                    <AgentAvatar agent={builder} size={72} interactive={false} />
                  </div>
                )}
                <Loader2 size={20} className="mx-auto animate-spin text-muted" aria-hidden />
                <h3 className="t-title">{builder?.name ?? "An agent"} is drawing your team</h3>
                <p className="mx-auto line-clamp-4 max-w-sm text-sm text-muted">{text}</p>
              </div>
            </div>
          )}
          {phase === "failed" && (
            <div className="grid h-full min-h-64 place-items-center text-center">
              <div className="space-y-2">
                <h3 className="t-title">It couldn't draw that</h3>
                <p className="mx-auto max-w-sm text-sm text-muted">{failure}</p>
              </div>
            </div>
          )}
          {phase === "ready" && team && (
            <>
              <div className="flex items-center gap-2.5">
                {builder && <AgentAvatar agent={builder} size={28} interactive={false} />}
                <h3 className="text-body font-semibold">{builder?.name ?? "The agent"} drew this</h3>
              </div>
              <div className="rounded-3xl border border-line bg-card px-4 py-3">
                <MiniChart steps={team.steps ?? []} />
              </div>
              <h4 className="text-sm font-semibold text-muted">How it works</h4>
              <div className="rounded-3xl border border-line bg-card p-4">
                <HowLines lines={lines} />
              </div>
              {(problem || error) && <p className="text-sm text-bad">{problem ?? error}</p>}
              <div className="flex justify-end gap-2.5 pt-1">
                <Button type="button" onClick={() => onEdit(team)} className="h-[42px]">
                  Edit
                </Button>
                <Button type="button" variant="primary" disabled={busy || !!problem} onClick={() => onCreate(team)} className="h-[42px]">
                  Create team
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** A last look before the team is made: its name, how it works, and a way back to the flowchart. */
function Review({ slug: id, topic, team, busy, error, onBack, onCreate }: { slug: string; topic: string; team: ChannelTeam; busy: boolean; error: string | null; onBack: () => void; onCreate: () => void }) {
  const lines = useFlowLines(team);
  const problem = stepProblems(team).lines[0] ?? (teamSizeProblem(team) && NEEDS_AGENTS);
  return (
    <Modal title="Ready to create" onClose={onBack} className="sm:max-w-[640px]!">
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <TeamGhosts agentIds={teamAgentIds(team)} size={56} />
          <div className="min-w-0">
            <div className="t-title truncate">{id}</div>
            {topic && <div className="text-body text-muted">{topic}</div>}
          </div>
        </div>
        <section className="space-y-2" aria-label="How it works">
          <h3 className="text-sm font-semibold text-muted">How it works</h3>
          <div className="rounded-3xl border border-line bg-card p-4">
            <HowLines lines={lines} big />
          </div>
        </section>
        <button type="button" onClick={onBack} className="flex w-full items-center gap-3 rounded-3xl border border-line bg-card px-4 py-3.5 text-left hover:bg-hover">
          <Workflow size={19} className="text-muted" aria-hidden />
          <span className="flex-1 text-body font-medium">See the flowchart</span>
          <span className="text-sm text-muted">
            {team.steps?.length ?? 0} {(team.steps?.length ?? 0) === 1 ? "step" : "steps"}
          </span>
        </button>
        {(problem || error) && (
          <div role="alert" className="rounded-xl bg-bad/15 p-4">
            <div className="text-body font-medium text-bad">{error ? "Couldn't create it" : "Something to fix first"}</div>
            <p className="mt-0.5 text-sm">{error ?? problem}</p>
          </div>
        )}
        <div className="flex justify-end gap-2.5">
          <Button type="button" onClick={onBack} className="h-[42px]">
            Edit steps
          </Button>
          <Button type="button" variant="primary" disabled={busy || !!problem} onClick={onCreate} className="h-[42px]">
            {busy ? "Creating" : "Create team"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
