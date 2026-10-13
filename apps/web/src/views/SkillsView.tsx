import { useEffect, useMemo, useState } from "react";
import { Check, Pencil, Plus, Trash2, Wand2 } from "lucide-react";
import { SKILL_CATALOG, catalogSkill, type Agent, type CatalogSkill, type Skill } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { renderMarkdown } from "../markdown.ts";
import { AgentAvatar, Button, Empty, Field, Input, Loader, Modal, Pill, Textarea, cx, timeAgo } from "../components/ui.tsx";
import { AgentPicker, AgentStack, Group, CatalogIcon, IconTile, SearchBox, ShopHeader, Tabs } from "../components/ShopParts.tsx";

const SOURCE: Record<Skill["source"], string> = { catalog: "From the shop", custom: "Made here", taught: "Taught" };
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

  const needle = q.trim().toLowerCase();
  const match = (...s: string[]) => !needle || s.some((x) => x.toLowerCase().includes(needle));
  const byCatalog = useMemo(() => new Map((skills ?? []).filter((s) => s.catalogId).map((s) => [s.catalogId!, s])), [skills]);
  const shop = SKILL_CATALOG.filter((s) => (tag === "All" || s.tags.includes(tag)) && match(s.name, s.description, ...s.tags));
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
          <p className="text-sm text-muted">Skills are step-by-step instructions for kinds of work. Install one and your agents follow it whenever a request fits, whatever harness they run in.</p>
          <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-3 border-b border-line">
            <div className="flex-1">
              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: "shop", label: "Shop", count: SKILL_CATALOG.length },
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
                {TAGS.map((t) => (
                  <button key={t} onClick={() => setTag(t)} className={cx("h-7 px-2.5 rounded-full text-xs whitespace-nowrap border capitalize", tag === t ? "bg-accent text-accent-ink border-transparent" : "border-line text-muted hover:text-ink hover:bg-hover")}>
                    {t}
                  </button>
                ))}
              </div>
              {shop.length === 0 ? (
                <p className="text-sm text-muted py-8 text-center">No skills match. You can create your own.</p>
              ) : (
                <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                  {shop.map((e) => {
                    const have = byCatalog.get(e.id);
                    return (
                      <div key={e.id} className="rounded-xl border border-line bg-panel p-4 flex flex-col gap-3">
                        <button className="flex items-start gap-3 text-left" onClick={() => setOpen(have ? { skill: have } : { entry: e })}>
                          <IconTile>
                            <CatalogIcon name={e.icon} fallback={Wand2} />
                          </IconTile>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold">{e.name}</span>
                            <span className="block text-sm text-muted mt-1 line-clamp-3">{e.description.replace(/^Use (when|for) /, (m) => (m === "Use for " ? "For " : "When "))}</span>
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
                          {have ? <AgentStack agents={agents} ids={have.agentIds} max={4} /> : <span className="text-xs text-faint">Not installed</span>}
                          <span className="flex-1" />
                          <Button className="h-8" variant="ghost" onClick={() => setOpen(have ? { skill: have } : { entry: e })}>
                            Read
                          </Button>
                          {canEdit && (
                            <Button className="h-8" onClick={() => (have ? setOpen({ skill: have }) : setInstalling(e))}>
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
                  })}
                </div>
              )}
            </>
          ) : skills === null ? (
            <Loader />
          ) : skills.length === 0 ? (
            <div className="py-6">
              <Empty icon={<Wand2 size={24} />} title="No skills installed yet">
                <p>Install one from the shop, or write your own: how your team does a weekly report, a deploy, a customer reply.</p>
                <Button onClick={() => setTab("shop")}>Browse the shop</Button>
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
                    <span className="block text-xs text-muted truncate mt-0.5">{s.description || "No description"}</span>
                  </span>
                  <span className="hidden md:block w-40 shrink-0">
                    <AgentStack agents={agents} ids={s.agentIds} />
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

function SkillPanel({ open, agents, canEdit, onClose, onInstall, onEdit, onChanged }: { open: Open; agents: Agent[]; canEdit: boolean; onClose: () => void; onInstall: (e: CatalogSkill) => void; onEdit: (s: Skill) => void; onChanged: (id?: string) => void }) {
  const skill = "skill" in open ? open.skill : null;
  const entry = "entry" in open ? open.entry : catalogSkill(skill?.catalogId ?? "");
  const name = skill?.name ?? entry!.name;
  const description = skill?.description ?? entry!.description;
  const content = skill?.content ?? entry!.content;
  const html = useMemo(() => renderMarkdown(content), [content]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (!skill || !confirm(`Delete "${skill.name}"? Agents that have it lose it.`)) return;
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
          <p className="text-sm text-muted">{description}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {skill ? <Pill tone={skill.source === "custom" ? "accent" : "neutral"}>{SOURCE[skill.source]}</Pill> : <Pill>In the shop</Pill>}
            {skill && <span className="font-mono">me/skills/{skill.slug}/SKILL.md</span>}
            {skill && <span>· updated {timeAgo(skill.updatedAt)}</span>}
          </div>
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

        {skill && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Agents with this skill</h3>
            {agents.length === 0 ? (
              <p className="text-sm text-muted">No agents yet.</p>
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

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">SKILL.md</h3>
          <div className="prose-w rounded-lg border border-line p-4 text-sm" dangerouslySetInnerHTML={{ __html: html }} />
        </section>
      </div>
    </Modal>
  );
}

function InstallModal({ entry, agents, onClose, onDone }: { entry: CatalogSkill; agents: Agent[]; onClose: () => void; onDone: (s: Skill) => void }) {
  const [agentIds, setAgentIds] = useState<string[]>(agents.length === 1 ? [agents[0].id] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        <Group label="Which agents learn it" hint="You can give it to more agents later.">
          <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} />
        </Group>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={install}>
            {agentIds.length ? `Install for ${agentIds.length} agent${agentIds.length === 1 ? "" : "s"}` : "Add to the workspace"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SkillEditor({ skill, agents, onClose, onSaved }: { skill: Skill | null; agents: Agent[]; onClose: () => void; onSaved: (s: Skill) => void }) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [tags, setTags] = useState(skill?.tags.join(", ") ?? "");
  const [content, setContent] = useState(skill?.content ?? NEW_SKILL);
  const [agentIds, setAgentIds] = useState<string[]>(skill?.agentIds ?? []);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const html = useMemo(() => (preview ? renderMarkdown(content) : ""), [preview, content]);

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      description: description.trim(),
      content,
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

  return (
    <Modal title={skill ? `Edit "${skill.name}"` : "Create a skill"} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Deploy the web app" required />
        </Field>
        <Field label="When to use it" hint="Agents read this to decide when the skill applies. Start with “Use when…”.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Use when asked to deploy or roll back the web app." />
        </Field>
        <Field label="Tags" hint="Comma-separated, optional.">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="code, deploy" />
        </Field>
        <div className="space-y-1.5">
          <div className="flex items-center">
            <span className="text-sm font-medium flex-1">Instructions (markdown)</span>
            <div className="flex text-xs rounded-md border border-line overflow-hidden">
              {(["Write", "Preview"] as const).map((m) => (
                <button type="button" key={m} onClick={() => setPreview(m === "Preview")} className={cx("px-2.5 h-7", preview === (m === "Preview") ? "bg-chip text-ink" : "text-muted hover:bg-hover")}>
                  {m}
                </button>
              ))}
            </div>
          </div>
          {preview ? (
            <div className="prose-w rounded-lg border border-line p-4 text-sm min-h-64 max-h-[50vh] overflow-y-auto" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <Textarea className="font-mono text-[13px] min-h-64" rows={14} value={content} onChange={(e) => setContent(e.target.value)} required />
          )}
        </div>
        <Group label="Which agents have it">
          <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} />
        </Group>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim() || !content.trim()}>
            {skill ? "Save" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
