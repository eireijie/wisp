import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowUp, Copy, ExternalLink, Loader2, MoreHorizontal, Plus } from "lucide-react";
import { harnessLabel, type Connector, type HarnessCatalog, type HarnessLogin, type HarnessSettings, type HarnessSettingsChange, type HarnessSettingItem } from "@wisp/core";
import { api } from "../../api.ts";
import { useDevices } from "../../devices.ts";
import { href } from "../../router.ts";
import { useStore } from "../../store.ts";
import { Button, CopyBlock, Input, Menu, Modal, Pill, cx } from "../../components/ui.tsx";
import { Card, Section, Select, Toggle } from "./parts.tsx";

interface HarnessesResponse {
  device: { id: string; name: string };
  harnesses: HarnessSettings[];
  agents: { id: string; handle: string; name: string; harness: string }[];
  catalog: HarnessCatalog[];
}

const OTHER = "\u0000other";

/**
 * Each harness's own settings on one of your devices, read from and written to its config file
 * there: the model and provider it uses, its apps, plugins and skills. Agents can change the same
 * things when you ask them in chat.
 */
export function HarnessesPage() {
  const devices = useDevices(10_000);
  const mine = useMemo(() => (devices ?? []).filter((d) => d.mine), [devices]);
  const [pick, setPick] = useState("");
  const device = mine.find((d) => d.id === pick) ?? mine.find((d) => d.online) ?? mine[0];
  const [data, setData] = useState<HarnessesResponse | null>(null);
  const [tab, setTab] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const online = !!device?.online;

  useEffect(() => {
    setData(null);
    setError(null);
    if (!device?.id || !online) return;
    let live = true;
    api<HarnessesResponse>("GET", `/api/nodes/${device.id}/harness-settings`).then(
      (r) => live && setData(r),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [device?.id, online]);

  const current = data?.harnesses.find((h) => h.harness === tab) ?? data?.harnesses[0];
  const replace = (s: HarnessSettings) => setData((d) => d && { ...d, harnesses: d.harnesses.map((h) => (h.harness === s.harness ? s : h)) });
  /** Show one harness as one of its accounts (or again, after a sign-in). */
  const load = async (harness: string, account: string) => {
    if (!device) return;
    const r = await api<HarnessesResponse>("GET", `/api/nodes/${device.id}/harness-settings?harness=${encodeURIComponent(harness)}&account=${encodeURIComponent(account)}`);
    const s = r.harnesses.find((h) => h.harness === harness);
    if (s) setData((d) => d && { ...d, agents: r.agents, harnesses: d.harnesses.map((h) => (h.harness === harness ? s : h)) });
  };

  return (
    <>
      {devices === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !device ? (
        <p className="text-sm text-muted rounded-xl border border-dashed border-line p-4">
          No devices of yours yet.{" "}
          <a className="text-accent-text hover:underline" href={href({ view: "nodes" })}>
            Connect one
          </a>
          .
        </p>
      ) : (
        <>
          {mine.length > 1 && (
            <div className="mb-5">
              <Select label="Device" value={device.id} onChange={setPick}>
                {mine.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.online ? "" : " (offline)"}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {!online ? (
            <p className="text-sm text-muted">{device.name} is offline. Its harness settings show up when it's back.</p>
          ) : error ? (
            <p className="text-sm text-bad whitespace-pre-wrap">{error}</p>
          ) : !data ? (
            <p className="text-sm text-muted flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Reading {device.name}'s harnesses…
            </p>
          ) : !current ? (
            <p className="text-sm text-muted">
              No harnesses on {device.name} yet.{" "}
              <a className="text-accent-text hover:underline" href={href({ view: "settings", page: "runtimes" })}>
                Install one
              </a>
              .
            </p>
          ) : (
            <>
              <div className="mb-6 flex flex-wrap gap-2" role="tablist" aria-label="Harness">
                {data.harnesses.map((h) => (
                  <button
                    key={h.harness}
                    role="tab"
                    aria-selected={h.harness === current.harness}
                    onClick={() => setTab(h.harness)}
                    className={cx("h-9 rounded-full px-4 text-sm", h.harness === current.harness ? "bg-ink text-bg font-semibold" : "bg-chip hover:bg-hover")}
                  >
                    {harnessLabel(h.harness)}
                  </button>
                ))}
              </div>
              <HarnessPanel key={`${device.id}:${current.harness}`} device={data.device} settings={current} agents={data.agents} catalog={data.catalog.find((c) => c.harness === current.harness)} onChange={replace} onLoad={(account) => load(current.harness, account)} />
            </>
          )}
        </>
      )}
    </>
  );
}

function HarnessPanel({ device, settings, agents, catalog, onChange, onLoad }: { device: HarnessesResponse["device"]; settings: HarnessSettings; agents: HarnessesResponse["agents"]; catalog: HarnessCatalog | undefined; onChange: (s: HarnessSettings) => void; onLoad: (account: string) => Promise<void> }) {
  const label = harnessLabel(settings.harness);
  const users = agents.filter((a) => a.harness === settings.harness);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sharing, setSharing] = useState<HarnessSettingItem | null>(null);

  const change = async (key: string, changes: HarnessSettingsChange[], optimistic?: HarnessSettings) => {
    setBusy(key);
    setError(null);
    if (optimistic) onChange(optimistic);
    try {
      onChange(await api<HarnessSettings>("PATCH", `/api/nodes/${device.id}/harness-settings/${settings.harness}`, { changes, account: settings.account }));
    } catch (e) {
      if (optimistic) onChange(settings);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const toggle = (kind: "app" | "plugin" | "skill", item: HarnessSettingItem, enabled: boolean) => {
    const list = kind === "app" ? "apps" : kind === "plugin" ? "plugins" : "skills";
    change(`${kind}:${item.id}`, [{ op: "toggle", kind, id: item.id, enabled }], { ...settings, [list]: settings[list].map((i) => (i.id === item.id ? { ...i, enabled } : i)) });
  };
  const openConfig = async () => {
    setError(null);
    try {
      await api("POST", `/api/nodes/${device.id}/harness-settings/${settings.harness}/open?account=${encodeURIComponent(settings.account)}`);
      setNote(`Opened on ${device.name}.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (settings.error) return <p className="text-sm text-bad whitespace-pre-wrap">{settings.error}</p>;
  return (
    <div className="space-y-8">
      <header>
        <h3 className="text-2xl font-bold tracking-tight">{label}</h3>
        <p className="mt-1 text-sm text-muted">
          On {device.name}
          {users.length > 0 && <> · used by {users.map((a) => a.name).join(", ")}</>}
        </p>
      </header>

      {(settings.multiAccount || settings.accounts.length > 1) && <Accounts device={device} settings={settings} users={users} onLoad={onLoad} />}

      {settings.fixed?.includes("file") && <p className="text-[13px] text-muted">{settings.configPath.split("/").pop()} has comments in it, so Wisp only shows it. Change it on {device.name}.</p>}

      <Card>
        <ModelRow settings={settings} catalog={catalog} busy={busy === "model"} onPick={(model) => change("model", [{ op: "model", model }])} />
        {settings.providers && (
          <div className="px-4 py-3 flex items-center justify-between gap-4">
            <label htmlFor="harness-provider" className="text-sm font-medium">
              Provider
            </label>
            <select
              id="harness-provider"
              value={settings.provider ?? ""}
              disabled={busy === "provider" || !!settings.fixed?.some((f) => f === "provider" || f === "file")}
              onChange={(e) => change("provider", [{ op: "provider", provider: e.target.value }], { ...settings, provider: e.target.value })}
              className="h-8 max-w-[60%] rounded-lg border border-line bg-panel px-2 text-sm"
            >
              {!settings.provider && <option value="">Default</option>}
              {settings.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                  {p.signedIn ? "" : " (not signed in)"}
                </option>
              ))}
            </select>
          </div>
        )}
      </Card>

      {error && <p className="text-sm text-bad whitespace-pre-wrap">{error}</p>}

      <WispAndDeviceApps settings={settings} users={users} busy={busy} onToggle={(item, on) => toggle("app", item, on)} />

      <Section title="Plugins and skills" action={<GetMore href={href({ view: "skills" })} />}>
        {settings.plugins.length + settings.skills.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <Card>
            {settings.plugins.map((p) => (
              <ItemRow key={`p:${p.id}`} item={p} note={p.description ? `${label} plugin · ${p.description}` : `${label} plugin`} busy={busy === `plugin:${p.id}`} onToggle={(on) => toggle("plugin", p, on)} />
            ))}
            {settings.skills.map((s) => (
              <ItemRow key={`s:${s.id}`} item={s} note={s.description ? `Skill · ${s.description}` : "Skill"} busy={busy === `skill:${s.id}`} onToggle={(on) => toggle("skill", s, on)} onShare={() => setSharing(s)} />
            ))}
          </Card>
        )}
      </Section>

      {users[0] && <AskBox agent={users[0]} harness={label} device={device.name} />}

      <div className="flex flex-wrap items-center gap-3">
        <button className="text-[13px] text-muted hover:text-ink" title={settings.configPath} onClick={openConfig}>
          Open config file
        </button>
        {note && <span className="text-[13px] text-muted">{note}</span>}
      </div>

      {sharing && <ShareSkill deviceId={device.id} harness={settings.harness} account={settings.account} skill={sharing} onClose={() => setSharing(null)} onShared={(n) => (setSharing(null), setNote(n))} />}
    </div>
  );
}

function ModelRow({ settings, catalog, busy, onPick }: { settings: HarnessSettings; catalog: HarnessCatalog | undefined; busy: boolean; onPick: (model: string) => void }) {
  const models = [...(catalog?.models ?? []), ...(settings.modelChoices ?? []).filter((id) => !catalog?.models.some((m) => m.id === id)).map((id) => ({ id, label: id }))];
  const fixed = !!settings.fixed?.some((f) => f === "model" || f === "file");
  // Hermes lists its models as "provider:model"
  const both = settings.provider && settings.model ? `${settings.provider}:${settings.model}` : null;
  const value = both && models.some((m) => m.id === both) ? both : settings.model;
  const known = !value || models.some((m) => m.id === value);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onPick(text.trim());
    setTyping(false);
  };
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-4">
      <label htmlFor="harness-model" className="text-sm font-medium">
        Model
      </label>
      {typing ? (
        <form onSubmit={submit} className="flex items-center gap-2">
          <input id="harness-model" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Model name" className="h-8 w-56 rounded-lg border border-line bg-panel px-2 text-sm" />
          <Button type="submit" className="h-8">
            Save
          </Button>
          <Button type="button" variant="ghost" className="h-8" onClick={() => setTyping(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <select
          id="harness-model"
          value={value ?? ""}
          disabled={busy || fixed}
          onChange={(e) => (e.target.value === OTHER ? (setText(settings.model ?? ""), setTyping(true)) : onPick(e.target.value))}
          className="h-8 max-w-[60%] rounded-lg border border-line bg-panel px-2 text-sm"
        >
          {!settings.model && <option value="">{catalog?.defaultModel ? `Default (${catalog.models.find((m) => m.id === catalog.defaultModel)?.label ?? catalog.defaultModel})` : "Default"}</option>}
          {!known && <option value={value!}>{value}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {!settings.modelChoices && <option value={OTHER}>Other…</option>}
        </select>
      )}
    </div>
  );
}

/** Apps: the ones logged in once in Wisp (every agent here gets them), then the harness's own. */
function WispAndDeviceApps({ settings, users, busy, onToggle }: { settings: HarnessSettings; users: HarnessesResponse["agents"]; busy: string | null; onToggle: (item: HarnessSettingItem, on: boolean) => void }) {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Connector[]>("GET", "/api/connectors").then(setConnectors, () => setConnectors([]));
  }, []);
  const ids = users.map((a) => a.id);
  const wisp = (connectors ?? []).filter((c) => c.kind !== "secret" && c.enabled);
  const attach = async (c: Connector, on: boolean) => {
    setError(null);
    const before = connectors;
    setConnectors((list) => list && list.map((x) => (x.id === c.id ? { ...x, agentIds: on ? [...new Set([...x.agentIds, ...ids])] : x.agentIds.filter((a) => !ids.includes(a)) } : x)));
    try {
      for (const a of ids) await api(on ? "PUT" : "DELETE", `/api/connectors/${c.id}/agents/${a}`);
    } catch (e) {
      setConnectors(before);
      setError((e as Error).message);
    }
  };
  const wispNote = (c: Connector) => (c.auth?.required ? (c.auth.signedIn ? "Logged in through Wisp" : "Needs logging in, in Wisp") : "Set up in Wisp");
  return (
    <Section title="Apps" action={<GetMore href={href({ view: "connectors" })} />}>
      {wisp.length + settings.apps.length === 0 ? (
        <p className="text-sm text-muted">None yet.</p>
      ) : (
        <Card>
          {ids.length > 0 &&
            wisp.map((c) => (
              <ItemRow key={`w:${c.id}`} item={{ id: c.id, name: c.name, enabled: ids.every((a) => c.agentIds.includes(a)), canToggle: true }} note={wispNote(c)} onToggle={(on) => attach(c, on)} />
            ))}
          {settings.apps.map((a) => (
            <ItemRow key={`d:${a.id}`} item={a} note={a.canToggle ? "Set up on this device" : "Set up on this device · changed there"} busy={busy === `app:${a.id}`} onToggle={(on) => onToggle(a, on)} />
          ))}
        </Card>
      )}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </Section>
  );
}

function ItemRow({ item, note, busy, onToggle, onShare }: { item: HarnessSettingItem; note: string; busy?: boolean; onToggle: (on: boolean) => void; onShare?: () => void }) {
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{item.name}</div>
        <div className="text-xs text-muted truncate" title={item.detail ?? note}>
          {note}
        </div>
      </div>
      {onShare && (
        <Button className="h-7 px-3 text-xs" onClick={onShare}>
          Share
        </Button>
      )}
      <Toggle on={item.enabled} onChange={onToggle} label={`${item.name} on`} disabled={busy || !item.canToggle} />
    </div>
  );
}

function GetMore({ href: to }: { href: string }) {
  return (
    <a href={to} className="text-[13px] text-muted hover:text-ink">
      Get more
    </a>
  );
}

/** Ask the agent that uses this harness to change something, in its DM. */
function AskBox({ agent, harness, device }: { agent: HarnessesResponse["agents"][number]; harness: string; device: string }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setError(null);
    try {
      const dm = useStore.getState().channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agent.id}`)) ?? (await api<{ id: string }>("POST", `/api/dm/${agent.id}`));
      await api("POST", `/api/channels/${dm.id}/messages`, { body: `In ${harness}'s settings on ${device}: ${body}` });
      setText("");
      setSent(dm.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div>
      <form onSubmit={send} className="flex items-center gap-2 rounded-full border border-line bg-panel pl-4 pr-1.5 py-1.5">
        <label htmlFor="harness-ask" className="sr-only">
          Ask {agent.name} to change {harness}
        </label>
        <input id="harness-ask" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask ${agent.name} to change anything here`} className="flex-1 min-w-0 bg-transparent text-sm outline-none py-1.5" />
        <button type="submit" aria-label="Send" disabled={!text.trim()} className="size-8 shrink-0 rounded-full bg-ink text-bg grid place-items-center disabled:opacity-40">
          <ArrowUp size={16} />
        </button>
      </form>
      {sent && (
        <p className="mt-2 text-[13px] text-muted">
          Asked {agent.name}.{" "}
          <a className="text-accent-text hover:underline" href={href({ view: "chat", channelId: sent, threadId: null })}>
            See the reply
          </a>
        </p>
      )}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </div>
  );
}

/** Copy one of a harness's skills into Wisp's skills, for the agents you pick. */
function ShareSkill({ deviceId, harness, account, skill, onClose, onShared }: { deviceId: string; harness: string; account: string; skill: HarnessSettingItem; onClose: () => void; onShared: (note: string) => void }) {
  const agents = useStore((s) => s.agents);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const share = async () => {
    setBusy(true);
    setError(null);
    try {
      const file = await api<{ name: string; description: string; content: string }>("GET", `/api/nodes/${deviceId}/harness-settings/${harness}/skills/${encodeURIComponent(skill.id)}?account=${encodeURIComponent(account)}`);
      await api("POST", "/api/skills", { name: file.name.slice(0, 80), description: file.description.slice(0, 500), content: file.content, agentIds: picked });
      onShared(`${skill.name} is in Skills now${picked.length ? ` and ${picked.length === 1 ? "1 agent has" : `${picked.length} agents have`} it` : ""}.`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Share ${skill.name}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="max-h-64 overflow-y-auto rounded-xl border border-line divide-y divide-line">
          {agents.map((a) => (
            <label key={a.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-hover">
              <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a.id] : p.filter((x) => x !== a.id)))} />
              <span className="flex-1">{a.name}</span>
              <span className="text-xs text-muted">{harnessLabel(a.harness)}</span>
            </label>
          ))}
        </div>
        {error && <p className="text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={share} disabled={busy}>
            {busy ? "Sharing…" : "Share"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The harness's accounts here: which one this page shows, signing it in, adding more, and who uses which. */
function Accounts({ device, settings, users, onLoad }: { device: HarnessesResponse["device"]; settings: HarnessSettings; users: HarnessesResponse["agents"]; onLoad: (account: string) => Promise<void> }) {
  const label = harnessLabel(settings.harness);
  const current = settings.accounts.find((a) => a.id === settings.account) ?? settings.accounts[0];
  /** the name form: adding an account, or renaming the one shown */
  const [adding, setAdding] = useState<"add" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (body: unknown) => api<any>("POST", `/api/nodes/${device.id}/harness-accounts/${settings.harness}`, body);
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    run(async () => {
      if (adding === "rename" && current) {
        await act({ op: "rename", account: current.id, label: name.trim() });
        setAdding(null);
        return onLoad(current.id);
      }
      const a = await act({ op: "add", label: name.trim() });
      setName("");
      setAdding(null);
      await onLoad(a.id);
      setSigningIn(true);
    });
  };
  const using = (agentId: string) => settings.agentAccounts[agentId] ?? "default";
  return (
    <Card>
      <div className="px-4 py-3 flex flex-wrap items-center gap-3">
        <label htmlFor="harness-account" className="text-sm font-medium flex-1">
          Account
        </label>
        {current?.signedIn === true && <Pill tone="ok">Signed in</Pill>}
        {current?.signedIn === false && (
          <Button className="h-8" onClick={() => setSigningIn(true)}>
            Sign in
          </Button>
        )}
        <select id="harness-account" value={settings.account} onChange={(e) => run(() => onLoad(e.target.value))} className="h-8 max-w-[50%] rounded-lg border border-line bg-panel px-2 text-sm">
          {settings.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <Menu
          align="right"
          trigger={(_o, t) => (
            <button onClick={t} className="p-1.5 rounded-md hover:bg-hover text-muted" aria-label="More for this account">
              <MoreHorizontal size={16} />
            </button>
          )}
          items={[
            ...(settings.multiAccount ? [{ label: "Add account", icon: <Plus size={14} />, onSelect: () => (setName(""), setAdding("add")) }] : []),
            ...(current?.signedIn !== false ? [{ label: current?.signedIn ? "Sign in again" : "Sign in", onSelect: () => setSigningIn(true) }] : []),
            ...(current && !current.isDefault
              ? [
                  { label: "Rename", onSelect: () => (setName(current.label), setAdding("rename")) },
                  "divider" as const,
                  { label: "Stop using it", danger: true, onSelect: () => run(async () => (await act({ op: "remove", account: current.id }), await onLoad("default"))) },
                ]
              : []),
          ]}
        />
      </div>
      {adding && (
        <form onSubmit={add} className="px-4 py-3 flex items-center gap-2">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`Name, like "Work ${label}"`} aria-label="Account name" className="flex-1" />
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {adding === "rename" ? "Rename" : "Add"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAdding(null)}>
            Cancel
          </Button>
        </form>
      )}
      {settings.accounts.length > 1 &&
        users.map((u) => (
          <div key={u.id} className="px-4 py-3 flex items-center gap-3">
            <label htmlFor={`acct-${u.id}`} className="text-sm flex-1">
              {u.name} uses
            </label>
            <select
              id={`acct-${u.id}`}
              value={using(u.id)}
              onChange={(e) => run(async () => (await act({ op: "assign", agentId: u.id, account: e.target.value === "default" ? null : e.target.value }), await onLoad(settings.account)))}
              className="h-8 max-w-[50%] rounded-lg border border-line bg-panel px-2 text-sm"
            >
              {settings.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      {error && <p className="px-4 py-3 text-sm text-bad">{error}</p>}
      {signingIn && current && <SignIn device={device} settings={settings} account={current} onClose={() => setSigningIn(false)} onDone={() => onLoad(current.id)} />}
    </Card>
  );
}

/**
 * Signing an account in without the device's terminal: the device runs the harness's sign-in and
 * Wisp shows the link and code it prints (and passes back a code the page gives you).
 */
function SignIn({ device, settings, account, onClose, onDone }: { device: HarnessesResponse["device"]; settings: HarnessSettings; account: HarnessSettings["accounts"][number]; onClose: () => void; onDone: () => void }) {
  const label = harnessLabel(settings.harness);
  const perProvider = settings.harness === "hermes";
  const [provider, setProvider] = useState(settings.provider ?? settings.providers?.[0]?.id ?? "");
  const [login, setLogin] = useState<HarnessLogin | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const act = (body: unknown) => api<any>("POST", `/api/nodes/${device.id}/harness-accounts/${settings.harness}`, body);
  const start = async () => {
    setError(null);
    try {
      const r = await act({ op: "login", account: account.id, ...(perProvider ? { provider } : {}) });
      if ("manual" in r) setManual(r.manual);
      else setLogin(r);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (!perProvider) void start();
  }, []);
  useEffect(() => {
    if (!login || login.status !== "running") return;
    const t = setInterval(async () => {
      const next = await act({ op: "login_status", loginId: login.id }).catch(() => null);
      if (!next) return;
      setLogin(next);
      if (next.status === "done") onDone();
    }, 1500);
    return () => clearInterval(t);
  }, [login?.id, login?.status]);
  const close = () => {
    if (login?.status === "running") void act({ op: "login_cancel", loginId: login.id }).catch(() => {});
    onClose();
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!login || !code.trim()) return;
    setLogin(await act({ op: "login_input", loginId: login.id, text: code.trim() }));
    setCode("");
  };
  return (
    <Modal title={`Sign in ${label}${account.isDefault ? "" : ` · ${account.label}`}`} onClose={close}>
      <div className="space-y-4 text-sm">
        {perProvider && !login && !manual && (
          <>
            <label className="flex items-center justify-between gap-3">
              <span>Provider</span>
              <select value={provider} onChange={(e) => setProvider(e.target.value)} className="h-8 rounded-lg border border-line bg-panel px-2 text-sm">
                {(settings.providers ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end">
              <Button variant="primary" onClick={start} disabled={!provider}>
                Continue
              </Button>
            </div>
          </>
        )}
        {manual && (
          <>
            <p>
              {label} signs in on its own screen. On {device.name}, run:
            </p>
            <CopyBlock text={manual} />
          </>
        )}
        {login?.status === "running" && (
          <>
            {login.url ? (
              <a href={login.url} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2 h-10 rounded-full bg-accent text-accent-ink font-medium">
                <ExternalLink size={15} /> Open the sign-in page
              </a>
            ) : (
              <p className="text-muted flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" /> Starting {label}'s sign-in on {device.name}…
              </p>
            )}
            {login.code && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-line px-4 py-3">
                <span className="text-muted">Enter this code there</span>
                <button className="font-mono text-lg font-semibold tracking-wider inline-flex items-center gap-2" onClick={() => void navigator.clipboard?.writeText(login.code!)} title="Copy">
                  {login.code} <Copy size={14} className="text-muted" />
                </button>
              </div>
            )}
            {login.url && !login.code && (
              <form onSubmit={send} className="flex items-center gap-2">
                <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code the page gives you" aria-label="Code from the sign-in page" className="flex-1" />
                <Button type="submit" disabled={!code.trim()}>
                  Send
                </Button>
              </form>
            )}
            <p className="text-xs text-muted flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Waiting for you to finish signing in
            </p>
          </>
        )}
        {login?.status === "done" && <p className="text-ok">Signed in.</p>}
        {login?.status === "failed" && (
          <>
            <p className="text-bad whitespace-pre-wrap">{login.error ?? "The sign-in didn't finish."}</p>
            <Button onClick={() => (setLogin(null), perProvider ? undefined : void start())}>Try again</Button>
          </>
        )}
        {error && <p className="text-bad whitespace-pre-wrap">{error}</p>}
        <div className="flex justify-end">
          <Button variant={login?.status === "done" || manual ? "primary" : "ghost"} onClick={close}>
            {login?.status === "done" || manual ? "Done" : "Cancel"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
