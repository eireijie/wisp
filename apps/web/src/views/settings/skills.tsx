import { useEffect, useState, type ReactNode } from "react";
import { Book, ChevronDown, ChevronLeft, GraduationCap } from "lucide-react";
import type { Agent, Skill } from "@wisp/core";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { go, href, useRoute } from "../../router.ts";
import { useDevices } from "../../devices.ts";
import { Loader, Menu, cx } from "../../components/ui.tsx";
import { BuiltInSkillPage, SkillDetail, SkillEditor, SkillShare, TryDialog, builtInId, skillByline, skillHolders, whoPatch, whoValue, type BuiltInSkill } from "../SkillsView.tsx";
import type { AgentPolicy } from "./workspace.tsx";
import { Toggle } from "./parts.tsx";

export type SkillsTab = "all" | "learned" | "built-in" | "added";
const TABS: [SkillsTab, string][] = [
  ["all", "All"],
  ["learned", "Learned"],
  ["built-in", "Built in"],
  ["added", "Added"],
];

/** One row of the list: a skill in Wisp, or a harness's own. */
export type SkillRow = { kind: "skill"; skill: Skill } | { kind: "built-in"; skill: BuiltInSkill };

/** The list's sections in order (Learned, Built in, Added), each only when it has rows and the tab shows it. */
export function skillSections(skills: Skill[], builtIn: BuiltInSkill[], tab: SkillsTab): { id: Exclude<SkillsTab, "all">; title: string; rows: SkillRow[] }[] {
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  const learned = skills.filter((s) => s.source === "learned").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const added = skills.filter((s) => s.source !== "learned").sort(byName);
  const sections = [
    { id: "learned" as const, title: "Learned", rows: learned.map((skill) => ({ kind: "skill" as const, skill })) },
    { id: "built-in" as const, title: "Built in", rows: [...builtIn].sort((a, b) => a.harnessLabel.localeCompare(b.harnessLabel) || byName(a, b)).map((skill) => ({ kind: "built-in" as const, skill })) },
    { id: "added" as const, title: "Added", rows: added.map((skill) => ({ kind: "skill" as const, skill })) },
  ];
  return sections.filter((s) => s.rows.length && (tab === "all" || tab === s.id));
}

/**
 * Settings → Skills: what agents learned on their own, what their harnesses come with, and what
 * was added from the shop or imported. A row opens the skill's page (#/settings/skills/<id>).
 */
export function SkillsPage() {
  const route = useRoute();
  const item = route.view === "settings" ? (route.item ?? null) : null;
  const me = useStore((s) => s.me);
  const agents = useStore((s) => s.agents);
  const skillsVersion = useStore((s) => s.skillsVersion);
  const canEdit = !!me && me.role !== "guest";
  const isOwner = me?.role === "owner";
  const devices = useDevices(60_000);
  const [tab, setTab] = useState<SkillsTab>("all");
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [builtIn, setBuiltIn] = useState<BuiltInSkill[]>([]);
  const [learn, setLearn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [sharing, setSharing] = useState<Skill | "import" | null>(null);
  const [trying, setTrying] = useState<{ name: string; description: string; agentIds: string[] } | null>(null);

  const load = () => api<Skill[]>("GET", "/api/skills").then(setSkills, (e) => (setSkills([]), setError((e as Error).message)));
  useEffect(() => {
    void load();
    api<{ skills: BuiltInSkill[] }>("GET", "/api/skills/built-in").then((r) => setBuiltIn(r.skills ?? []), () => setBuiltIn([]));
  }, [skillsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api<AgentPolicy>("GET", "/api/settings/agents").then((p) => setLearn(p.learnSkills ?? true), () => setLearn(null));
  }, []);

  async function setLearning(on: boolean) {
    const before = learn;
    setLearn(on);
    setError(null);
    try {
      const p = await api<AgentPolicy>("PUT", "/api/settings/agents", { learnSkills: on });
      setLearn(p?.learnSkills ?? on);
    } catch (e) {
      setLearn(before);
      setError((e as Error).message);
    }
  }
  async function setWho(s: Skill, to: ReturnType<typeof whoValue>) {
    setError(null);
    try {
      await api("PATCH", `/api/skills/${s.id}`, whoPatch(s, to, agents));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const open = (id: string | null) => go({ view: "settings", page: "skills", item: id });
  const deviceName = (nodeId: string) => devices?.find((d) => d.id === nodeId)?.name;
  const openSkill = item ? skills?.find((s) => s.id === item) : undefined;
  const openBuiltIn = item ? builtIn.find((b) => builtInId(b) === item) : undefined;

  const dialogs = (
    <>
      {editing && (
        <SkillEditor
          skill={editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onShare={(s) => setSharing(s)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
      {sharing && (
        <SkillShare
          skill={sharing === "import" ? null : sharing}
          agents={agents}
          canEdit={canEdit}
          onClose={() => setSharing(null)}
          onBrought={async (s) => {
            setSharing(null);
            await load();
            open(s.id);
          }}
          onDevices={() => (setSharing(null), go({ view: "marketplace", section: "devices" }))}
        />
      )}
      {trying && <TryDialog skill={trying} agents={agents} onClose={() => setTrying(null)} />}
    </>
  );

  // one skill's page
  if (item) {
    const back = (
      <button type="button" onClick={() => open(null)} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ChevronLeft size={17} aria-hidden /> Skills
      </button>
    );
    return (
      <>
        {back}
        {openSkill ? (
          <SkillDetail open={{ skill: openSkill }} agents={agents} canEdit={canEdit} onInstall={() => {}} onEdit={setEditing} onChanged={() => void load()} onGone={() => open(null)} onTry={setTrying} onShare={(s) => setSharing(s)} />
        ) : openBuiltIn ? (
          <BuiltInSkillPage skill={openBuiltIn} agents={agents} />
        ) : skills === null ? (
          <Loader />
        ) : (
          <p className="text-sm text-muted">This skill isn't here anymore.</p>
        )}
        {dialogs}
      </>
    );
  }

  const sections = skills ? skillSections(skills, builtIn, tab) : [];
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="t-title max-md:hidden">Skills</h2>
        <span className="flex gap-2">
          <a href={href({ view: "marketplace", section: "skills" })} className="inline-flex h-[34px] items-center rounded-lg bg-control px-3 text-[13px] font-medium text-ink/80 hover:text-ink">
            Browse the shop
          </a>
          {canEdit && (
            <button type="button" onClick={() => setSharing("import")} className="inline-flex h-[34px] items-center rounded-lg bg-control px-3 text-[13px] font-medium text-ink/80 hover:text-ink">
              Import
            </button>
          )}
        </span>
      </div>

      <div role="tablist" aria-label="Which skills" className="mb-4 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx("h-8 shrink-0 rounded-lg px-3.5 text-[13px] font-medium", tab === id ? "bg-ink text-bg" : "bg-control text-ink/75 hover:text-ink")}>
            {label}
          </button>
        ))}
      </div>

      {(tab === "all" || tab === "learned") && learn !== null && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-line bg-card px-4 py-3">
          <GraduationCap size={16} strokeWidth={1.9} className="shrink-0 text-badge" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Learn skills on their own</span>
            <span className="block text-xs leading-snug text-faint">When an agent finishes something it could do again, it saves how.</span>
          </span>
          <Toggle on={learn} label="Learn skills on their own" disabled={!isOwner} onChange={(v) => void setLearning(v)} />
        </div>
      )}
      {error && <p className="mb-4 text-sm text-bad">{error}</p>}

      {skills === null ? (
        <Loader />
      ) : sections.length === 0 ? (
        <p className="px-1 text-sm text-muted">{tab === "learned" ? "Nothing learned yet. Agents save a skill when they finish something they could do again." : tab === "built-in" ? "Built-in skills show up after an agent runs." : "No skills yet."}</p>
      ) : (
        <div className="space-y-6">
          {sections.map((sec) => (
            <section key={sec.id} aria-label={sec.title} className="space-y-2">
              <h3 className="px-1 text-xs font-medium uppercase tracking-[0.04em] text-faint">{sec.title}</h3>
              <div className="overflow-hidden rounded-xl border border-line bg-card divide-y divide-line">
                {sec.rows.map((r) =>
                  r.kind === "built-in" ? (
                    <Row key={builtInId(r.skill)} name={r.skill.name} description={r.skill.description ?? ""} byline={r.skill.harnessLabel} who={<span className="text-[13px] text-ink/80">{r.skill.harnessLabel} agents</span>} onOpen={() => open(builtInId(r.skill))} />
                  ) : (
                    <Row
                      key={r.skill.id}
                      name={r.skill.name}
                      description={r.skill.description}
                      byline={skillByline(r.skill, agents, deviceName)}
                      who={<WhoMenu skill={r.skill} agents={agents} canEdit={canEdit} onChange={(to) => void setWho(r.skill, to)} onMore={() => open(r.skill.id)} />}
                      onOpen={() => open(r.skill.id)}
                    />
                  ),
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      {dialogs}
    </>
  );
}

/** A skill in the list: name and what it's for, where it came from, and who has it. */
function Row({ name, description, byline, who, onOpen }: { name: string; description: string; byline: string; who: ReactNode; onOpen: () => void }) {
  return (
    <div className="flex min-h-14 items-center gap-3 pr-4 hover:bg-hover">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left">
        <Book size={16} strokeWidth={1.9} className="shrink-0 text-muted" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="truncate text-xs text-faint">{description || byline}</span>
          <span className="truncate text-xs text-faint md:hidden">{description ? byline : ""}</span>
        </span>
        <span className="hidden w-36 shrink-0 truncate text-xs text-faint md:block">{byline}</span>
      </button>
      <span className="flex w-28 shrink-0 justify-end md:justify-start">{who}</span>
    </div>
  );
}

/** Who has a skill, with a quick change: just the agent that learned it, all agents, or pick on its page. */
function WhoMenu({ skill, agents, canEdit, onChange, onMore }: { skill: Skill; agents: Agent[]; canEdit: boolean; onChange: (to: ReturnType<typeof whoValue>) => void; onMore: () => void }) {
  const label = skillHolders(skill, agents);
  if (!canEdit) return <span className="truncate text-[13px] text-ink/80">{label}</span>;
  const who = whoValue(skill, agents);
  const learner = skill.source === "learned" ? agents.find((a) => a.id === skill.learnedBy) : undefined;
  const items = [
    ...(learner ? [{ label: `Just ${learner.name}`, onSelect: () => who !== "just" && onChange("just") }] : [{ label: "Pick agents…", onSelect: onMore }]),
    { label: "All agents", onSelect: () => who !== "all" && onChange("all") },
  ];
  return (
    <Menu
      align="right"
      items={items}
      trigger={(isOpen, toggle) => (
        <button type="button" onClick={toggle} aria-expanded={isOpen} aria-label={`Who can use ${skill.name}: ${label}`} className="inline-flex max-w-full items-center gap-1 rounded-md px-1 text-[13px] text-ink/80 hover:text-ink">
          <span className="truncate">{label}</span>
          <ChevronDown size={12} className="shrink-0 text-faint" aria-hidden />
        </button>
      )}
    />
  );
}
