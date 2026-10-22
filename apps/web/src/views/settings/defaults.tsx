import { useEffect, useState } from "react";
import { HARNESSES } from "@warren/core";
import { api, ApiError } from "../../api.ts";
import { useStore } from "../../store.ts";
import { usableDevices, useDevices } from "../../devices.ts";
import { Button, Input } from "../../components/ui.tsx";
import { Card, OwnersOnly, PageHeader, Row, SavedNote, Section, Segmented, Select, useSavedFlash } from "./parts.tsx";

/** GET/PUT /api/settings/agent-defaults: what "Use my defaults" fills in for a new agent. */
export interface AgentDefaults {
  harness: string | null;
  model: string | null;
  computer: "own-vm" | "none";
  nodeId: string | null;
}

/** Harnesses a new agent can run with on a device (the ones that join from outside aren't picked here). */
const CHOICES = HARNESSES.filter((h) => h.protocol !== "mcp");

/** Settings → Agent defaults: the AI tool, model and computer new agents start with. */
export function AgentDefaultsPage() {
  const isOwner = useStore((s) => s.me?.role) === "owner";
  const devices = useDevices(15_000);
  const [saved, setSaved] = useState<AgentDefaults | null>(null);
  const [form, setForm] = useState<AgentDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, showFlash] = useSavedFlash();

  useEffect(() => {
    api<AgentDefaults>("GET", "/api/settings/agent-defaults").then(
      (d) => {
        setSaved(d);
        setForm(d);
      },
      (e) => setError(e instanceof ApiError && e.status === 404 ? "This hub doesn't have agent defaults yet. Update it from Settings → Advanced → About." : (e as Error).message),
    );
  }, []);

  if (!form) return <PageHeader title="Agent defaults">{error ?? "Loading…"}</PageHeader>;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const mine = devices ? usableDevices(devices) : [];
  const vmDevices = mine.filter((d) => d.capabilities?.vm.ok);
  const deviceChoices = form.computer === "own-vm" && vmDevices.length ? vmDevices : mine;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api<AgentDefaults>("PUT", "/api/settings/agent-defaults", { ...form, model: form.model?.trim() || null });
      setSaved(next);
      setForm(next);
      showFlash();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Agent defaults">What a new agent starts with when you pick "Use my defaults".</PageHeader>
      <OwnersOnly show={!isOwner} />
      <Section title="AI and model">
        <Card>
          <Row label="AI tool" hint="The agent program that does the work, like Claude Code or Codex.">
            <Select label="AI tool" value={form.harness ?? ""} disabled={!isOwner} onChange={(v) => setForm({ ...form, harness: v || null })}>
              <option value="">Pick for each agent</option>
              {CHOICES.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Model" hint="Leave empty to use the AI tool's own default.">
            <Input className="w-56" value={form.model ?? ""} disabled={!isOwner} placeholder="Default" onChange={(e) => setForm({ ...form, model: e.target.value })} aria-label="Model" />
          </Row>
        </Card>
      </Section>
      <Section title="Computer" description="Agents with their own computer can open apps and browse the web. Without one they only chat and use their tools.">
        <Card>
          <Row label="New agents get" hint={form.computer === "own-vm" && devices && !vmDevices.length ? "None of your devices can run a computer for an agent yet." : undefined}>
            <Segmented
              label="Computer"
              value={form.computer}
              disabled={!isOwner}
              onChange={(v) => setForm({ ...form, computer: v })}
              options={[
                ["own-vm", "Their own computer"],
                ["none", "No computer"],
              ]}
            />
          </Row>
          <Row label="Device" hint={form.computer === "own-vm" ? "Where their computers run." : "Where they run."}>
            <Select label="Device" value={form.nodeId ?? ""} disabled={!isOwner} onChange={(v) => setForm({ ...form, nodeId: v || null })}>
              <option value="">Pick one automatically</option>
              {deviceChoices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.online ? "" : " (offline)"}
                </option>
              ))}
              {form.nodeId && !deviceChoices.some((d) => d.id === form.nodeId) && <option value={form.nodeId}>A device you can't use</option>}
            </Select>
          </Row>
        </Card>
      </Section>
      {isOwner && (
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={!dirty || busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <SavedNote shown={flash} />
        </div>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </>
  );
}
