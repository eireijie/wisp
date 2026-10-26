import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Bot, Brain, Building2, Cpu, LifeBuoy, ListTodo, Monitor, Palette, Bell, Blocks, Plug, Server, Settings, SlidersHorizontal, SquarePen, Sparkles, Store, ChevronRight, X } from "lucide-react";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { href } from "../router.ts";
import { THEMES, useAppearance } from "../theme.ts";
import { initialsOf } from "../components/Rail.tsx";
import { OrgList, useOrgs } from "../components/OrgSwitcher.tsx";
import { useDevices } from "../devices.ts";
import { useFeatures } from "../features.ts";
import { setupProgress, useDismissed, useOnboarding } from "../onboarding.ts";
import { Toggle } from "./settings/parts.tsx";
import { SignOutButton } from "./settings/signout.tsx";
import { ASK, type AgentPolicy } from "./settings/workspace.tsx";

const ICON = { size: 20, strokeWidth: 1.8 };

/**
 * Phones: you and what's around you in one place, laid out like the iPhone settings sheet: who you are,
 * computers, apps and memory, the agent rules, notifications and appearance, help, sign out.
 * The rest of Settings is one row away.
 */
export function YouPage() {
  const me = useStore((s) => s.me)!;
  const { done } = useOnboarding();
  const dismissed = useDismissed();
  const features = useFeatures();
  const { current } = useOrgs();
  const devices = useDevices(15_000);
  const { theme } = useAppearance();
  const [orgs, setOrgs] = useState(false);
  const { progress, steps, complete } = setupProgress(done);
  const isGuest = me.role === "guest";
  const isOwner = me.role === "owner";
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  useEffect(() => {
    if (!isGuest) api<AgentPolicy>("GET", "/api/settings/agents").then(setPolicy, () => {});
  }, [isGuest]);
  const askOn = !!policy && policy.askBefore.length > 0;
  const setAsk = async (on: boolean) => {
    if (!policy) return;
    setPolicy(await api<AgentPolicy>("PUT", "/api/settings/agents", { askBefore: on ? ASK.map(([k]) => k) : [] }).catch(() => policy));
  };
  const online = devices?.filter((d) => d.online).length ?? 0;
  const roleName = isGuest ? "Guest" : isOwner ? "Owner" : "Member";
  const orgName = current?.name ?? me.workspace.name;
  const themeName = THEMES.find((t) => t.id === theme)?.name;

  /** a row with a plain line icon, like the iPhone sheet */
  const row = (icon: ReactNode, label: string, to: string | (() => void), hint?: string, desc?: string) => {
    const cls = "w-full text-left flex items-center gap-3.5 px-4 min-h-12 py-2 border-b border-line last:border-0 hover:bg-hover";
    const inner = (
      <>
        <span className="size-5 shrink-0 grid place-items-center text-muted">{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[15px]">{label}</span>
          {desc && <span className="block text-[13px] text-muted">{desc}</span>}
        </span>
        {hint && <span className="text-sm text-muted tabular-nums">{hint}</span>}
        <ChevronRight size={16} className="text-faint" />
      </>
    );
    return typeof to === "string" ? (
      <a href={to} className={cls}>
        {inner}
      </a>
    ) : (
      <button onClick={to} className={cls}>
        {inner}
      </button>
    );
  };
  const card = (children: ReactNode) => <div className="rounded-3xl bg-card overflow-hidden">{children}</div>;
  const label = (text: string) => <div className="px-4 -mb-2.5 text-[13px] font-medium text-faint">{text}</div>;

  return (
    <div className="flex-1 overflow-y-auto safe-top">
      <div className="p-[18px] space-y-5">
        <h1 className="sr-only">You</h1>
        {card(
          <a href={href({ view: "settings", page: "profile" })} className="flex items-center gap-3.5 px-4 min-h-14 hover:bg-hover">
            <span className="circle shrink-0" style={{ width: 48, height: 48 }}>
              {initialsOf(me.user.name)}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-medium truncate">{me.user.name}</span>
              <span className="block text-[13px] text-muted truncate">
                {roleName} · {orgName}
              </span>
            </span>
            <ChevronRight size={16} className="text-faint" />
          </a>,
        )}
        {!complete && !isGuest && card(row(<Sparkles {...ICON} />, dismissed ? "Finish setup" : "Get started", href({ view: "welcome" }), dismissed ? `${progress} of ${steps}` : `${progress}/${steps}`))}
        {card(
          <>
            {!isGuest && row(<Monitor {...ICON} />, "Computers and devices", href({ view: "computers", computerId: null }), devices ? `${online} online` : undefined)}
            {!isGuest && row(<Store {...ICON} />, "Connect apps", href({ view: "marketplace" }), undefined, "Tools and skills for your agents")}
            {row(<BookOpen {...ICON} />, "Memory", href({ view: "vault", path: null }), isGuest ? "Shared folder" : undefined)}
            {row(<Building2 {...ICON} />, orgName, () => setOrgs(true), undefined, "Switch organization")}
          </>,
        )}
        {!isGuest && (
          <>
            {label("Agents")}
            {card(
              <>
                <div className="flex items-center gap-3.5 px-4 min-h-12 py-2 border-b border-line">
                  <span className="size-5 shrink-0 grid place-items-center text-muted">
                    <Bot {...ICON} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[15px]">Ask before risky actions</span>
                    <span className="block text-[13px] text-muted">Shell, apps and computer use</span>
                  </span>
                  <Toggle on={askOn} onChange={setAsk} label="Ask before risky actions" disabled={!isOwner || !policy} />
                </div>
                {row(<Cpu {...ICON} />, "Default model", href({ view: "settings", page: "agent-defaults" }), "Each AI tool")}
                {row(<Plug {...ICON} />, "Agents policy", href({ view: "settings", page: "agents" }))}
              </>,
            )}
          </>
        )}
        {card(
          <>
            {row(<Bell {...ICON} />, "Notifications", href({ view: "settings", page: "notifications" }))}
            {row(<Palette {...ICON} />, "Appearance", href({ view: "settings", page: "appearance" }), themeName)}
            {row(<SlidersHorizontal {...ICON} />, "App behavior", href({ view: "settings", page: "preferences" }))}
            {row(<LifeBuoy {...ICON} />, "Help", href({ view: "help" }), undefined, "Answers, setup, and what words mean")}
          </>,
        )}
        {!isGuest &&
          card(
            <>
              {features.tasks && row(<ListTodo {...ICON} />, "Tasks", href({ view: "tasks" }), undefined, "Work you handed to an agent")}
              {features.tasks && row(<SquarePen {...ICON} />, "New task", () => useStore.setState({ newTaskOpen: true }))}
              {row(<Brain {...ICON} />, "About you", href({ view: "about" }), undefined, "What agents should know about you")}
              {row(<Server {...ICON} />, "Computers", href({ view: "computers", computerId: null }), undefined, "Computers running Wisp")}
              {row(<Blocks {...ICON} />, "Mods", href({ view: "mods" }), undefined, "Optional parts of Wisp")}
            </>,
          )}
        {card(row(<Settings {...ICON} />, "All settings", href({ view: "settings" })))}
        <SignOutButton icon={false} className="w-full min-h-12 rounded-3xl bg-card text-bad text-[15px] font-medium" />
      </div>
      {orgs && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && setOrgs(false)}>
          <div role="dialog" aria-modal="true" aria-label="Organizations" className="w-full bg-panel border-t border-line rounded-t-[16px] pb-6 safe-bottom">
            <div className="flex justify-end p-3.5 pb-0">
              <button onClick={() => setOrgs(false)} aria-label="Close" className="circle">
                <X size={20} />
              </button>
            </div>
            <OrgList onDone={() => setOrgs(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
