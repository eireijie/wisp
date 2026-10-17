import { useState } from "react";
import { Plus, Smile, X } from "lucide-react";
import { TEAM_TEMPLATES, harnessLabel, runsInVm, type Agent } from "@warren/core";
import { api } from "../api.ts";
import { useStore, type TeamInfo } from "../store.ts";
import { go } from "../router.ts";
import { useDevices, type DeviceInfo } from "../devices.ts";
import { freeHandle } from "../views/CreateAgent.tsx";
import { computerNote, ownComputer, resolveComputer, vmOnDevice } from "../agentComputer.ts";
import { NEW_AGENT_HARNESSES, blankSlot, deviceFor, harnessNote, slotProblem, slotsFor, withLead, type Slot } from "../teamSetup.ts";
import { Button, EmojiPicker, Field, Input, Modal, Popover, Textarea, cx } from "./ui.tsx";

const selectCls = "h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm";

/** One role: its name, what it owns, and which agent fills it (one you have, or a new one on any harness). */
export function SlotEditor({ slot, onChange, onRemove, agents, taken, canCreate, showLead, devices }: { slot: Slot; onChange: (patch: Partial<Slot>) => void; onRemove?: () => void; agents: Agent[]; taken: Set<string>; canCreate: boolean; showLead?: boolean; devices: DeviceInfo[] }) {
  const computers = useStore((s) => s.computers);
  const node = deviceFor(slot.harness, devices);
  return (
    <div className="rounded-xl border border-line p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <Input value={slot.role} onChange={(e) => onChange({ role: e.target.value })} placeholder="Role, e.g. Backend" aria-label="Role name" maxLength={60} className="flex-1" />
        {showLead && (
          <label className="flex items-center gap-1.5 text-xs text-muted whitespace-nowrap cursor-pointer">
            <input type="radio" name="team-lead" checked={slot.lead} onChange={() => onChange({ lead: true })} /> Leads
          </label>
        )}
        {onRemove && (
          <button type="button" onClick={onRemove} aria-label={`Remove ${slot.role || "this role"}`} className="p-1.5 rounded-md text-muted hover:bg-hover hover:text-ink">
            <X size={15} />
          </button>
        )}
      </div>
      <Textarea rows={2} value={slot.notes} onChange={(e) => onChange({ notes: e.target.value })} placeholder="What it owns and what to send its way. The agent reads this." aria-label="What the role owns" maxLength={4000} />
      <div className="grid sm:grid-cols-2 gap-2">
        <select value={slot.pick} onChange={(e) => onChange({ pick: e.target.value })} className={selectCls} aria-label="Who fills this role">
          <option value="new">New agent…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id} disabled={taken.has(a.id) && slot.pick !== a.id}>
              @{a.handle} ({a.name}, {harnessLabel(a.harness)})
            </option>
          ))}
        </select>
        {slot.pick === "new" && (
          <select value={slot.harness} onChange={(e) => onChange({ harness: e.target.value })} className={selectCls} aria-label="Harness for the new agent" disabled={!canCreate}>
            <option value="" disabled>
              Choose a harness…
            </option>
            {NEW_AGENT_HARNESSES.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
                {h.id === slot.suggested ? " (suggested)" : ""} {harnessNote(h.id, devices) ?? ""}
              </option>
            ))}
          </select>
        )}
      </div>
      {slot.pick === "new" && <Input value={slot.name} onChange={(e) => onChange({ name: e.target.value })} placeholder={`Name (${slot.harness ? harnessLabel(slot.harness) : "new agent"})`} aria-label="Name for the new agent" maxLength={80} />}
      {slot.pick === "new" && slot.harness && canCreate && <p className="text-xs text-muted">{computerNote(ownComputer(node, computers), node)}</p>}
    </div>
  );
}

/** Make the new agents the slots ask for (on a device that has the harness) and say who fills each role. */
export async function createSlotAgents(slots: Slot[], agents: Agent[], devices: DeviceInfo[], onMade: (key: string, agentId: string) => void): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const handles = agents.map((a) => a.handle);
  for (const s of slots) {
    if (s.pick !== "new") {
      out.set(s.key, s.pick);
      continue;
    }
    const node = deviceFor(s.harness, devices);
    const computers = useStore.getState().computers;
    const choice = ownComputer(node, computers);
    const name = s.name.trim() || harnessLabel(s.harness);
    const handle = freeHandle(name, handles);
    handles.push(handle);
    // every agent gets its own computer, the same way Add agent does it
    const computerId = node ? await resolveComputer(choice, node.id, name) : null;
    const settings = { ...(choice.kind === "headless" ? { headless: true } : {}), ...(node && vmOnDevice(choice, node.id, computers) && runsInVm(s.harness) ? { runIn: "computer" as const } : {}) };
    const made = await api<Agent>("POST", "/api/agents", { harness: s.harness, name, handle, nodeId: node?.id ?? null, computerId, instructions: "", settings });
    await useStore.getState().refreshComputers();
    out.set(s.key, made.id);
    onMade(s.key, made.id);
  }
  return out;
}

/** Set up a team in one go: pick a starting point (or none), then say who fills each role. */
export function TeamBuilder({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const refreshTeams = useStore((s) => s.refreshTeams);
  const devices = useDevices(10_000);
  const [templateId, setTemplateId] = useState("");
  const [f, setF] = useState({ name: "", emoji: "", description: "" });
  const [slots, setSlots] = useState<Slot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = (devices ?? []).some((d) => (d.mine || d.shared) && d.online);
  const taken = new Set(slots.filter((s) => s.pick !== "new").map((s) => s.pick));

  const choose = (id: string) => {
    const t = TEAM_TEMPLATES.find((x) => x.id === id) ?? null;
    setTemplateId(id);
    setSlots(slotsFor(t, agents, devices));
    setF((cur) => ({ ...cur, emoji: t?.emoji ?? cur.emoji, description: t?.description ?? "" }));
  };
  const patch = (k: string, p: Partial<Slot>) => setSlots((cur) => cur.map((s) => (s.key === k ? { ...s, ...p } : p.lead ? { ...s, lead: false } : s)));
  const problem = slotProblem(slots, canCreate);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ready = withLead(slots);
      // agents made before a failure are kept, so trying again doesn't make them twice
      const who = await createSlotAgents(ready, agents, devices ?? [], (k, id) => setSlots((cur) => cur.map((s) => (s.key === k ? { ...s, pick: id } : s))));
      const lead = ready.find((s) => s.lead);
      const team = await api<TeamInfo>("POST", "/api/teams", {
        ...f,
        name: f.name.trim(),
        leadId: lead ? who.get(lead.key) : undefined,
        members: ready.map((s) => ({ agentId: who.get(s.key)!, role: s.role.trim(), roleNotes: s.notes.trim() })),
      });
      await Promise.all([refreshTeams(), useStore.getState().refreshAgents()]);
      onClose();
      go({ view: "teams", teamId: team.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New team" onClose={onClose} wide>
      <form className="space-y-5" onSubmit={submit}>
        <div>
          <div className="text-sm font-medium mb-1.5">Start from</div>
          <div className="flex flex-wrap gap-1.5">
            {[{ id: "", name: "Blank", emoji: "" }, ...TEAM_TEMPLATES].map((t) => (
              <button key={t.id} type="button" aria-pressed={templateId === t.id} onClick={() => choose(t.id)} className={cx("inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-sm", templateId === t.id ? "border-accent bg-accent-soft" : "border-line hover:bg-hover")}>
                {t.emoji} {t.name}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Roles are just a starting point. Rename them, add or remove any, and put any agent in each one.</p>
        </div>

        <div className="flex gap-3">
          <Field label="Label">
            <Popover
              up={false}
              trigger={(_, toggle) => (
                <button type="button" onClick={toggle} className="size-9 rounded-lg border border-line bg-panel text-lg grid place-items-center hover:bg-hover" aria-label="Pick a label">
                  {f.emoji || <Smile size={16} className="text-muted" />}
                </button>
              )}
            >
              {(close) => (
                <div>
                  <EmojiPicker onPick={(emoji) => (setF({ ...f, emoji }), close())} />
                  {f.emoji && (
                    <button type="button" onClick={() => (setF({ ...f, emoji: "" }), close())} className="w-full h-8 text-xs text-muted hover:text-ink border-t border-line">
                      No label
                    </button>
                  )}
                </div>
              )}
            </Popover>
          </Field>
          <div className="flex-1">
            <Field label="Name" hint="Becomes the channel #team-name and the memory folder teams/name/.">
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="web" required autoFocus />
            </Field>
          </div>
        </div>
        <Field label="What it's for" hint="Starts the team's brief, which every member reads before working.">
          <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Builds and ships the website." />
        </Field>

        <div className="space-y-2">
          <div className="text-sm font-medium">Roles</div>
          {slots.length === 0 && <p className="text-sm text-muted">No roles yet. Add one, or create the team empty and add agents later.</p>}
          {slots.map((s) => (
            <SlotEditor key={s.key} slot={s} devices={devices ?? []} agents={agents} taken={taken} canCreate={canCreate} showLead onChange={(p) => patch(s.key, p)} onRemove={() => setSlots((cur) => cur.filter((x) => x.key !== s.key))} />
          ))}
          <Button type="button" onClick={() => setSlots((cur) => [...cur, blankSlot()])}>
            <Plus size={15} /> Add a role
          </Button>
        </div>

        {(problem || error) && <p className="text-sm text-bad">{problem ?? error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !f.name.trim() || !!problem}>
            {busy ? "Creating…" : "Create team"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
