import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Pencil, Plus, Trash2, Wand2 } from "lucide-react";
import { SKILL_CATALOG, catalogSkill, everydaySkills, type Agent, type CatalogSkill, type Skill } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { renderMarkdown } from "../markdown.ts";
import { Advanced, useSimple } from "../experience.tsx";
import { openDm } from "../openDm.ts";
import { AgentAvatar, Button, Empty, Field, Input, Loader, Modal, Pill, Textarea, cx, timeAgo } from "../components/ui.tsx";
import { AgentPicker, AgentStack, Group, CatalogIcon, IconTile, SearchBox, ShopHeader, Tabs } from "../components/ShopParts.tsx";

const SOURCE: Record<Skill["source"], string> = { catalog: "From the library", custom: "Made here", taught: "Taught" };
// tags shared by a few skills; one-off tags would just be noise as filters
const TAGS = ["All", ...[...new Set(SKILL_CATALOG.flatMap((s) => s.tags))].filter((t) => SKILL_CATALOG.filter((s) => s.tags.includes(t)).length >= 2).sort()];

const NEW_SKILL = `# <What this skill does>

## When to use it
- …

## Steps
1. …
2. …

## Rules
- …
`;

/** First sentence of a skill description as a plain "what it's for" line, cut at a word boundary. */
export function whatItsFor(description: string, max = 110): string {
  const flat = description.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const text = flat.replace(/^Use (when|for) /i, (m) => (/for/i.test(m) ? "For " : "When "));
  const first = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 20)).replace(/[\s,;:.-]+$/, "")}…`;
}

/** "Everyday Helper has this" / "No helper has this yet", from the helpers that hold a skill. */
export function helperLine(agents: Pick<Agent, "id" | "name">[], ids: string[]): string {
  const names = ids.map((id) => agents.find((a) => a.id === id)?.name).filter((n): n is string => !!n);
  if (names.length === 0) return "No helper has this yet";
  if (names.length === 1) return `${names[0]} has this`;
  if (names.length === 2) return `${names[0]} and ${names[1]} have this`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more have this`;
}

/** A sentence to paste into chat to try a skill. Skills carry no example, so it is built from the name and what it's for. */
export function trySuggestion(skill: { name: string; description: string }): string {
  const purpose = whatItsFor(skill.description);
  return `Please use your "${skill.name.trim()}" skill for this.${purpose ? ` (It is for this: ${lowerFirst(purpose)})` : ""} Here is what I have: `;
}

/** Lowercase a leading capital so the text can follow a lead-in, but keep "I", "I'm" and acronyms. */
const lowerFirst = (v: string) => (/^[A-Z][a-z]/.test(v) ? v.charAt(0).toLowerCase() + v.slice(1) : v);

const oneLine = (v: string) => v.replace(/\s+/g, " ").trim();

/**
 * The guided "Create a skill" answers turned into what the save API wants: a "Use when…" description
 * and a Markdown body. Empty sections are left out; the name becomes the heading. Newlines in the
 * description are flattened (it is one line in the SKILL.md front matter, where skillFile quotes it).
 */
export function skillFromGuide(g: { name: string; what: string; when: string; result: string }): { description: string; content: string } {
  const name = oneLine(g.name);
  const when = g.when.trim();
  const sections: [string, string][] = [
    ["What to do", g.what.trim()],
    ["When to use it", when],
    ["What a good result looks like", g.result.trim()],
  ];
  const body = sections.filter(([, t]) => t).map(([h, t]) => `## ${h}\n${t}`);
  const lead = oneLine(when);
  const description = !lead ? "" : /^use (when|for)\b/i.test(lead) ? lead : `Use when ${lowerFirst(lead)}`;
  return { description: description.slice(0, 500), content: [`# ${name || "New skill"}`, ...body].join("\n\n") + "\n" };
}

export const skillMarkdownFromGuide = (g: Parameters<typeof skillFromGuide>[0]) => skillFromGuide(g).content;

/**
 * The plain-words version of a skill for Simple mode. A library entry (skill null) or an installed,
 * unedited catalog skill uses the catalog's `plain` text; an edited or custom skill only gets a
 * line made from its own description, since the catalog text no longer describes it.
 */
export function plainSkill(skill: Pick<Skill, "description" | "content" | "catalogId"> | null, entry: CatalogSkill | undefined): { does: string; needs: string | null; example: string | null } {
  const description = skill?.description ?? entry?.description ?? "";
  const same = !skill || (!!skill.catalogId && !!entry && skill.content === entry.content);
  const plain = same ? entry?.plain : undefined;
  return { does: plain?.does ?? whatItsFor(description), needs: plain?.needs ?? null, example: plain?.example ?? null };
}

/** What the detail panel shows: an installed skill, or a shop item not installed yet. */
type Open = { skill: Skill } | { entry: CatalogSkill };

/**
 * The skill shop: ready-made "how to do X" instructions agents can learn, plus your own. An
 * installed skill is written into each agent's memory folder (me/skills/<name>/SKILL.md) and
 * listed in its prompt, so whichever harness it runs in reads and follows it.
 */
export function SkillsView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const simple = useSimple();
  const canEdit = me.role !== "guest";
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [tab, setTab] = useState<"shop" | "installed">("shop");
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("All");
  const [open, setOpen] = useState<Open | null>(null);
  const [installing, setInstalling] = useState<CatalogSkill | null>(null);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);

  const load = () => api<Skill[]>("GET", "/api/skills").then((s) => (setSkills(s), s), () => (setSkills([]), []));
  useEffect(() => {
    load();
  }, []);

  const tags = useMemo(() => (simple ? ["All", ...TAGS.filter((t) => t === "everyday"), ...TAGS.filter((t) => t !== "All" && t !== "everyday")] : TAGS), [simple]);
  const needle = q.trim().toLowerCase();
  const match = (...s: string[]) => !needle || s.some((x) => x.toLowerCase().includes(needle));
  const byCatalog = useMemo(() => new Map((skills ?? []).filter((s) => s.catalogId).map((s) => [s.catalogId!, s])), [skills]);
  const shop = SKILL_CATALOG.filter((s) => (tag === "All" || s.tags.includes(tag)) && match(s.name, s.description, ...s.tags));
  const everyday = simple && !needle && tag === "All";
  const everydayIds = new Set(everydaySkills().map((s) => s.id));
  const rest = everyday ? shop.filter((e) => !everydayIds.has(e.id)) : shop;
  const card = (e: CatalogSkill) => {
    const have = byCatalog.get(e.id);
    return <LibraryCard key={e.id} e={e} have={have} agents={agents} simple={simple} canEdit={canEdit} onOpen={() => setOpen(have ? { skill: have } : { entry: e })} onInstall={() => (have ? setOpen({ skill: have }) : setInstalling(e))} />;
  };
  const installed = (skills ?? []).filter((s) => match(s.name, s.description, ...s.tags));

  // keep the open panel in step with the latest data
  const refresh = async (focus?: string) => {
    const list = await load();
    if (focus) {
      const s = list.find((x) => x.id === focus);
      setOpen(s ? { skill: s } : null);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ShopHeader
        title="Skills"
        onBack={onBack}
        action={
          canEdit && (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus size={16} /> <span className="hidden sm:inline">Create a skill</span>
              <span className="sm:hidden">Create</span>
            </Button>
          )
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl px-4 md:px-6 py-5 space-y-4">
          <p className="text-sm text-muted">
            {simple
              ? "A skill teaches your helper how to do one kind of job well. Add one and your helper follows it whenever a request fits."
              : "Skills are step-by-step instructions for kinds of work. Install one and your agents follow it whenever a request fits, whatever harness they run in."}
          </p>
          <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-3 border-b border-line">
            <div className="flex-1">
              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: "shop", label: "Skill library", count: SKILL_CATALOG.length },
                  { id: "installed", label: "Installed", count: skills?.length },
                ]}
              />
            </div>
            <div className="sm:pb-2">
              <SearchBox value={q} onChange={setQ} placeholder="Search skills" />
            </div>
          </div>
          {!canEdit && <p className="text-xs text-muted">Guests can browse; members install and create skills.</p>}

          {tab === "shop" ? (
            <>
              <div className="flex gap-1 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap pb-1">
                {tags.map((t) => (
                  <button key={t} onClick={() => setTag(t)} className={cx("h-7 px-2.5 rounded-full text-xs whitespace-nowrap border capitalize", tag === t ? "bg-accent text-accent-ink border-transparent" : "border-line text-muted hover:text-ink hover:bg-hover")}>
                    {t}
                  </button>
                ))}
              </div>
              {shop.length === 0 ? (
                <p className="text-sm text-muted py-8 text-center">No skills match. You can create your own.</p>
              ) : (
                <>
                  {everyday && (
                    <section className="space-y-2" aria-labelledby="skills-everyday">
                      <h2 id="skills-everyday" className="text-xs font-semibold uppercase tracking-wider text-muted">
                        Everyday
                      </h2>
                      <p className="text-sm text-muted">You don't need a skill for ordinary requests. Just ask your helper. A skill helps when you want something done the same way every time.</p>
                      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">{everydaySkills().map(card)}</div>
                    </section>
                  )}
                  <section className="space-y-2">
                    {everyday && rest.length > 0 && <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">More skills</h2>}
                    <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">{rest.map(card)}</div>
                  </section>
                </>
              )}
            </>
          ) : skills === null ? (
            <Loader />
          ) : skills.length === 0 ? (
            <div className="py-6">
              <Empty icon={<Wand2 size={24} />} title="No skills installed yet">
                <p>Install one from the library, or write your own: how your team does a weekly report, a deploy, a customer reply.</p>
                <Button onClick={() => setTab("shop")}>Browse the skill library</Button>
              </Empty>
            </div>
          ) : installed.length === 0 ? (
            <p className="text-sm text-muted py-8 text-center">No installed skills match "{q}".</p>
          ) : (
            <div className="rounded-xl border border-line divide-y divide-line bg-panel">
              {installed.map((s) => (
                <button key={s.id} className="w-full flex items-center gap-3 px-3 sm:px-4 py-3 text-left hover:bg-hover/60" onClick={() => setOpen({ skill: s })}>
                  <IconTile>
                    <CatalogIcon name={catalogSkill(s.catalogId ?? "")?.icon} fallback={Wand2} />
                  </IconTile>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{s.name}</span>
                      <span className="hidden sm:inline">
                        <Pill tone={s.source === "custom" ? "accent" : s.source === "taught" ? "info" : "neutral"}>{SOURCE[s.source]}</Pill>
                      </span>
                    </span>
                    <span className="block text-xs text-muted truncate mt-0.5">{simple ? whatItsFor(s.description) || "No description" : s.description || "No description"}</span>
                    {simple && <span className="block text-xs text-faint truncate">{helperLine(agents, s.agentIds)}</span>}
                  </span>
                  <span className="hidden md:block w-40 shrink-0">
                    {!simple && <AgentStack agents={agents} ids={s.agentIds} />}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {open && (
        <SkillPanel
          open={open}
          agents={agents}
          canEdit={canEdit}
          onClose={() => setOpen(null)}
          onInstall={(e) => setInstalling(e)}
          onEdit={(s) => setEditing(s)}
          onChanged={(id) => refresh(id)}
        />
      )}
      {installing && (
        <InstallModal
          entry={installing}
          agents={agents}
          onClose={() => setInstalling(null)}
          onDone={async (s) => {
            setInstalling(null);
            await refresh(s.id);
          }}
        />
      )}
      {editing && (
        <SkillEditor
          skill={editing === "new" ? null : editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onSaved={async (s) => {
            setEditing(null);
            setTab("installed");
            await refresh(s.id);
          }}
        />
      )}
    </div>
  );
}

function LibraryCard({ e, have, agents, simple, canEdit, onOpen, onInstall }: { e: CatalogSkill; have: Skill | undefined; agents: Agent[]; simple: boolean; canEdit: boolean; onOpen: () => void; onInstall: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4 flex flex-col gap-3">
      <button className="flex items-start gap-3 text-left" onClick={onOpen}>
        <IconTile>
          <CatalogIcon name={e.icon} fallback={Wand2} />
        </IconTile>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{e.name}</span>
          <span className="block text-sm text-muted mt-1 line-clamp-3">{simple ? (e.plain?.does ?? whatItsFor(e.description)) : e.description.replace(/^Use (when|for) /, (m) => (m === "Use for " ? "For " : "When "))}</span>
        </span>
      </button>
      <div className="flex flex-wrap gap-1">
        {e.tags.map((t) => (
          <span key={t} className="text-[11px] px-1.5 rounded bg-chip text-muted">
            {t}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-auto">
        {simple ? <span className="text-xs text-muted">{helperLine(agents, have?.agentIds ?? [])}</span> : have ? <AgentStack agents={agents} ids={have.agentIds} max={4} /> : <span className="text-xs text-faint">Not installed</span>}
        <span className="flex-1" />
        <Button className="h-8" variant="ghost" onClick={onOpen}>
          Read
        </Button>
        {canEdit && (
          <Button className="h-8" onClick={onInstall}>
            {have ? (
              <>
                <Check size={14} /> Installed
              </>
            ) : (
              <>
                <Plus size={14} /> Install
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function SkillPanel({ open, agents, canEdit, onClose, onInstall, onEdit, onChanged }: { open: Open; agents: Agent[]; canEdit: boolean; onClose: () => void; onInstall: (e: CatalogSkill) => void; onEdit: (s: Skill) => void; onChanged: (id?: string) => void }) {
  const skill = "skill" in open ? open.skill : null;
  const entry = "entry" in open ? open.entry : catalogSkill(skill?.catalogId ?? "");
  const name = skill?.name ?? entry!.name;
  const description = skill?.description ?? entry!.description;
  const content = skill?.content ?? entry!.content;
  const html = useMemo(() => renderMarkdown(content), [content]);
  const plain = plainSkill(skill, entry);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const simple = useSimple();
  const who = simple ? "helper" : "agent";

  async function toggle(agentId: string, on: boolean) {
    if (!skill) return;
    setBusy(agentId);
    setError(null);
    try {
      await api(on ? "PUT" : "DELETE", `/api/skills/${skill.id}/agents/${agentId}`);
      onChanged(skill.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!skill || !confirm(`Delete "${skill.name}"? Anyone who has it loses it.`)) return;
    try {
      await api("DELETE", `/api/skills/${skill.id}`);
      onClose();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      drawer
      onClose={onClose}
      label={name}
      title={
        <span className="flex items-center gap-2 min-w-0">
          <CatalogIcon name={entry?.icon} fallback={Wand2} size={17} />
          <span className="truncate">{name}</span>
        </span>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          {!(simple && plain.does) && <p className="text-sm text-muted">{description}</p>}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {skill ? <Pill tone={skill.source === "custom" ? "accent" : "neutral"}>{SOURCE[skill.source]}</Pill> : <Pill>In the library</Pill>}
            {skill && simple && <span>{helperLine(agents, skill.agentIds)}</span>}
            {skill && !simple && <span className="font-mono">me/skills/{skill.slug}/SKILL.md</span>}
            {skill && <span>{simple ? "" : "· "}updated {timeAgo(skill.updatedAt)}</span>}
          </div>
          {skill && simple && (
            <Advanced title="Details">
              <p className="text-xs text-muted">
                Instruction file: <span className="font-mono">me/skills/{skill.slug}/SKILL.md</span>
              </p>
            </Advanced>
          )}
        </div>

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {skill ? (
              <>
                <Button onClick={() => onEdit(skill)}>
                  <Pencil size={14} /> Edit
                </Button>
                <Button variant="danger" onClick={remove}>
                  <Trash2 size={14} /> Delete
                </Button>
              </>
            ) : (
              entry && (
                <Button variant="primary" onClick={() => onInstall(entry)}>
                  <Plus size={14} /> Install
                </Button>
              )
            )}
          </div>
        )}

        {simple && plain.does && (
          <section className="space-y-2" aria-label="In plain words">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wider text-muted">What it does</dt>
                <dd className="mt-1 text-ink">{plain.does}</dd>
              </div>
              {plain.needs && (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-muted">What it needs</dt>
                  <dd className="mt-1 text-ink">{plain.needs}</dd>
                </div>
              )}
              {plain.example && (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-muted">Example</dt>
                  <dd className="mt-1">
                    <q className="text-ink">{plain.example}</q>
                  </dd>
                </div>
              )}
            </dl>
          </section>
        )}

        {skill && <TryIt skill={skill} agents={agents} onClose={onClose} />}

        {skill && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{simple ? "Helpers" : "Agents"} with this skill</h3>
            {agents.length === 0 ? (
              <p className="text-sm text-muted">No {who}s yet.</p>
            ) : (
              <div className="rounded-lg border border-line divide-y divide-line">
                {agents.map((a) => {
                  const on = skill.agentIds.includes(a.id);
                  return (
                    <div key={a.id} className="flex items-center gap-3 px-3 py-2">
                      <AgentAvatar agent={a} size={24} />
                      <span className="text-sm flex-1 min-w-0 truncate">
                        {a.name} <span className="text-muted">@{a.handle}</span>
                      </span>
                      {canEdit ? (
                        <Button className="h-7 text-xs" variant={on ? "default" : "ghost"} disabled={busy === a.id} onClick={() => toggle(a.id, !on)}>
                          {on ? "Remove" : "Give"}
                        </Button>
                      ) : (
                        on && <Check size={15} className="text-ok" />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}

        <Advanced title="Full instructions">
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{simple ? "How your helper does it" : "SKILL.md"}</h3>
            <div className="prose-w rounded-lg border border-line p-4 text-sm" dangerouslySetInnerHTML={{ __html: html }} />
          </section>
        </Advanced>
      </div>
    </Modal>
  );
}

/** After a skill is installed: a request to paste into chat (Warren can't prefill the message) and a shortcut to the helper's chat. */
function TryIt({ skill, agents, onClose }: { skill: Skill; agents: Agent[]; onClose: () => void }) {
  const holders = skill.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
  const [pick, setPick] = useState(holders[0]?.id ?? "");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const helper = holders.find((a) => a.id === pick) ?? holders[0];
  const text = trySuggestion(skill);
  const sid = useId();
  if (!helper) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError(null);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy. Select the text and copy it yourself.");
    }
  }
  async function chat() {
    try {
      await openDm(helper!.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="space-y-2 rounded-lg border border-line p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Try it</h3>
      <p className="text-sm text-muted">Copy this request, open the chat, paste it, then add your own details.</p>
      <p className="text-sm rounded-lg bg-code p-3 select-all whitespace-pre-wrap" aria-label="Suggested request">
        {text}
      </p>
      {holders.length > 1 && (
        <div className="flex items-center gap-2">
          <label htmlFor={sid} className="text-sm">
            Which helper?
          </label>
          <select id={sid} value={helper.id} onChange={(e) => setPick(e.target.value)} className="h-8 rounded-md border border-input bg-transparent px-2 text-sm">
            {holders.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={copy}>{copied ? <><Check size={14} /> Copied</> : "Copy request"}</Button>
        <Button variant="primary" onClick={chat}>
          Open chat with {helper.name}
        </Button>
      </div>
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
      {error && <p className="text-sm text-bad">{error}</p>}
    </section>
  );
}

function InstallModal({ entry, agents, onClose, onDone }: { entry: CatalogSkill; agents: Agent[]; onClose: () => void; onDone: (s: Skill) => void }) {
  const [agentIds, setAgentIds] = useState<string[]>(agents.length === 1 ? [agents[0].id] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = useSimple() ? "helper" : "agent";
  async function install() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api<Skill>("POST", "/api/skills", { catalogId: entry.id, agentIds }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title={`Install "${entry.name}"`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">{entry.description}</p>
        <Group label={`Which ${who}s learn it`} hint={`You can give it to more ${who}s later.`}>
          <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} />
        </Group>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={install}>
            {agentIds.length ? `Install for ${agentIds.length} ${who}${agentIds.length === 1 ? "" : "s"}` : "Add to the workspace"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Starter text for the three guided questions, shown as placeholders. */
const GUIDE_HINTS = {
  what: "For example: Read the meeting notes I give you and write a short summary with decisions and next steps.",
  when: "For example: When I paste meeting notes or ask for a recap.",
  result: "For example: One page or less, decisions first, each next step with a name.",
};

function SkillEditor({ skill, agents, onClose, onSaved }: { skill: Skill | null; agents: Agent[]; onClose: () => void; onSaved: (s: Skill) => void }) {
  const simple = useSimple();
  const guided = simple && !skill;
  const ids = useId();
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [tags, setTags] = useState(skill?.tags.join(", ") ?? "");
  const [content, setContent] = useState(skill?.content ?? NEW_SKILL);
  const [what, setWhat] = useState("");
  const [when, setWhen] = useState("");
  const [result, setResult] = useState("");
  // Guided mode: the Markdown comes from the three answers until the person edits it directly;
  // after that their edited text is what gets saved (and "Use the answers again" undoes it).
  const [rawEdit, setRawEdit] = useState<string | null>(null);
  const [agentIds, setAgentIds] = useState<string[]>(skill?.agentIds ?? []);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generated = useMemo(() => skillFromGuide({ name, what, when, result }), [name, what, when, result]);
  const finalContent = guided ? (rawEdit ?? generated.content) : content;
  const finalDescription = guided ? generated.description : description.trim();
  const html = useMemo(() => (preview ? renderMarkdown(finalContent) : ""), [preview, finalContent]);
  const canSave = guided ? !!name.trim() && !!(what.trim() || rawEdit?.trim()) : !!name.trim() && !!content.trim();

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      description: finalDescription,
      content: finalContent,
      tags: tags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 10),
      agentIds,
    };
    try {
      onSaved(skill ? await api<Skill>("PATCH", `/api/skills/${skill.id}`, body) : await api<Skill>("POST", "/api/skills", body));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const tagsField = (
    <Field label="Tags" hint="Comma-separated, optional.">
      <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="code, deploy" />
    </Field>
  );
  const who = simple ? "helpers" : "agents";

  return (
    <Modal title={skill ? `Edit "${skill.name}"` : "Create a skill"} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save();
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={guided ? "Summarize a meeting" : "Deploy the web app"} required />
        </Field>
        {guided ? (
          <>
            <Field label="What should your helper do?">
              <Textarea rows={3} value={what} onChange={(e) => setWhat(e.target.value)} placeholder={GUIDE_HINTS.what} />
            </Field>
            <Field label="When should it use this?" hint="Your helper reads this to decide when the skill applies.">
              <Textarea rows={2} value={when} onChange={(e) => setWhen(e.target.value)} maxLength={500} placeholder={GUIDE_HINTS.when} />
            </Field>
            <Field label="What does a good result look like?">
              <Textarea rows={3} value={result} onChange={(e) => setResult(e.target.value)} placeholder={GUIDE_HINTS.result} />
            </Field>
            <Advanced title="Edit the instructions directly">
              <div className="space-y-2">
                <Field label="Instructions (markdown)" hint={rawEdit === null ? "Made from your answers above. If you change this text, this text is what gets saved." : "You edited this text, so the answers above no longer change it."}>
                  <Textarea className="font-mono text-[13px] min-h-48" rows={10} value={finalContent} onChange={(e) => setRawEdit(e.target.value)} />
                </Field>
                {rawEdit !== null && (
                  <Button type="button" onClick={() => setRawEdit(null)}>
                    Use my answers again
                  </Button>
                )}
              </div>
            </Advanced>
            <Advanced title="Tags">{tagsField}</Advanced>
          </>
        ) : (
          <>
            <Field label="When to use it" hint="Agents read this to decide when the skill applies. Start with “Use when…”.">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Use when asked to deploy or roll back the web app." />
            </Field>
            {tagsField}
            <div className="space-y-1.5">
              <div className="flex items-center">
                {preview ? (
                  <span className="text-sm font-medium flex-1">Instructions (markdown)</span>
                ) : (
                  <label htmlFor={`${ids}-md`} className="text-sm font-medium flex-1">
                    Instructions (markdown)
                  </label>
                )}
                <div className="flex text-xs rounded-md border border-line overflow-hidden">
                  {(["Write", "Preview"] as const).map((m) => (
                    <button type="button" key={m} onClick={() => setPreview(m === "Preview")} className={cx("px-2.5 h-7", preview === (m === "Preview") ? "bg-chip text-ink" : "text-muted hover:bg-hover")}>
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              {preview ? (
                <div aria-label="Preview of the instructions" className="prose-w rounded-lg border border-line p-4 text-sm min-h-64 max-h-[50vh] overflow-y-auto" dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                <Textarea id={`${ids}-md`} className="font-mono text-[13px] min-h-64" rows={14} value={content} onChange={(e) => setContent(e.target.value)} required />
              )}
            </div>
          </>
        )}
        <Group label={`Which ${who} have it`}>
          <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} />
        </Group>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !canSave}>
            {skill ? "Save" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
