import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { BadgeCheck, Check, Download, ExternalLink, FileText, Laptop, Link2, Pencil, Plus, Send, Share2, Trash2, Users, Wand2, X } from "lucide-react";
import { catalogSkill, skillFile, type Agent, type CatalogSkill, type Skill, type StoreSkill } from "@wisp/core";
import { api } from "../api.ts";
import { renderMarkdown } from "../markdown.ts";
import { MoreOptions } from "../components/MoreOptions.tsx";
import { openDm } from "../openDm.ts";
import { readSkillFile, readSkillLink, skillLink, type SharedSkill } from "../skillShare.ts";
import { AgentAvatar, Loader, timeAgo } from "../components/ui.tsx";
import { AreaBox, Badge, Chip, Circle, Dlg, Item, Label, Labeled, Note, Panel, Prim, Sec, Seg, Switch, TextBox, Tile } from "../components/MarketParts.tsx";
import { AgentPicker, CatalogIcon } from "../components/ShopParts.tsx";

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


/** The little plain-words card a skill detail shows (what it needs, an example). */
function SkillFacts({ plain }: { plain: { does: string; needs: string | null; example: string | null } }) {
  return (
    <>
      {plain.does && (
        <section className="space-y-2">
          <Label>What it does</Label>
          <p className="px-1 text-[15px] leading-relaxed text-ink/90">{plain.does}</p>
        </section>
      )}
      {plain.needs && (
        <section className="space-y-2">
          <Label>What it needs</Label>
          <Panel>
            <Item icon={<Tile size={40}><Wand2 size={20} strokeWidth={1.7} /></Tile>} title={<span className="whitespace-normal text-[15px] font-normal">{plain.needs}</span>} />
          </Panel>
        </section>
      )}
      {plain.example && (
        <section className="space-y-2">
          <Label>Example</Label>
          <div className="rounded-2xl border border-control-line bg-control px-4 py-3.5 text-base leading-snug">{plain.example}</div>
        </section>
      )}
    </>
  );
}

/**
 * A skill's page: what it does and needs, an example, its full instructions, Try it and Install (or,
 * once it's added, who has it, Edit and Delete). `onTry` opens the request to copy or send.
 */
export function SkillDetail({ open, agents, canEdit, onInstall, onEdit, onChanged, onGone, onTry, onShare }: { open: Open; agents: Agent[]; canEdit: boolean; onInstall: (e: CatalogSkill) => void; onEdit: (s: Skill) => void; onChanged: (id?: string) => void; onGone: () => void; onTry: (skill: { name: string; description: string; agentIds: string[] }) => void; onShare: (s: Skill) => void }) {
  const skill = "skill" in open ? open.skill : null;
  const entry = "entry" in open ? open.entry : catalogSkill(skill?.catalogId ?? "");
  const name = skill?.name ?? entry!.name;
  const description = skill?.description ?? entry!.description;
  const content = skill?.content ?? entry!.content;
  const html = useMemo(() => renderMarkdown(content), [content]);
  const plain = plainSkill(skill, entry);
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
    if (!skill || !confirm(`Delete "${skill.name}"? Anyone who has it loses it.`)) return;
    try {
      await api("DELETE", `/api/skills/${skill.id}`);
      onGone();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <Tile size={56}>
          <CatalogIcon name={entry?.icon} fallback={Wand2} size={26} />
        </Tile>
        <div className="min-w-0 flex-1 space-y-1.5">
          <h2 className="text-2xl font-bold tracking-tight">{name}</h2>
          <div className="flex flex-wrap items-center gap-2">
            {skill ? <Badge tone={skill.catalogId?.startsWith("device:") || skill.source === "custom" ? "grey" : "green"}>{skillOrigin(skill)}</Badge> : <Badge tone="green" icon={<BadgeCheck size={13} aria-hidden />}>Made by Wisp</Badge>}
            {skill && <span className="text-sm text-faint">{helperLine(agents, skill.agentIds)}</span>}
            {skill && <span className="text-sm text-faint">updated {timeAgo(skill.updatedAt)}</span>}
          </div>
        </div>
        {skill && canEdit && (
          <Circle label="Share" onClick={() => onShare(skill)}>
            <Share2 size={18} />
          </Circle>
        )}
      </header>

      {!plain.does && <p className="px-1 text-[15px] leading-relaxed">{description}</p>}
      <SkillFacts plain={plain} />

      <div className="flex flex-wrap gap-2">
        <Sec onClick={() => onTry({ name, description, agentIds: skill?.agentIds ?? [] })}>
          <Send size={16} /> Try it
        </Sec>
        {canEdit &&
          (skill ? (
            <>
              <Sec onClick={() => onEdit(skill)}>
                <Pencil size={15} /> Edit
              </Sec>
              <Sec onClick={remove} className="text-bad">
                <Trash2 size={15} /> Delete
              </Sec>
            </>
          ) : (
            entry && <Prim onClick={() => onInstall(entry)}>Install</Prim>
          ))}
      </div>

      {skill && (
        <section className="space-y-2">
          <Label>Helpers with this skill</Label>
          {agents.length === 0 ? (
            <p className="px-1 text-sm text-muted">No helpers yet.</p>
          ) : (
            <Panel>
              {agents.map((a) => {
                const on = skill.agentIds.includes(a.id);
                return <Item key={a.id} icon={<AgentAvatar agent={a} size={30} />} title={a.name} sub={`@${a.handle}`} right={canEdit ? <Switch on={on} label={a.name} disabled={busy === a.id} onChange={(v) => toggle(a.id, v)} /> : on ? <Check size={16} className="text-ok" /> : undefined} />;
              })}
            </Panel>
          )}
        </section>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}

      <MoreOptions title="Read the full instructions">
        <div className="prose-w rounded-2xl border border-line p-4 text-sm" dangerouslySetInnerHTML={{ __html: html }} />
      </MoreOptions>
      {skill && (
        <MoreOptions about="details">
          <p className="text-xs text-muted">
            Instruction file: <span className="font-mono">me/skills/{skill.slug}/SKILL.md</span>
          </p>
        </MoreOptions>
      )}
    </div>
  );
}

/** A public skill before it's added: who made it, its license, its instructions, and its source. */
export function StoreSkillDetail({ s, icon, canEdit, onAdd, onTry }: { s: StoreSkill; icon: ReactNode; canEdit: boolean; onAdd: () => void; onTry: () => void }) {
  const [content, setContent] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    api<{ content: string | null }>("GET", `/api/skill-store/${encodeURIComponent(s.id)}`).then((r) => setContent(r.content), () => setContent(null));
  }, [s.id]);
  const html = useMemo(() => (content ? renderMarkdown(content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")) : ""), [content]);
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <Tile size={56}>{icon}</Tile>
        <div className="min-w-0 flex-1 space-y-1.5">
          <h2 className="text-2xl font-bold tracking-tight">{s.name}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="grey">From {s.source.label}</Badge>
            <Badge tone={s.license.open ? "grey" : "warn"}>{s.license.label}</Badge>
            <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
              Source <ExternalLink size={12} />
            </a>
          </div>
        </div>
      </header>
      <section className="space-y-2">
        <Label>What it does</Label>
        <p className="px-1 text-[15px] leading-relaxed text-ink/90">{s.description}</p>
      </section>
      {!s.license.open && (
        <Note>
          Its license doesn't allow copying it, so read it where it lives:{" "}
          <a className="underline" href={s.url} target="_blank" rel="noreferrer">
            {s.source.label}'s repo
          </a>
          .
        </Note>
      )}
      <div className="flex flex-wrap gap-2">
        <Sec onClick={onTry}>
          <Send size={16} /> Try it
        </Sec>
        {canEdit && s.license.open && <Prim onClick={onAdd}>Install</Prim>}
      </div>
      {content === undefined ? <Loader /> : content && (
        <MoreOptions title="Read the full instructions">
          <div className="prose-w rounded-2xl border border-line p-4 text-sm" dangerouslySetInnerHTML={{ __html: html }} />
        </MoreOptions>
      )}
    </div>
  );
}

/** "Try it": the request to paste into a chat, or to start a chat with a helper that has the skill. */
export function TryDialog({ skill, agents, onClose }: { skill: { name: string; description: string; agentIds: string[] }; agents: Agent[]; onClose: () => void }) {
  const holders = skill.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
  const [pick, setPick] = useState(holders[0]?.id ?? "");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const helper = holders.find((a) => a.id === pick) ?? holders[0];
  const text = trySuggestion(skill);
  const sid = useId();

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
    if (!helper) return;
    try {
      await openDm(helper.id, text);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dlg title="Try it" sub={skill.name} onClose={onClose}>
      <p className="px-1 text-sm text-muted">{helper ? "Start a chat with this request ready. Add your own details, then send." : "Install the skill first so a helper can use it. Meanwhile, this is a request to try."}</p>
      <p className="select-all whitespace-pre-wrap rounded-2xl border border-control-line bg-control px-4 py-3.5 text-base leading-snug" aria-label="Suggested request">
        {text}
      </p>
      {holders.length > 1 && (
        <div className="flex items-center gap-2 px-1">
          <label htmlFor={sid} className="text-sm">
            Which helper?
          </label>
          <select id={sid} value={helper?.id} onChange={(e) => setPick(e.target.value)} className="h-9 rounded-full border border-control-line bg-control px-3 text-sm">
            {holders.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Sec onClick={copy}>{copied ? <><Check size={15} /> Copied</> : "Copy request"}</Sec>
        {helper && <Prim className="h-11 text-[15px]" onClick={chat}>Open chat with {helper.name}</Prim>}
      </div>
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
      {error && <p className="text-sm text-bad">{error}</p>}
    </Dlg>
  );
}

/** Give a skill to agents: one from the library (`catalogId`), the store (`storeId`) or a device (`nodeId`, `harness`, `skillId`). */
export function InstallModal({ entry, body, agents, onClose, onDone }: { entry: { name: string; description: string }; body: Record<string, string>; agents: Agent[]; onClose: () => void; onDone: (s: Skill) => void }) {
  const [agentIds, setAgentIds] = useState<string[]>(agents.length === 1 ? [agents[0].id] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    <Dlg title={`Add ${entry.name}`} sub="Which helpers should know it?" onClose={onClose}>
      <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} />
      <p className="px-1 text-sm text-faint">You can change this any time from the skill.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end">
        <Prim disabled={busy} onClick={install} className="max-sm:w-full">
          {agentIds.length ? `Add ${entry.name}` : "Add to the organization"}
        </Prim>
      </div>
    </Dlg>
  );
}

/** Starter text for the three guided questions, shown as placeholders. */
const GUIDE_HINTS = {
  what: "For example: Read the meeting notes I give you and write a short summary with decisions and next steps.",
  when: "For example: When I paste meeting notes or ask for a recap.",
  result: "For example: One page or less, decisions first, each next step with a name.",
};

/** Tags as chips, with a "+ Add" that turns into a small field. */
function TagsInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const commit = () => {
    const t = text.trim().toLowerCase().replace(/,/g, "");
    if (t && !tags.includes(t) && tags.length < 10) onChange([...tags, t]);
    setText("");
    setAdding(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {tags.map((t) => (
        <span key={t} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-control-line bg-control pl-4 pr-2 text-sm">
          {t}
          <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))} className="grid size-6 place-items-center rounded-full text-muted hover:text-ink">
            <X size={13} />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          value={text}
          aria-label="New tag"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setText("");
              setAdding(false);
            }
          }}
          className="h-9 w-32 rounded-full border border-control-line bg-control px-4 text-sm outline-none"
        />
      ) : (
        <Chip onClick={() => setAdding(true)}>
          <Plus size={14} /> Add
        </Chip>
      )}
    </div>
  );
}

export function SkillEditor({ skill, agents, onClose, onSaved, onShare }: { skill: Skill | null; agents: Agent[]; onClose: () => void; onSaved: (s: Skill) => void; onShare?: (s: Skill) => void }) {
  const guided = !skill;
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [tags, setTags] = useState<string[]>(skill?.tags ?? []);
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
    const body = { name: name.trim(), description: finalDescription, content: finalContent, tags: tags.slice(0, 10), agentIds };
    try {
      onSaved(skill ? await api<Skill>("PATCH", `/api/skills/${skill.id}`, body) : await api<Skill>("POST", "/api/skills", body));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const editor = (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="flex-1 px-1 text-[13px] tracking-wide text-faint">Full instructions</span>
        <Seg
          label="Instructions view"
          value={preview ? "preview" : "write"}
          onChange={(v) => setPreview(v === "preview")}
          options={[
            ["write", "Write"],
            ["preview", "Preview"],
          ]}
        />
      </div>
      {preview ? (
        <div aria-label="Preview of the instructions" className="prose-w max-h-[50vh] min-h-48 overflow-y-auto rounded-2xl border border-control-line bg-control p-4 text-sm" dangerouslySetInnerHTML={{ __html: html }} />
      ) : guided ? (
        <>
          <AreaBox className="min-h-48 font-mono text-[13px]" rows={10} value={finalContent} aria-label="Full instructions (markdown)" onChange={(e) => setRawEdit(e.target.value)} />
          <p className="px-1 text-[13px] text-faint">{rawEdit === null ? "Made from your answers above. If you change this text, this text is what gets saved." : "You edited this text, so the answers above no longer change it."}</p>
          {rawEdit !== null && (
            <Sec className="h-9 text-sm" onClick={() => setRawEdit(null)}>
              Use my answers again
            </Sec>
          )}
        </>
      ) : (
        <AreaBox className="min-h-64 font-mono text-[13px]" rows={14} value={content} aria-label="Full instructions (markdown)" onChange={(e) => setContent(e.target.value)} required />
      )}
    </div>
  );

  return (
    <Dlg title={skill ? `Edit ${skill.name}` : "New skill"} onClose={onClose} wide>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void save();
        }}
      >
        <Labeled label="Name">{(id) => <TextBox id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={guided ? "Summarize a meeting" : "Deploy the web app"} required />}</Labeled>
        {guided ? (
          <>
            <Labeled label="What should your helper do?">{(id) => <AreaBox id={id} rows={3} value={what} onChange={(e) => setWhat(e.target.value)} placeholder={GUIDE_HINTS.what} />}</Labeled>
            <Labeled label="When should it use this?" hint="Your helper reads this to decide when the skill applies.">
              {(id) => <AreaBox id={id} rows={2} value={when} onChange={(e) => setWhen(e.target.value)} maxLength={500} placeholder={GUIDE_HINTS.when} />}
            </Labeled>
            <Labeled label="What does a good result look like?">{(id) => <AreaBox id={id} rows={3} value={result} onChange={(e) => setResult(e.target.value)} placeholder={GUIDE_HINTS.result} />}</Labeled>
          </>
        ) : (
          <Labeled label="When to use it" hint="Agents read this to decide when the skill applies. Start with “Use when…”.">
            {(id) => <TextBox id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Use when asked to deploy or roll back the web app." />}
          </Labeled>
        )}
        <div className="space-y-2">
          <Label>Tags</Label>
          <TagsInput tags={tags} onChange={setTags} />
        </div>
        {guided ? <MoreOptions title="Edit the instructions directly">{editor}</MoreOptions> : editor}
        <div className="space-y-2">
          <Label>Which helpers have it</Label>
          <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} />
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {skill && onShare && (
            <Sec onClick={() => onShare(skill)}>
              <Share2 size={15} /> Share
            </Sec>
          )}
          <Sec onClick={onClose}>Cancel</Sec>
          <Prim type="submit" disabled={busy || !canSave} className="h-11 text-[15px]">
            Save skill
          </Prim>
        </div>
      </form>
    </Dlg>
  );
}

const download = (fileName: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/**
 * Share a skill (a link, a file, or a copy for another helper) and bring one in (a pasted link, a
 * .md file, or the ones your devices' harnesses already have). Without a skill it is only "Bring one in".
 */
export function SkillShare({ skill, agents, canEdit, onClose, onBrought, onDevices }: { skill: Skill | null; agents: Agent[]; canEdit: boolean; onClose: () => void; onBrought: (s: Skill) => void; onDevices: () => void }) {
  const [view, setView] = useState<"home" | "agents" | "paste" | "found">("home");
  const [picked, setPicked] = useState<string[]>(skill?.agentIds ?? []);
  const [pasted, setPasted] = useState("");
  const [found, setFound] = useState<SharedSkill | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const shared = skill ? { name: skill.name, description: skill.description, content: skill.content, tags: skill.tags } : null;
  const used = skill ? skill.agentIds.map((id) => agents.find((a) => a.id === id)?.name).filter((n): n is string => !!n) : [];

  async function copyLink() {
    if (!shared) return;
    try {
      await navigator.clipboard.writeText(skillLink(shared));
      setNote("Link copied. Anyone with it can paste it into Bring one in.");
    } catch {
      setError("Couldn't copy the link.");
    }
  }
  async function giveCopies() {
    if (!skill) return;
    setBusy(true);
    setError(null);
    try {
      const have = new Set(skill.agentIds);
      for (const id of picked) if (!have.has(id)) await api("PUT", `/api/skills/${skill.id}/agents/${id}`);
      for (const id of skill.agentIds) if (!picked.includes(id)) await api("DELETE", `/api/skills/${skill.id}/agents/${id}`);
      onBrought(skill);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const read = (s: SharedSkill | null) => {
    if (!s) return setError("That isn't a Wisp skill link or a SKILL.md file.");
    setError(null);
    setFound(s);
    setView("found");
  };
  async function bringIn() {
    if (!found) return;
    setBusy(true);
    setError(null);
    try {
      onBrought(await api<Skill>("POST", "/api/skills", { name: found.name, description: found.description, content: found.content, tags: found.tags, agentIds: [] }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const option = (icon: ReactNode, title: string, sub: string, onClick: () => void) => <Item icon={<Tile size={40}>{icon}</Tile>} title={title} sub={sub} onClick={onClick} />;

  return (
    <Dlg title={view === "agents" ? "Share with another helper" : view === "paste" ? "Paste a link" : view === "found" ? "Bring it in" : skill ? "Share a skill" : "Bring one in"} onClose={onClose}>
      {view === "home" && (
        <>
          {skill && shared && (
            <>
              <Panel>
                <Item icon={<Tile size={50}><Wand2 size={22} strokeWidth={1.7} /></Tile>} title={skill.name} sub={used.length ? `Used by ${sentence(used)}` : "No helper has it yet"} />
              </Panel>
              <Panel>
                {option(<Link2 size={20} strokeWidth={1.7} />, "Copy a link", "Anyone with it can bring the skill in", copyLink)}
                {option(<Download size={20} strokeWidth={1.7} />, "Save as a file", "A .md file you can send", () => download(`${skill.slug}.md`, skillFile(skill)))}
                {canEdit && agents.length > 0 && option(<Users size={20} strokeWidth={1.7} />, "Share with another agent", "Pick who gets a copy", () => setView("agents"))}
              </Panel>
            </>
          )}
          {canEdit && (
            <>
              {skill && <Label>Bring one in</Label>}
              <Panel>
                {option(<Link2 size={20} strokeWidth={1.7} />, "Paste a link", "From a shared skill", () => setView("paste"))}
                {option(<FileText size={20} strokeWidth={1.7} />, "Choose a file", "A .md skill file", () => file.current?.click())}
                {option(<Laptop size={20} strokeWidth={1.7} />, "From your devices", "Skills found in your harnesses", onDevices)}
              </Panel>
              <input
                ref={file}
                type="file"
                accept=".md,text/markdown,text/plain"
                className="sr-only"
                aria-label="Choose a skill file"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) read(readSkillFile(await f.text(), f.name));
                }}
              />
            </>
          )}
        </>
      )}
      {view === "agents" && skill && (
        <>
          <AgentPicker agents={agents} value={picked} onChange={setPicked} />
          <div className="flex justify-end gap-2">
            <Sec onClick={() => setView("home")}>Back</Sec>
            <Prim className="h-11 text-[15px]" disabled={busy} onClick={giveCopies}>
              Share
            </Prim>
          </div>
        </>
      )}
      {view === "paste" && (
        <>
          <AreaBox rows={4} autoFocus value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="wisp-skill:…" aria-label="Skill link" className="font-mono text-[13px]" />
          <div className="flex justify-end gap-2">
            <Sec onClick={() => setView("home")}>Back</Sec>
            <Prim className="h-11 text-[15px]" disabled={!pasted.trim()} onClick={() => read(readSkillLink(pasted) ?? (pasted.includes("---") || pasted.includes("#") ? readSkillFile(pasted) : null))}>
              Continue
            </Prim>
          </div>
        </>
      )}
      {view === "found" && found && (
        <>
          <Panel>
            <Item icon={<Tile size={50}><Wand2 size={22} strokeWidth={1.7} /></Tile>} title={found.name} sub={<span className="whitespace-normal">{found.description || "No description"}</span>} />
          </Panel>
          <p className="px-1 text-sm text-faint">It comes into your skills. Then pick which helpers have it.</p>
          <div className="flex justify-end gap-2">
            <Sec onClick={() => setView("home")}>Back</Sec>
            <Prim className="h-11 text-[15px]" disabled={busy} onClick={bringIn}>
              Bring it in
            </Prim>
          </div>
        </>
      )}
      {note && (
        <p role="status" className="px-1 text-sm text-ok">
          {note}
        </p>
      )}
      {error && <p className="px-1 text-sm text-bad">{error}</p>}
    </Dlg>
  );
}

const sentence = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
