import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUp, Bot, ChevronLeft, Copy, ExternalLink, Loader2, Plus, Share2, UserPen, Download, LogIn, UserMinus, FileCog } from "lucide-react";
import { harnessLabel, type Connector, type HarnessCatalog, type HarnessLogin, type HarnessSettings, type HarnessSettingsChange, type HarnessSettingItem } from "@wisp/core";
import { api } from "../../api.ts";
import { useDevices } from "../../devices.ts";
import { href } from "../../router.ts";
import { useStore } from "../../store.ts";
import { CopyBlock, cx } from "../../components/ui.tsx";
import { MoreOptions } from "../../components/MoreOptions.tsx";
import { HarnessLogo } from "../../components/HarnessLogo.tsx";
import { Badge, Circle, Dlg, Item, Label, Panel, Pick, Prim, Sec, Seg, Switch, TextBox, Tile } from "../../components/MarketParts.tsx";
import { AgentPicker } from "../../components/ShopParts.tsx";
import { InstallHarness } from "./runtimes.tsx";

export interface HarnessesResponse {
  device: { id: string; name: string };
  harnesses: HarnessSettings[];
  agents: { id: string; handle: string; name: string; harness: string }[];
  catalog: HarnessCatalog[];
}

const OTHER = "\u0000other";

const sentence = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** The harness's tile: a neutral square with its brand mark (a plain line icon when there is none). */
const HarnessTile = ({ harness, size = 40 }: { harness: string; size?: number }) => (
  <Tile size={size}>
    <HarnessLogo harness={harness} size={Math.round(size * 0.55)} />
  </Tile>
);

/** Signed in, needs a sign-in, or unknown (the device can't tell), from the account the page shows. */
function signState(s: HarnessSettings): { text: string; badge: "Signed in" | "Sign in" | null } {
  const a = s.accounts.find((x) => x.id === s.account) ?? s.accounts[0];
  if (!a || a.signedIn === null) return { text: a?.who ?? "Account", badge: null };
  return a.signedIn ? { text: a.who ?? a.label, badge: "Signed in" } : { text: "Not signed in", badge: "Sign in" };
}

/**
 * Each harness's own settings on one of your devices, read from and written to its config file
 * there: the account it's signed in as, the model and provider it uses, its apps, plugins and skills.
 * Agents can change the same things when you ask them in chat.
 */
export function HarnessesPage() {
  const devices = useDevices(10_000);
  const mine = useMemo(() => (devices ?? []).filter((d) => d.mine), [devices]);
  const [pick, setPick] = useState("");
  const device = mine.find((d) => d.id === pick) ?? mine.find((d) => d.online) ?? mine[0];
  const [data, setData] = useState<HarnessesResponse | null>(null);
  /** the harness open: on phones the list shows until one is picked, on larger screens the first is open */
  const [tab, setTab] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
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

  const current = data?.harnesses.find((h) => h.harness === tab) ?? (tab === null ? undefined : data?.harnesses[0]);
  const shown = current ?? data?.harnesses[0];
  const replace = (s: HarnessSettings) => setData((d) => d && { ...d, harnesses: d.harnesses.map((h) => (h.harness === s.harness ? s : h)) });
  /** Show one harness as one of its accounts (or again, after a sign-in). */
  const load = async (harness: string, account: string) => {
    if (!device) return;
    const r = await api<HarnessesResponse>("GET", `/api/nodes/${device.id}/harness-settings?harness=${encodeURIComponent(harness)}&account=${encodeURIComponent(account)}`);
    const s = r.harnesses.find((h) => h.harness === harness);
    if (s) setData((d) => d && { ...d, agents: r.agents, harnesses: d.harnesses.map((h) => (h.harness === harness ? s : h)) });
  };

  const intro = <p className="px-1 text-sm text-faint">A harness is the program an agent thinks with. Sign in once and every agent that uses it is ready.</p>;

  if (devices === null) return <p className="text-sm text-muted">Loading…</p>;
  if (!device)
    return (
      <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-muted">
        No devices of yours yet.{" "}
        <a className="text-accent-text hover:underline" href={href({ view: "computers", computerId: null })}>
          Connect one
        </a>
        .
      </p>
    );

  const list = (
    <div className="space-y-4">
      <Panel>
        <Item
          icon={
            <Tile size={40}>
              <Bot size={20} strokeWidth={1.7} />
            </Tile>
          }
          title={device.name}
          sub={<span>On</span>}
          right={
            mine.length > 1 ? (
              <Pick label="Device" value={device.id} onChange={(v) => (setPick(v), setTab(null))}>
                {mine.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.online ? "" : " (offline)"}
                  </option>
                ))}
              </Pick>
            ) : undefined
          }
        />
      </Panel>
      {intro}
      {!online ? (
        <p className="px-1 text-sm text-muted">{device.name} is offline. Its harness settings show up when it's back.</p>
      ) : error ? (
        <p className="whitespace-pre-wrap px-1 text-sm text-bad">{error}</p>
      ) : !data ? (
        <p className="flex items-center gap-2 px-1 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Reading {device.name}'s harnesses…
        </p>
      ) : (
        <>
          {data.harnesses.length === 0 ? (
            <p className="px-1 text-sm text-muted">No harnesses on {device.name} yet.</p>
          ) : (
            <Panel>
              {data.harnesses.map((h) => {
                const st = signState(h);
                return (
                  <Item
                    key={h.harness}
                    icon={<HarnessTile harness={h.harness} />}
                    title={harnessLabel(h.harness)}
                    sub={st.text}
                    right={st.badge ? <Badge tone={st.badge === "Signed in" ? "green" : "grey"}>{st.badge}</Badge> : undefined}
                    onClick={() => setTab(h.harness)}
                    label={`${harnessLabel(h.harness)}, ${st.text}`}
                  />
                );
              })}
            </Panel>
          )}
          <Panel>
            <Item icon={<Tile size={40}><Download size={20} strokeWidth={1.7} /></Tile>} title="Install a harness" sub={`Add another one to ${device.name}`} onClick={() => setInstalling(true)} />
          </Panel>
        </>
      )}
    </div>
  );

  const detail =
    online && data && shown ? (
      <HarnessPanel key={`${device.id}:${shown.harness}`} device={data.device} settings={shown} agents={data.agents} catalog={data.catalog.find((c) => c.harness === shown.harness)} onChange={replace} onLoad={(account) => load(shown.harness, account)} />
    ) : null;

  return (
    <>
      {/* phones: the list, or one harness with a way back; larger screens: both side by side */}
      <div className="md:hidden">
        {current && detail ? (
          <div className="space-y-5">
            <Circle label="Back to harnesses" onClick={() => setTab(null)}>
              <ChevronLeft size={22} />
            </Circle>
            {detail}
          </div>
        ) : (
          list
        )}
      </div>
      <div className="hidden gap-8 md:grid md:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="min-w-0">{list}</div>
        <div className="min-w-0">{detail}</div>
      </div>
      {installing && <InstallHarness device={device} onClose={() => setInstalling(false)} />}
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
  const st = signState(settings);

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
    void change(`${kind}:${item.id}`, [{ op: "toggle", kind, id: item.id, enabled }], { ...settings, [list]: settings[list].map((i) => (i.id === item.id ? { ...i, enabled } : i)) });
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

  if (settings.error) return <p className="whitespace-pre-wrap text-sm text-bad">{settings.error}</p>;
  const efforts = catalog?.efforts?.length ? catalog.efforts : ["low", "medium", "high"];
  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <h2 className="t-title min-w-0 flex-1 truncate">{label}</h2>
        {st.badge && (
          <Badge tone={st.badge === "Signed in" ? "green" : "grey"}>{st.badge}</Badge>
        )}
      </header>
      {settings.fixed?.includes("file") && <p className="px-1 text-[13px] text-muted">{settings.configPath.split("/").pop()} has comments in it, so Wisp only shows it. Change it on {device.name}.</p>}

      <Accounts device={device} settings={settings} users={users} onLoad={onLoad} />

      <section className="space-y-2">
        <Label>Model</Label>
        <Panel>
          <ModelRow settings={settings} catalog={catalog} busy={busy === "model"} onPick={(model) => change("model", [{ op: "model", model }])} />
          {settings.providers && (
            <Item
              title="Provider"
              right={
                <Pick
                  label="Provider"
                  value={settings.provider ?? ""}
                  disabled={busy === "provider" || !!settings.fixed?.some((f) => f === "provider" || f === "file")}
                  onChange={(v) => change("provider", [{ op: "provider", provider: v }], { ...settings, provider: v })}
                >
                  {!settings.provider && <option value="">Default</option>}
                  {settings.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                      {p.signedIn ? "" : " (not signed in)"}
                    </option>
                  ))}
                </Pick>
              }
            />
          )}
          {settings.effort !== undefined && (
            <div className="space-y-2.5 px-4 py-3.5">
              <div className="text-body font-medium">Reasoning effort</div>
              <Seg
                label="Reasoning effort"
                value={settings.effort ?? ""}
                disabled={busy === "effort" || !!settings.fixed?.some((f) => f === "model" || f === "file")}
                onChange={(v) => change("effort", [{ op: "effort", effort: v }], { ...settings, effort: v })}
                options={efforts.map((e) => [e, e.charAt(0).toUpperCase() + e.slice(1)] as const)}
              />
              {!settings.effort && <p className="text-[13px] text-faint">Not set. {label} uses its own default.</p>}
            </div>
          )}
        </Panel>
      </section>

      {error && <p className="whitespace-pre-wrap text-sm text-bad">{error}</p>}

      <WispAndDeviceApps settings={settings} users={users} busy={busy} onToggle={(item, on) => toggle("app", item, on)} />

      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <Label>Plugins and skills</Label>
          <GetMore href={href({ view: "marketplace", section: "skills" })} />
        </div>
        {settings.plugins.length + settings.skills.length === 0 ? (
          <p className="px-1 text-sm text-muted">None yet.</p>
        ) : (
          <Panel>
            {settings.plugins.map((p) => (
              <ItemRow key={`p:${p.id}`} item={p} note="Plugin" busy={busy === `plugin:${p.id}`} onToggle={(on) => toggle("plugin", p, on)} />
            ))}
            {settings.skills.map((s) => (
              <ItemRow key={`s:${s.id}`} item={s} note="Skill" busy={busy === `skill:${s.id}`} onToggle={(on) => toggle("skill", s, on)} onShare={() => setSharing(s)} />
            ))}
          </Panel>
        )}
      </section>

      {users[0] && <AskBox agent={users[0]} harness={label} device={device.name} />}

      <MoreOptions about="its config file">
        <div className="flex flex-wrap items-center gap-3">
          <button className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink" title={settings.configPath} onClick={openConfig}>
            <FileCog size={14} /> Open config file
          </button>
          {note && <span className="text-[13px] text-muted">{note}</span>}
        </div>
      </MoreOptions>

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
  const shownName = models.find((m) => m.id === value)?.label ?? value ?? "Automatic";
  return typing ? (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 px-4 py-3">
      <span className="text-body font-medium">Default model</span>
      <TextBox autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Model name" aria-label="Model name" className="h-10 min-w-0 flex-1" />
      <Sec type="submit" className="h-10">
        Save
      </Sec>
      <Sec onClick={() => setTyping(false)} className="h-10">
        Cancel
      </Sec>
    </form>
  ) : (
    <Item
      title="Default model"
      sub={settings.model ? shownName : "Automatic"}
      right={
        <Pick
          label="Default model"
          value={value ?? ""}
          disabled={busy || fixed}
          onChange={(v) => (v === OTHER ? (setText(settings.model ?? ""), setTyping(true)) : onPick(v))}
        >
          {!settings.model && <option value="">{catalog?.defaultModel ? `Default (${catalog.models.find((m) => m.id === catalog.defaultModel)?.label ?? catalog.defaultModel})` : "Default"}</option>}
          {!known && <option value={value!}>{value}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {!settings.modelChoices && <option value={OTHER}>Other…</option>}
        </Pick>
      }
    />
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
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <Label>Apps</Label>
        <GetMore href={href({ view: "marketplace", section: "apps" })} />
      </div>
      {wisp.length + settings.apps.length === 0 ? (
        <p className="px-1 text-sm text-muted">None yet.</p>
      ) : (
        <Panel>
          {ids.length > 0 &&
            wisp.map((c) => <ItemRow key={`w:${c.id}`} item={{ id: c.id, name: c.name, enabled: ids.every((a) => c.agentIds.includes(a)), canToggle: true }} note={wispNote(c)} onToggle={(on) => attach(c, on)} />)}
          {settings.apps.map((a) => (
            <ItemRow key={`d:${a.id}`} item={a} note={a.canToggle ? "Set up on this device" : "Set up on this device · changed there"} busy={busy === `app:${a.id}`} onToggle={(on) => onToggle(a, on)} />
          ))}
        </Panel>
      )}
      {error && <p className="px-1 text-sm text-bad">{error}</p>}
    </section>
  );
}

function ItemRow({ item, note, busy, onToggle, onShare }: { item: HarnessSettingItem; note: string; busy?: boolean; onToggle: (on: boolean) => void; onShare?: () => void }) {
  return (
    <Item
      icon={<Tile size={40}><Bot size={20} strokeWidth={1.7} /></Tile>}
      title={item.name}
      sub={<span title={item.detail ?? note}>{note}</span>}
      right={
        <>
          {onShare && (
            <button type="button" onClick={onShare} className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-ink" aria-label={`Share ${item.name}`}>
              <Share2 size={14} /> Share
            </button>
          )}
          <Switch on={item.enabled} onChange={onToggle} label={`${item.name} on`} disabled={busy || !item.canToggle} />
        </>
      }
    />
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
      <form onSubmit={send} className="flex items-center gap-2 rounded-full border border-control-line bg-control py-1.5 pl-4 pr-1.5">
        <label htmlFor="harness-ask" className="sr-only">
          Ask {agent.name} to change {harness}
        </label>
        <input id="harness-ask" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask ${agent.name} to change anything here`} className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-faint" />
        <button type="submit" aria-label="Send" disabled={!text.trim()} className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-accent-ink disabled:opacity-40">
          <ArrowUp size={16} />
        </button>
      </form>
      {sent && (
        <p className="mt-2 px-1 text-[13px] text-muted">
          Asked {agent.name}.{" "}
          <a className="text-accent-text hover:underline" href={href({ view: "chat", channelId: sent, threadId: null })}>
            See the reply
          </a>
        </p>
      )}
      {error && <p className="mt-2 px-1 text-sm text-bad">{error}</p>}
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
    <Dlg title={`Share ${skill.name}`} sub="Who gets a copy?" onClose={onClose}>
      <AgentPicker agents={agents} value={picked} onChange={setPicked} />
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <Sec onClick={onClose}>Cancel</Sec>
        <Prim className="h-11 text-body" onClick={share} disabled={busy}>
          {busy ? "Sharing…" : "Share"}
        </Prim>
      </div>
    </Dlg>
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
    void run(async () => {
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
  const usedBy = (accountId: string) => users.filter((u) => using(u.id) === accountId).map((u) => u.name);
  const row = (icon: ReactNode, title: string, sub: string, onClick: () => void, danger?: boolean) => <Item icon={<Tile size={40}>{icon}</Tile>} title={title} sub={sub} onClick={onClick} danger={danger} />;
  return (
    <section className="space-y-2">
      <Label>Account</Label>
      <Panel>
        {settings.accounts.map((a) => {
          const who = usedBy(a.id);
          const shownNow = a.id === current?.id;
          return (
            <Item
              key={a.id}
              icon={<HarnessTile harness={settings.harness} />}
              title={a.who ?? a.label}
              sub={who.length ? `Used by ${sentence(who)}` : a.signedIn === false ? "Not signed in" : shownNow && settings.accounts.length > 1 ? "Showing now" : a.who && a.who !== a.label ? a.label : "Not used by an agent yet"}
              right={a.signedIn === true ? <Badge tone="green">Signed in</Badge> : a.signedIn === false ? <Badge>Sign in</Badge> : undefined}
              onClick={settings.accounts.length > 1 && !shownNow ? () => void run(() => onLoad(a.id)) : undefined}
              label={`${a.label}${shownNow ? ", showing" : ""}`}
            />
          );
        })}
        {settings.multiAccount && row(<Plus size={20} strokeWidth={1.7} />, "Add account", "Use a second login", () => (setName(""), setAdding("add")))}
        {current && current.signedIn !== false && row(<LogIn size={20} strokeWidth={1.7} />, current.signedIn ? "Sign in again" : "Sign in", "Open the sign-in page", () => setSigningIn(true))}
        {current && current.signedIn === false && row(<LogIn size={20} strokeWidth={1.7} />, "Sign in", "Open the sign-in page", () => setSigningIn(true))}
      </Panel>
      {adding && (
        <form onSubmit={add} className="flex items-center gap-2">
          <TextBox autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`Name, like "Work ${label}"`} aria-label="Account name" className="h-11 flex-1" />
          <Prim type="submit" className="h-11 text-body" disabled={!name.trim()}>
            {adding === "rename" ? "Rename" : "Add"}
          </Prim>
          <Sec onClick={() => setAdding(null)}>Cancel</Sec>
        </form>
      )}
      {(settings.accounts.length > 1 || (current && !current.isDefault)) && (
        <MoreOptions about="who uses which account, rename">
          <div className="space-y-3">
            {settings.accounts.length > 1 && (
              <Panel>
                {users.map((u) => (
                  <Item
                    key={u.id}
                    title={`${u.name} uses`}
                    right={
                      <Pick label={`${u.name} uses`} value={using(u.id)} onChange={(v) => void run(async () => (await act({ op: "assign", agentId: u.id, account: v === "default" ? null : v }), await onLoad(settings.account)))}>
                        {settings.accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label}
                          </option>
                        ))}
                      </Pick>
                    }
                  />
                ))}
              </Panel>
            )}
            {current && !current.isDefault && (
              <Panel>
                {row(<UserPen size={20} strokeWidth={1.7} />, "Rename", current.label, () => (setName(current.label), setAdding("rename")))}
                {row(<UserMinus size={20} strokeWidth={1.7} className="text-bad" />, "Stop using it", "Agents go back to the default account", () => void run(async () => (await act({ op: "remove", account: current.id }), await onLoad("default"))), true)}
              </Panel>
            )}
          </div>
        </MoreOptions>
      )}
      {error && <p className="px-1 text-sm text-bad">{error}</p>}
      {signingIn && current && <HarnessSignIn device={device} settings={settings} account={current} onClose={() => setSigningIn(false)} onDone={() => onLoad(current.id)} />}
    </section>
  );
}

/**
 * Signing an account in without the device's terminal: the device runs the harness's sign-in and
 * Wisp shows the link and code it prints (and passes back a code the page gives you).
 */
export function HarnessSignIn({ device, settings, account, onClose, onDone }: { device: HarnessesResponse["device"]; settings: HarnessSettings; account: HarnessSettings["accounts"][number]; onClose: () => void; onDone: () => void }) {
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!login || login.status !== "running") return;
    const t = setInterval(async () => {
      const next = await act({ op: "login_status", loginId: login.id }).catch(() => null);
      if (!next) return;
      setLogin(next);
      if (next.status === "done") onDone();
    }, 1500);
    return () => clearInterval(t);
  }, [login?.id, login?.status]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const step = (n: number, title: string, body: ReactNode, right?: ReactNode) => (
    <div className="flex items-start gap-3.5 px-4 py-3.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-chip text-sm font-medium">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="text-body font-medium">{title}</div>
        {body}
      </div>
      {right}
    </div>
  );
  const running = login?.status === "running" ? login : null;
  return (
    <Dlg title={`Sign in to ${label}${account.isDefault ? "" : ` · ${account.label}`}`} sub="Takes about a minute" onClose={close}>
      {perProvider && !login && !manual && (
        <>
          <label className="flex items-center justify-between gap-3 px-1 text-sm">
            <span>Provider</span>
            <Pick label="Provider" value={provider} onChange={setProvider}>
              {(settings.providers ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </Pick>
          </label>
          <div className="flex justify-end">
            <Prim onClick={start} disabled={!provider} className="h-11 text-body">
              Continue
            </Prim>
          </div>
        </>
      )}
      {manual && (
        <>
          <p className="px-1 text-sm">
            {label} signs in on its own screen. On {device.name}, run:
          </p>
          <CopyBlock text={manual} />
        </>
      )}
      {running && (
        <>
          <Panel>
            {step(
              1,
              "Open the sign-in page",
              running.url ? undefined : (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 size={14} className="animate-spin" /> Starting {label}'s sign-in on {device.name}…
                </p>
              ),
              running.url ? (
                <a href={running.url} target="_blank" rel="noreferrer" className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-control-line bg-control px-[18px] text-body font-medium hover:bg-hover">
                  Open <ExternalLink size={14} />
                </a>
              ) : undefined,
            )}
            {running.code &&
              step(
                2,
                "Enter this code there",
                <div className="font-mono text-2xl font-medium tracking-wider">{running.code}</div>,
                <Circle label="Copy code" onClick={() => void navigator.clipboard?.writeText(running.code!)}>
                  <Copy size={17} />
                </Circle>,
              )}
            {running.url &&
              !running.code &&
              step(
                2,
                "Paste the code the page gives you",
                <form onSubmit={send} id="harness-code" className="flex items-center gap-2">
                  <TextBox value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste it here" aria-label="Code from the page" className="flex-1" />
                </form>,
              )}
          </Panel>
          <p className="px-1 text-sm text-faint">
            Wisp passes the code to {label} on {device.name}. Your password stays with the harness.
          </p>
          <p className="flex items-center gap-1.5 px-1 text-xs text-muted">
            <Loader2 size={12} className="animate-spin" /> Waiting for you to finish signing in
          </p>
        </>
      )}
      {login?.status === "done" && <p className="px-1 text-ok">Signed in.</p>}
      {login?.status === "failed" && (
        <>
          <p className="whitespace-pre-wrap px-1 text-bad">{login.error ?? "The sign-in didn't finish."}</p>
          <Sec onClick={() => (setLogin(null), perProvider ? undefined : void start())}>Try again</Sec>
        </>
      )}
      {error && <p className="whitespace-pre-wrap px-1 text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        {running?.url && !running.code ? (
          <>
            <Sec onClick={close}>Cancel</Sec>
            <Prim type="submit" form="harness-code" disabled={!code.trim()} className="h-11 text-body">
              Send
            </Prim>
          </>
        ) : login?.status === "done" || manual ? (
          <Prim onClick={close} className={cx("h-11 text-body")}>
            Done
          </Prim>
        ) : (
          <Sec onClick={close}>Cancel</Sec>
        )}
      </div>
    </Dlg>
  );
}
