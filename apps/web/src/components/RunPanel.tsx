import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Plus, Zap } from "lucide-react";
import { harnessLabel, providerLabel, type Agent, type ConnectionModel, type ModelConnection } from "@wisp/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { href } from "../router.ts";
import { agentComputer, canUse, connectionModelList, connectionName, connectionModels, connectionSub, connectionsFor, contextColor, contextLine, effortShort, forgetConnectionModels, harnessSwitch, modelName, planLeft, patchAgent, prettyModel, runLine, useConnections, useHarnessComputers, type AgentContext, type AgentModels } from "../models.ts";
import { HarnessLogo } from "./HarnessLogo.tsx";
import { Modal, Popover, cx } from "./ui.tsx";
import { useAgentCommands } from "./SlashMenu.tsx";
import { ConnectModel } from "./ConnectModel.tsx";
import { BackHeader, GroupLabel, SegBar, ThinBar } from "./RunParts.tsx";

/**
 * The chat's one quiet line about how an agent runs: "Hermes · Opus 5.5 · High ⌄" above the
 * message box on phones (it opens a sheet), "Opus 5.5 · High ⌄" inside the composer on larger
 * screens (it opens a popover). Either opens the same panel: harness, model, effort, context, plan.
 */
export function ModelLine({ place, agent, ctx, models, channelId, threadId, canEdit }: { place: "phone" | "desktop"; agent: Agent; ctx: AgentContext; models: AgentModels | null; channelId: string; threadId?: string; canEdit: boolean }) {
  const [sheet, setSheet] = useState(false);
  const text = runLine(ctx, models, place === "phone");
  const trigger = (open: boolean, toggle: () => void) => (
    <button
      type="button"
      onClick={canEdit ? toggle : undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`${text}. Change harness, model or effort`}
      title={canEdit ? undefined : text}
      className={cx("inline-flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap text-[12px] leading-none text-muted", canEdit && "hover:text-ink", open && "text-ink")}
    >
      {ctx.fast && ctx.fastAvailable && <Zap size={11} className="shrink-0 fill-current" aria-hidden />}
      <span className="truncate">{text}</span>
      {canEdit && <ChevronDown size={11} className={cx("shrink-0 transition-transform duration-200", open && "rotate-180")} aria-hidden />}
    </button>
  );
  if (place === "phone")
    return (
      <>
        {trigger(sheet, () => setSheet(true))}
        {sheet && (
          <Modal title={agent.name} headerless onClose={() => setSheet(false)} contentClassName="!px-4 !pb-4" label={`How ${agent.name} runs`}>
            <div className="mx-auto mt-2 mb-3 h-1 w-9 rounded-full bg-ink/20" aria-hidden />
            <RunPanel big agent={agent} ctx={ctx} models={models} channelId={channelId} threadId={threadId} close={() => setSheet(false)} />
          </Modal>
        )}
      </>
    );
  return (
    <Popover align="right" className="w-[296px] !rounded-xl p-1.5" trigger={trigger}>
      {(close) => <RunPanel agent={agent} ctx={ctx} models={models} channelId={channelId} threadId={threadId} close={close} />}
    </Popover>
  );
}

type View = "main" | "harness" | "model" | "connect";

/** Harness ›, Model ›, effort, context and plan; the pickers open in place. */
export function RunPanel({ agent, ctx, models, channelId, threadId, close, big }: { agent: Agent; ctx: AgentContext; models: AgentModels | null; channelId?: string; threadId?: string; close: () => void; big?: boolean }) {
  const [view, setView] = useState<View>("main");
  const [error, setError] = useState<string | null>(null);
  const go = (v: View) => (setError(null), setView(v));
  const [brief, setBrief] = useState(false);
  // a failed toggle's error goes after a few seconds; a picker's stays until the next try
  useEffect(() => {
    if (!error || !brief) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error, brief]);
  const save = async (body: unknown, then: View = "main", opts?: { brief?: boolean }): Promise<boolean> => {
    setError(null);
    try {
      await patchAgent(agent.id, body);
      setView(then);
      return true;
    } catch (e) {
      setBrief(!!opts?.brief);
      setError((e as Error).message);
      return false;
    }
  };
  const err = error && <p className="px-2.5 py-1.5 text-[12px] leading-snug text-bad">{error}</p>;
  // each sub-page slides in from the side (a fade with reduced motion)
  return (
    <div key={view} className={cx(view !== "main" && "m-panel")}>
      {view === "main" && <Main agent={agent} ctx={ctx} models={models} channelId={channelId} threadId={threadId} big={big} go={go} close={close} save={save} error={err} />}
      {view === "harness" && <HarnessPicker agent={agent} ctx={ctx} models={models} big={big} onBack={() => go("main")} save={save} error={err} />}
      {view === "model" && <ModelPicker agent={agent} ctx={ctx} models={models} big={big} onBack={() => go("main")} onConnect={() => go("connect")} save={save} error={err} />}
      {view === "connect" && (
        <div className="space-y-2 p-1">
          <BackHeader title="Connect a model" onBack={() => go("model")} big={big} />
          <ConnectModel big={big} onDone={() => (forgetConnectionModels(), go("model"))} />
        </div>
      )}
    </div>
  );
}

const row = (big?: boolean) => cx("flex w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-hover", big ? "min-h-12 text-[15px]" : "min-h-9 text-[13px]");

type Save = (body: unknown, then?: View, opts?: { brief?: boolean }) => Promise<boolean>;

function Main({ agent, ctx, models, channelId, threadId, big, go, close, save, error }: { agent: Agent; ctx: AgentContext; models: AgentModels | null; channelId?: string; threadId?: string; big?: boolean; go: (v: View) => void; close: () => void; save: Save; error: ReactNode }) {
  const name = modelName(ctx, models);
  const levels = ctx.efforts ?? [];
  // move the thumb right away; the save follows, and a failed save puts it back
  const savedEffort = agent.settings.effort ?? ctx.effort;
  const savedFast = !!(agent.settings.fast ?? ctx.fast);
  const [effort, setEffort] = useState(savedEffort);
  const [fast, setFast] = useState(savedFast);
  // and whatever the agent says now wins (a change from another screen, a model switch)
  useEffect(() => setEffort(savedEffort), [savedEffort]);
  useEffect(() => setFast(savedFast), [savedFast]);
  const c = contextLine(ctx);
  const plan = ctx.plan ? planLeft(ctx.plan) : null;
  const commands = useAgentCommands(agent.id);
  const shrink = commands.find((x) => x.via === "raw" && (x.name === "compact" || x.name === "compress"));
  const channelKind = useStore((s) => s.channels.find((x) => x.id === channelId)?.kind);
  const compact = async () => {
    if (!shrink || !channelId) return;
    close();
    await api("POST", `/api/channels/${channelId}/messages`, { body: `${channelKind === "dm" ? "" : `@${agent.handle} `}/${shrink.name}`, threadId });
  };
  // phones: the name left, the value right (an iOS settings row); larger screens: a narrow label column
  const label = (t: string) => <span className={cx("shrink-0", big ? "text-ink" : "w-16 text-muted")}>{t}</span>;
  return (
    <div className="space-y-1">
      {big ? (
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
          <button type="button" onClick={() => go("harness")} className={row(big)}>
            {label("Harness")}
            <span className="ml-auto min-w-0 truncate text-right text-muted">{harnessLabel(ctx.harness)}</span>
            <ChevronRight size={15} className="shrink-0 text-faint" />
          </button>
          <button type="button" onClick={() => go("model")} className={row(big)}>
            {label("Model")}
            <span className="ml-auto flex min-w-0 flex-col items-end py-1.5 text-right leading-tight">
              <span className="max-w-full truncate text-muted">{name.name}</span>
              {name.provider && <span className="text-[12px] text-faint">{name.provider}</span>}
            </span>
            <ChevronRight size={15} className="shrink-0 text-faint" />
          </button>
        </div>
      ) : (
        <div>
          <button type="button" onClick={() => go("harness")} className={row(big)}>
            {label("Harness")}
            <span className="truncate">{harnessLabel(ctx.harness)}</span>
            <ChevronRight size={12} className="ml-auto shrink-0 text-faint" />
          </button>
          <button type="button" onClick={() => go("model")} className={row(big)}>
            {label("Model")}
            <span className="truncate">{name.name}</span>
            {name.provider && <span className="shrink-0 text-[12px] text-faint">{name.provider}</span>}
            <ChevronRight size={12} className="ml-auto shrink-0 text-faint" />
          </button>
        </div>
      )}
      {error}
      {levels.length > 0 && (
        <div className="px-1 pt-1">
          <SegBar
            label="Effort"
            big={big}
            value={effort && levels.includes(effort) ? effort : null}
            options={levels.map((l) => [l, effortShort(l, levels.length > 4)] as const)}
            onChange={(l) => {
              const was = effort;
              setEffort(l);
              void save({ settings: { effort: l } }, "main", { brief: true }).then((ok) => ok || setEffort(was));
            }}
          />
        </div>
      )}
      {ctx.fastAvailable && (
        <button
          type="button"
          role="switch"
          aria-checked={fast}
          onClick={() => {
            const was = fast;
            setFast(!was);
            void save({ settings: { fast: !was } }, "main", { brief: true }).then((ok) => ok || setFast(was));
          }}
          className={row(big)}
          title={ctx.fastDescription ?? undefined}
        >
          <Zap size={big ? 15 : 13} className={cx("shrink-0", fast ? "fill-current text-ink" : "text-muted")} />
          <span className={fast ? "text-ink" : "text-muted"}>Fast</span>
          {ctx.fastDescription && <span className="truncate text-[12px] text-faint">{ctx.fastDescription}</span>}
          <span className={cx("ml-auto shrink-0 text-[12px]", fast ? "text-ink" : "text-faint")}>{fast ? "On" : "Off"}</span>
        </button>
      )}
      <div className={cx("space-y-1.5 px-2.5 pt-2 pb-1.5", big ? "text-[13px]" : "text-[12px]")}>
        <div className="flex justify-between gap-2 text-muted">
          <span>{c.left}</span>
          <span className="tabular-nums">{c.right}</span>
        </div>
        <ThinBar pct={c.pct ?? 0} color={contextColor(c.pct)} />
        {plan && (
          <div className="flex justify-between gap-2 pt-1 text-muted">
            <span className="truncate">{ctx.connection ? `${providerLabel(ctx.connection.provider)} plan` : "Plan"}</span>
            <span className="shrink-0 tabular-nums">{plan.text}</span>
          </div>
        )}
        {shrink && ctx.contextUsed !== null && channelId && (
          <div className="flex justify-end pt-0.5">
            <button type="button" onClick={compact} className="text-muted hover:text-ink">
              {shrink.name === "compact" ? "Compact" : "Compress"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function HarnessPicker({ agent, ctx, models, big, onBack, save, error }: { agent: Agent; ctx: AgentContext; models: AgentModels | null; big?: boolean; onBack: () => void; save: Save; error: ReactNode }) {
  const { computers } = useHarnessComputers();
  const { connections, support } = useConnections();
  const computer = computers ? agentComputer(agent, models, computers) : undefined;
  const conn = connections?.find((c) => c.id === agent.settings.connectionId) ?? ctx.connection ?? null;
  const list = computer?.harnesses.length ? computer.harnesses : [{ id: ctx.harness, label: harnessLabel(ctx.harness), version: ctx.harnessVersion, agents: [] }];
  const [busy, setBusy] = useState(false);
  const pick = async (h: string) => {
    if (h === agent.harness) return onBack();
    // a body that can't use the agent's connection goes back to that computer's own sign-in;
    // models of one harness's own login don't carry over to another's (nor do its effort levels)
    const fits = !!conn && canUse(support, h, conn);
    // on a connection it can use, the model stays only when the new harness lists it (as the model picker does)
    setBusy(true);
    const list = fits ? await connectionModelList(agent.settings.connectionId ?? conn!.id, h, agent.id).catch(() => null) : null;
    await save(harnessSwitch(h, agent, fits, list));
    setBusy(false);
  };
  return (
    <div className="space-y-1 p-0.5">
      <BackHeader title="Harness" onBack={onBack} big={big} />
      <GroupLabel>{computer ? `On ${computer.name}` : models?.computer?.name ? `On ${models.computer.name}` : models?.device ? `On ${models.device.name}` : "Installed"}</GroupLabel>
      <div role="radiogroup" aria-label="Harness" className={cx(big && "rounded-xl border border-line bg-card p-1")}>
        {list.map((h) => {
          const fits = !conn || support.length === 0 || canUse(support, h.id, conn);
          return (
            <button key={h.id} type="button" role="radio" aria-checked={agent.harness === h.id} disabled={busy} onClick={() => void pick(h.id)} className={cx(row(big), "disabled:opacity-60")}>
              <span className="grid w-5 shrink-0 place-items-center text-muted">
                <HarnessLogo harness={h.id} size={big ? 16 : 14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{h.label}</span>
                {!fits && conn && <span className="block truncate text-[11px] text-faint">Can't use your {providerLabel(conn.provider)} {conn.kind === "oauth" ? "sign-in" : "key"}</span>}
              </span>
              {agent.harness === h.id && <Check size={big ? 16 : 13} className="shrink-0 text-accent-text" />}
            </button>
          );
        })}
      </div>
      {error}
      {computers && !computer?.reported && <p className="px-2.5 py-1 text-[12px] text-faint">{models?.computer?.name ?? "Its computer"} hasn't listed its harnesses yet.</p>}
      <a href={href({ view: "settings", page: "harnesses" })} className={cx(row(big), "text-accent-text")}>
        <Plus size={big ? 16 : 13} className="shrink-0" />
        Add a harness
      </a>
      <p className="px-2.5 pt-1 pb-1.5 text-[12px] leading-snug text-faint">{agent.name} keeps its model, memory, skills and chats when you switch.</p>
    </div>
  );
}

function ModelPicker({ agent, ctx, models, big, onBack, onConnect, save, error }: { agent: Agent; ctx: AgentContext; models: AgentModels | null; big?: boolean; onBack: () => void; onConnect: () => void; save: Save; error: ReactNode }) {
  const { connections } = useConnections();
  const usable = connectionsFor(agent.harness, connections ?? []);
  const current = agent.model ?? ctx.model;
  const onConn = agent.settings.connectionId ?? null;
  const pick = (m: ConnectionModel, connectionId: string | null) => {
    if (m.id === current && connectionId === onConn) return onBack();
    // drop an effort the new model doesn't offer
    const keep = !agent.settings.effort || !m.efforts || m.efforts.includes(agent.settings.effort);
    void save({ model: m.id, settings: { connectionId, ...(keep ? {} : { effort: null }) } });
  };
  // someone else's connection the agent runs on: shown, not offered
  const theirs = models?.connection && !models.connection.mine ? models.connection : null;
  const own = models?.catalog?.models ?? [];
  const where = models?.computer?.name ?? models?.device?.name ?? "This computer";
  return (
    <div className="max-h-[min(60vh,440px)] space-y-0.5 overflow-y-auto p-0.5">
      <BackHeader title="Model" onBack={onBack} big={big} />
      {error}
      {connections === null && <p className="px-2.5 py-2 text-[12px] text-faint">Loading…</p>}
      {usable.map((c) => (
        <ConnectionGroup key={c.id} c={c} all={connections ?? []} agent={agent} big={big} checked={onConn === c.id ? current : null} onPick={(m) => pick(m, c.id)} />
      ))}
      {theirs && (
        <Group big={big} label={providerLabel(theirs.provider)} right={theirs.kind === "oauth" ? "Someone's sign-in" : "Someone's key"}>
          {(models?.models ?? []).filter((m) => m.id === current).map((m) => (
            <ModelRow key={m.id} big={big} label={prettyModel(m.label)} checked onClick={onBack} />
          ))}
        </Group>
      )}
      {own.length > 0 && (
        <Group big={big} label={where} right="Its own sign-in">
          <More big={big} items={own} render={(m) => <ModelRow key={m.id} big={big} label={prettyModel(m.label)} checked={!onConn && (current ?? models?.catalog?.defaultModel) === m.id} onClick={() => pick(m, null)} />} />
        </Group>
      )}
      {!models?.catalog && !usable.length && <p className="px-2.5 py-2 text-[12px] text-faint">{where} hasn't listed its models yet.</p>}
      <div className={cx("pt-1.5", big && "pt-2")}>
        <button type="button" onClick={onConnect} className={cx(row(big), "text-accent-text", big && "rounded-xl border border-line bg-card")}>
          <Plus size={big ? 16 : 13} className="shrink-0" />
          Connect a model
        </button>
      </div>
    </div>
  );
}

function ConnectionGroup({ c, all, agent, big, checked, onPick }: { c: ModelConnection; all: ModelConnection[]; agent: Agent; big?: boolean; checked: string | null; onPick: (m: ConnectionModel) => void }) {
  const [list, setList] = useState<ConnectionModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // asked again when connections change (a sign-in renewed, its models listed)
  const version = useStore((s) => s.modelsVersion);
  useEffect(() => {
    let live = true;
    setError(null);
    connectionModels(c.id, agent.harness, agent.id).then(
      (m) => live && setList(m),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [c.id, agent.harness, agent.id, version]);
  return (
    <Group big={big} label={connectionName(c, all)} right={connectionSub(c, true)}>
      {error ? <p className="px-2.5 py-1.5 text-[12px] text-bad">{error}</p> : !list ? <p className="px-2.5 py-1.5 text-[12px] text-faint">Loading…</p> : list.length === 0 ? <p className="px-2.5 py-1.5 text-[12px] text-faint">No models for {harnessLabel(agent.harness)}.</p> : <More big={big} items={list} render={(m) => <ModelRow key={m.id} big={big} label={prettyModel(m.label)} checked={checked === m.id} onClick={() => onPick(m)} />} />}
      {c.lastError && <p className="px-2.5 pb-1 text-[11px] text-warn">{c.lastError}</p>}
    </Group>
  );
}

function Group({ label, right, big, children }: { label: string; right?: string; big?: boolean; children: ReactNode }) {
  return (
    <div>
      <GroupLabel right={right}>{label}</GroupLabel>
      <div role="radiogroup" aria-label={label} className={cx(big && "rounded-xl border border-line bg-card p-1")}>
        {children}
      </div>
    </div>
  );
}

/** The first few rows, then "More…" for the rest (OpenRouter lists hundreds). */
function More<T>({ items, render, big, first = 6 }: { items: T[]; render: (item: T) => ReactNode; big?: boolean; first?: number }) {
  const [all, setAll] = useState(false);
  const shown = all || items.length <= first + 1 ? items : items.slice(0, first);
  return (
    <>
      {shown.map(render)}
      {shown.length < items.length && (
        <button type="button" onClick={() => setAll(true)} className={cx(row(big), "text-muted")}>
          More…
        </button>
      )}
    </>
  );
}

function ModelRow({ label, checked, onClick, big }: { label: string; checked: boolean; onClick: () => void; big?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  // the checked one is in view when the list opens
  useEffect(() => {
    if (checked) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <button ref={ref} type="button" role="radio" aria-checked={checked} onClick={onClick} className={row(big)}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check size={big ? 16 : 13} className="shrink-0 text-accent-text" />}
    </button>
  );
}
