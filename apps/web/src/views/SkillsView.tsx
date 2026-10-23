import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Pencil, Plus, Trash2, Wand2 } from "lucide-react";
import { catalogSkill, type Agent, type CatalogSkill, type Skill } from "@warren/core";
import { api } from "../api.ts";
import { renderMarkdown } from "../markdown.ts";
import { Advanced, useSimple } from "../experience.tsx";
import { openDm } from "../openDm.ts";
import { AgentAvatar, Button, Field, Input, Modal, Pill, Textarea, cx, timeAgo } from "../components/ui.tsx";
import { AgentPicker, Group, CatalogIcon } from "../components/ShopParts.tsx";

export const SOURCE: Record<Skill["source"], string> = { catalog: "From the library", custom: "Made here", taught: "Taught" };

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
export type Open = { skill: Skill } | { entry: CatalogSkill };

const HARNESS_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", hermes: "Hermes" };
const STORE_NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI" };

/** Where an installed skill came from, in a few words. */
export function skillOrigin(s: Pick<Skill, "source" | "catalogId">): string {
  const id = s.catalogId ?? "";
  if (id.startsWith("device:")) return `From ${HARNESS_NAMES[id.split(":")[2]] ?? "a device"}`;
  const store = /^([a-z]+):/.exec(id)?.[1];
  if (s.source === "catalog" && store && STORE_NAMES[store]) return `From ${STORE_NAMES[store]}`;
  return SOURCE[s.source];
}

export function SkillPanel({ open, agents, canEdit, onClose, onInstall, onEdit, onChanged }: { open: Open; agents: Agent[]; canEdit: boolean; onClose: () => void; onInstall: (e: CatalogSkill) => void; onEdit: (s: Skill) => void; onChanged: (id?: string) => void }) {
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
            {skill ? <Pill tone={skill.source === "custom" && !skill.catalogId ? "accent" : "neutral"}>{skillOrigin(skill)}</Pill> : <Pill>In the library</Pill>}
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
                <dt className="text-[13px] font-semibold text-muted">What it does</dt>
                <dd className="mt-1 text-ink">{plain.does}</dd>
              </div>
              {plain.needs && (
                <div>
                  <dt className="text-[13px] font-semibold text-muted">What it needs</dt>
                  <dd className="mt-1 text-ink">{plain.needs}</dd>
                </div>
              )}
              {plain.example && (
                <div>
                  <dt className="text-[13px] font-semibold text-muted">Example</dt>
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
            <h3 className="text-[13px] font-semibold text-muted">{simple ? "Helpers" : "Agents"} with this skill</h3>
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
            <h3 className="text-[13px] font-semibold text-muted">{simple ? "How your helper does it" : "SKILL.md"}</h3>
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
      <h3 className="text-[13px] font-semibold text-muted">Try it</h3>
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

/** Give a skill to agents: one from the library (`catalogId`), the store (`storeId`) or a device (`nodeId`, `harness`, `skillId`). */
export function InstallModal({ entry, body, agents, onClose, onDone }: { entry: { name: string; description: string }; body: Record<string, string>; agents: Agent[]; onClose: () => void; onDone: (s: Skill) => void }) {
  const [agentIds, setAgentIds] = useState<string[]>(agents.length === 1 ? [agents[0].id] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = useSimple() ? "helper" : "agent";
  async function install() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api<Skill>("POST", "/api/skills", { ...body, agentIds }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title={`Add "${entry.name}"`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted line-clamp-4">{entry.description}</p>
        <Group label={`Which ${who}s learn it`} hint={`You can give it to more ${who}s later.`}>
          <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} />
        </Group>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={install}>
            {agentIds.length ? `Add for ${agentIds.length} ${who}${agentIds.length === 1 ? "" : "s"}` : "Add to the organization"}
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

export function SkillEditor({ skill, agents, onClose, onSaved }: { skill: Skill | null; agents: Agent[]; onClose: () => void; onSaved: (s: Skill) => void }) {
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
