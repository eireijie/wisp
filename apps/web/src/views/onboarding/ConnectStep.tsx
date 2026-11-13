import { useEffect, useState, type ComponentType } from "react";
import { Plus } from "lucide-react";
import { HARNESSES, harnessLabel, runsInVm, type HarnessSettings, type ModelConnection } from "@wisp/core";
import { api } from "../../api.ts";
import { unavailable } from "../../join.ts";
import { ConnectModel } from "../../components/ConnectModel.tsx";
import { HarnessLogo } from "../../components/HarnessLogo.tsx";
import { StepHead, Tick } from "../../components/SetupShell.tsx";
import { connectionSub, readyConnection, signInProvider, useConnections } from "../../models.ts";
import type { DeviceInfo } from "../../devices.ts";
import type { HarnessesResponse, HarnessSignIn as HarnessSignInDialog } from "../settings/harnesses.tsx";

/** What the agent will run on: a harness, and the connection Wisp keeps for it (none for harnesses that sign in where they run). */
export interface Powered {
  harness: string;
  connectionId: string | null;
}

/** The two harnesses Wisp signs in for you, in the order they're offered. */
const MAIN = ["claude-code", "codex"];

/** Whether a harness is set to go, and how: Wisp's connection, or its own sign-in on the device. */
export function readiness(harness: string, connections: ModelConnection[], deviceSignedIn: boolean | null | undefined, chosen: Set<string>): Powered | null {
  const c = readyConnection(harness, connections);
  if (c) return { harness, connectionId: c.id };
  // harnesses that sign in where they run count once the person picked one that's signed in there
  if (!signInProvider(harness) && deviceSignedIn === true && chosen.has(harness)) return { harness, connectionId: null };
  return null;
}

/**
 * Connect your AI: Claude Code and Codex sign in once, to Wisp (the hub keeps the sign-in and hands
 * it to every run, on any computer). The others (Gemini, Hermes, Kimi…) are under "more" and keep
 * their sign-in where they run. Continue needs one that's ready.
 */
export function ConnectStep({ device, onNext, onSkip }: { device: DeviceInfo | undefined; onNext: (ready: Powered[]) => void; onSkip: () => void }) {
  const { connections, reload } = useConnections();
  const [settings, setSettings] = useState<HarnessSettings[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ Dialog: ComponentType<Parameters<typeof HarnessSignInDialog>[0]>; device: HarnessesResponse["device"]; settings: HarnessSettings } | null>(null);

  const load = async () => {
    if (!device) return;
    const r = await api<HarnessesResponse>("GET", `/api/nodes/${device.id}/harness-settings`).catch(() => null);
    if (r) setSettings(r.harnesses);
  };
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [device?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const installed = device?.harnesses?.map((h) => h.id) ?? [];
  const signedIn = (id: string) => {
    const s = settings.find((x) => x.harness === id);
    const a = s?.accounts.find((x) => x.isDefault) ?? s?.accounts[0];
    return a?.signedIn;
  };
  const all = connections ?? [];
  const ready = (id: string) => readiness(id, all, signedIn(id), chosen);
  const others = HARNESSES.filter((h) => h.protocol !== "mcp" && !MAIN.includes(h.id) && (installed.includes(h.id) || h.install?.npm || (runsInVm(h.id) && device?.capabilities?.vm.ok)));
  const readyList = [...MAIN, ...others.map((h) => h.id)].map(ready).filter((r): r is Powered => !!r);

  /** a harness Wisp signs in with has to be on the device first */
  const install = async (id: string) => {
    if (!device || installed.includes(id)) return true;
    setBusy(id);
    setError(null);
    try {
      await api("POST", `/api/nodes/${device.id}/install`, { harness: id });
      await api("POST", `/api/nodes/${device.id}/refresh`).catch(() => {});
      await load();
      return true;
    } catch (e) {
      setError(unavailable(e, `Installing ${harnessLabel(id)}`));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const signIn = async (id: string) => {
    if (!(await install(id))) return;
    setKeyOpen(false);
    setOpen(id);
  };
  const deviceSignIn = async (id: string) => {
    if (!device || !(await install(id))) return;
    try {
      const r = await api<HarnessesResponse>("GET", `/api/nodes/${device.id}/harness-settings?harness=${encodeURIComponent(id)}`);
      const s = r.harnesses.find((h) => h.harness === id);
      if (!s) throw new Error(`${harnessLabel(id)} isn't on ${device.name} yet`);
      const { HarnessSignIn } = await import("../settings/harnesses.tsx");
      setDialog({ Dialog: HarnessSignIn, device: r.device, settings: s });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const connected = () => {
    setOpen(null);
    setKeyOpen(false);
    reload();
  };

  return (
    <>
      <StepHead title="Connect your AI" sub="Sign in once. Wisp uses it on every computer it sets up for your agents, so you never sign in again." />
      <div className="ob-card">
        {MAIN.map((id) => {
          const c = readyConnection(id, all);
          const provider = signInProvider(id)!;
          const sub = c ? `${connectionSub(c, true)} · used for every agent` : open === id ? "Waiting for you to finish in the browser" : installed.includes(id) ? (signedIn(id) ? `On ${device?.name ?? "this computer"}. Sign in once for Wisp` : `On ${device?.name ?? "this computer"}, not signed in`) : "Wisp installs it";
          return (
            <div key={id} className="ob-rule">
              <div className="ob-row">
                <span className="ob-icon">
                  <HarnessLogo harness={id} size={20} />
                </span>
                <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                  <span className="ob-name">{harnessLabel(id)}</span>
                  <span className="ob-sub">{sub}</span>
                </div>
                {c ? (
                  <span className="ob-ok ob-pop">
                    <Tick /> Connected
                  </span>
                ) : open === id ? (
                  <button type="button" className="ob-b ob-q" onClick={() => setOpen(null)}>
                    Cancel
                  </button>
                ) : (
                  <button type="button" className={readyList.length ? "ob-b" : "ob-b ob-p"} disabled={!device || busy === id} onClick={() => void signIn(id)}>
                    {busy === id ? "Installing…" : `Sign in`}
                  </button>
                )}
              </div>
              {open === id && !c && (
                <div className="ob-inset">
                  <ConnectModel provider={provider} onDone={connected} />
                </div>
              )}
            </div>
          );
        })}
        {more &&
          others.map((h) => {
            const here = installed.includes(h.id);
            const s = here ? signedIn(h.id) : undefined;
            const picked = chosen.has(h.id);
            return (
              <div key={h.id} className="ob-row ob-rule ob-rise">
                <span className="ob-icon">
                  <HarnessLogo harness={h.id} size={20} />
                </span>
                <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                  <span className="ob-name">{h.label}</span>
                  <span className="ob-sub">{!here ? "Wisp installs it" : s === true ? `Signed in on ${device?.name ?? "this computer"}` : s === false ? "Not signed in" : "Can't tell if it's signed in"}</span>
                </div>
                {picked && s === true ? (
                  <span className="ob-ok ob-pop">
                    <Tick /> Ready
                  </span>
                ) : s === true ? (
                  <button type="button" className="ob-b" onClick={() => setChosen(new Set([...chosen, h.id]))}>
                    Use it
                  </button>
                ) : (
                  <button type="button" className="ob-b" disabled={!device || busy === h.id} onClick={() => void deviceSignIn(h.id)}>
                    {busy === h.id ? "Installing…" : here ? "Sign in" : "Install"}
                  </button>
                )}
              </div>
            );
          })}
        {!more && (
          <div className="ob-row ob-rule">
            <span className="ob-icon ob-dashed">
              <Plus size={16} />
            </span>
            <div className="flex flex-1 flex-col gap-0.5 min-w-0">
              <span className="text-[14.5px] font-medium">Gemini, Hermes, Kimi and more</span>
              <span className="ob-sub">Wisp installs them for you</span>
            </div>
            <button type="button" className="ob-b ob-q" onClick={() => setMore(true)}>
              Show all
            </button>
          </div>
        )}
      </div>
      {keyOpen && (
        <div className="ob-card p-4 ob-rise">
          <ConnectModel onDone={connected} />
        </div>
      )}
      {!device && <p className="ob-sub">Waiting for a computer to connect…</p>}
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      <div className="ob-foot">
        <span className="ob-note">
          Sign-ins stay on your Wisp server.{" "}
          {!keyOpen && (
            <button type="button" className="ob-link" onClick={() => (setOpen(null), setKeyOpen(true))}>
              Use an API key instead
            </button>
          )}
        </span>
        {!readyList.length && (
          <button type="button" className="ob-b ob-q" onClick={onSkip}>
            Skip for now
          </button>
        )}
        <button type="button" className="ob-b ob-p" disabled={!readyList.length} onClick={() => onNext(readyList)}>
          Continue
        </button>
      </div>
      {dialog && (
        <dialog.Dialog
          device={dialog.device}
          settings={dialog.settings}
          account={dialog.settings.accounts.find((a) => a.isDefault) ?? dialog.settings.accounts[0]}
          onClose={() => setDialog(null)}
          onDone={() => {
            const id = dialog.settings.harness;
            setChosen(new Set([...chosen, id]));
            void load();
          }}
        />
      )}
    </>
  );
}
