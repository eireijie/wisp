import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Bot, LifeBuoy, ListTodo, SquarePen, Brain, CircleUser, LayoutDashboard, LogOut, Plug, Wand2, MessageSquare, Monitor, Moon, Server, Settings, Sparkles, ChevronRight, Sun, SunMoon, Users, RefreshCw, X } from "lucide-react";
import { api, connectEvents, getToken, setToken } from "./api.ts";
import { useStore } from "./store.ts";
import { go, href, useRoute, type Route } from "./router.ts";
import { useAppearance, type ModeChoice } from "./theme.ts";
import { Sidebar, WorkspaceTile } from "./components/Sidebar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { ChannelView } from "./views/ChannelView.tsx";
import { VaultView } from "./views/VaultView.tsx";
import { AgentsView } from "./views/AgentsView.tsx";
import { NodesView } from "./views/NodesView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { AuthScreen } from "./views/AuthScreen.tsx";
import { WelcomeView } from "./views/WelcomeView.tsx";
import { TeamsView } from "./views/TeamsView.tsx";
import { AboutView } from "./views/AboutView.tsx";
import { ComputersView } from "./views/ComputersView.tsx";
import { NewTask, TasksView } from "./views/TasksView.tsx";
import { DashboardView } from "./views/DashboardView.tsx";
import { ConnectorsView } from "./views/ConnectorsView.tsx";
import { SkillsView } from "./views/SkillsView.tsx";
import { HelpView } from "./views/HelpView.tsx";
import { primeTasks } from "./notifications.ts";
import { Loader, UserAvatar, cx } from "./components/ui.tsx";
import { setupProgress, useDismissed, useOnboarding } from "./onboarding.ts";
import { useSimple } from "./experience.tsx";
import { BuddyView } from "./views/BuddyView.tsx";
import { useDesktopAgents } from "./desktop.ts";
import { useHubUpdated } from "./hubUpdate.ts";

export function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
  const route = useRoute();
  useEffect(() => {
    if (!authed && route.view !== "buddy") window.warrenDesktop?.buddy.agents([], null);
  }, [authed, route.view]);
  if (route.view === "buddy") return <BuddyView />;
  if (!authed)
    return (
      <AuthScreen
        onAuthed={(t) => {
          setToken(t);
          setAuthed(true);
        }}
      />
    );
  return <Workspace />;
}

/** Phones get a bottom tab bar and full-screen pages; larger screens get the sidebar + floating panel. */
function useIsPhone() {
  const query = "(max-width: 767px)";
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/** Unread messages on the app icon: the Dock in Warren's desktop app, or the installed PWA's badge. */
function useUnreadBadge() {
  const unread = useStore((s) => s.channels.reduce((n, c) => n + (c.unread || 0), 0));
  useEffect(() => {
    const desktop = (window as { warrenDesktop?: { setBadge(n: number): void } }).warrenDesktop;
    if (desktop) return desktop.setBadge(unread);
    const nav = navigator as Navigator & { setAppBadge?(n: number): Promise<void>; clearAppBadge?(): Promise<void> };
    (unread ? nav.setAppBadge?.(unread) : nav.clearAppBadge?.())?.catch(() => {});
  }, [unread]);
}

function Workspace() {
  const me = useStore((s) => s.me);
  const load = useStore((s) => s.load);
  const handle = useStore((s) => s.handle);
  const setConnected = useStore((s) => s.setConnected);
  const newTaskOpen = useStore((s) => s.newTaskOpen);
  const route = useRoute();
  const phone = useIsPhone();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    return connectEvents(handle, setConnected);
  }, [load, handle, setConnected]);
  // so a task finishing later can be told apart from one that was already done (notifications)
  const userId = me?.user.id;
  useEffect(() => {
    if (userId) primeTasks();
  }, [userId]);
  useUnreadBadge();
  useDesktopAgents();

  // the phone-only pages have desktop equivalents, and the bare root is the chats list on phones
  useEffect(() => {
    // the bare root is the dashboard on desktops (replace, so Back doesn't bounce here again)
    if (!phone && (route.view === "chats" || (route.view === "chat" && !route.channelId))) location.replace(href({ view: "dashboard" }));
    if (!phone && route.view === "you") go({ view: "settings" });
    if (phone && route.view === "chat" && !route.channelId) go({ view: "chats" });
  }, [phone, route]);

  if (error)
    return (
      <div className="h-full grid place-items-center p-6 text-center text-sm">
        <div className="space-y-3">
          <p>Couldn't reach the Warren hub: {error}</p>
          <button className="underline" onClick={() => location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  if (!me) return <Loader />;

  const toChats = () => go({ view: "chats" });
  const toYou = () => go({ view: "you" });
  const page = (() => {
    switch (route.view) {
      case "chat":
        // the bare root: the dashboard on desktops, the chats list on phones (the effect above fixes the URL)
        if (!route.channelId) return phone ? <ChatsPage route={route} /> : <DashboardView />;
        return <ChannelView route={route} onBack={phone ? toChats : undefined} />;
      case "chats":
        return <ChatsPage route={route} />;
      case "you":
        return <YouPage />;
      case "dashboard":
        return <DashboardView />;
      case "connectors":
        return <ConnectorsView onBack={phone ? toYou : undefined} />;
      case "skills":
        return <SkillsView onBack={phone ? toYou : undefined} />;
      case "vault":
        return <VaultView path={route.path} />;
      case "agents":
        return <AgentsView agentId={route.agentId} tab={route.tab ?? null} />;
      case "teams":
        return <TeamsView teamId={route.teamId} tab={route.tab ?? null} onBack={phone ? toYou : undefined} />;
      case "about":
        return <AboutView onBack={phone ? toYou : undefined} />;
      case "tasks":
        return <TasksView onBack={phone ? toYou : undefined} />;
      case "computers":
        return <ComputersView computerId={route.computerId} teach={route.teach ?? null} />;
      case "nodes":
        return <NodesView onBack={phone ? toYou : undefined} />;
      case "settings":
        return <SettingsView page={route.page ?? null} onBack={phone ? toYou : undefined} />;
      case "welcome":
        return <WelcomeView intro={route.intro} />;
      case "help":
        return <HelpView onBack={phone ? toYou : undefined} />;
    }
  })();
  // conversations use the whole screen on phones; everything else keeps the tab bar
  const showTabs = phone && !(route.view === "chat" && route.channelId);

  return (
    <div className="h-full flex overflow-hidden bg-app">
      {!phone && (
        <aside className="w-60 shrink-0 bg-sidebar">
          <Sidebar route={route} />
        </aside>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <UpdatedBanner />
        <div className="relative flex-1 min-h-0 flex flex-col">
          {/* the floating tab bar sits over the page, so pages leave room for it at the bottom */}
          <main className={cx("flex-1 min-h-0 flex flex-col bg-panel overflow-hidden", showTabs && "[&_.overflow-y-auto]:pb-24", !phone && "m-2 ml-0 rounded-3xl border border-line shadow-panel")}>{page}</main>
          {showTabs && <TabBar route={route} />}
        </div>
      </div>
      <CommandPalette />
      {newTaskOpen && <NewTask onClose={() => useStore.setState({ newTaskOpen: false })} />}
    </div>
  );
}

/** The hub was updated while this window was open: offer the new version instead of running the old one. */
function UpdatedBanner() {
  const updated = useHubUpdated();
  const [later, setLater] = useState(false);
  if (!updated || later) return null;
  return (
    <div role="status" className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-line bg-accent/10 text-sm safe-top">
      <RefreshCw size={15} className="text-accent-text shrink-0" />
      <span className="flex-1 min-w-0">Warren was updated. Reload to get the new version.</span>
      <button className="h-7 px-3 rounded-lg bg-accent text-accent-ink text-xs font-medium shrink-0" onClick={() => location.reload()}>
        Reload
      </button>
      <button className="text-muted hover:text-ink shrink-0" onClick={() => setLater(true)} aria-label="Not now" title="Not now">
        <X size={15} />
      </button>
    </div>
  );
}

/** Phones: the same four tabs as the iPhone app, on a floating glass bar. */
function TabBar({ route }: { route: Route }) {
  const channels = useStore((s) => s.channels);
  const unread = channels.reduce((n, c) => n + (c.joined || c.kind === "dm" ? c.unread : 0), 0);
  const tab = (active: boolean, label: string, icon: ReactNode, target: string, badge?: number) => (
    <a href={target} aria-current={active ? "page" : undefined} className={cx("flex-1 flex flex-col items-center justify-center gap-0.5 h-14 rounded-full text-[11px] transition-colors", active ? "bg-ink/[0.07] text-ink font-semibold" : "text-muted")}>
      <span className="relative">
        {icon}
        {!!badge && <span className="absolute -top-1.5 -right-2.5 min-w-4 h-4 px-1 rounded-full bg-bad text-white text-[10px] font-semibold grid place-items-center">{badge > 99 ? "99+" : badge}</span>}
      </span>
      {label}
    </a>
  );
  const youViews = ["you", "settings", "nodes", "welcome", "teams", "about", "vault", "connectors", "skills", "tasks", "help", "dashboard"];
  return (
    <div className="absolute inset-x-0 bottom-0 z-30 px-4 pb-2 pointer-events-none safe-bottom">
      <nav className="glass pointer-events-auto mx-auto max-w-md flex gap-1 p-1 rounded-full" aria-label="Main">
        {tab(route.view === "chats" || route.view === "chat", "Chats", <MessageSquare size={22} strokeWidth={2.2} />, href({ view: "chats" }), unread)}
        {tab(route.view === "agents", "Agents", <Bot size={22} strokeWidth={2.2} />, href({ view: "agents", agentId: null }))}
        {tab(route.view === "computers", "Computers", <Monitor size={22} strokeWidth={2.2} />, href({ view: "computers", computerId: null }))}
        {tab(youViews.includes(route.view), "You", <CircleUser size={22} strokeWidth={2.2} />, href({ view: "you" }))}
      </nav>
    </div>
  );
}

/** Phones: the channel list as its own screen. */
function ChatsPage({ route }: { route: Route }) {
  const me = useStore((s) => s.me)!;
  const connected = useStore((s) => s.connected);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="shrink-0 px-4 pt-4 pb-2 safe-top flex items-center gap-2.5">
        <WorkspaceTile name={me.workspace.name} size={32} />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold leading-tight truncate">{me.workspace.name}</h1>
          <p className="text-xs text-muted">{connected ? "Connected" : "Reconnecting…"}</p>
        </div>
      </header>
      <div className="flex-1 min-h-0">
        <Sidebar route={route} variant="page" />
      </div>
    </div>
  );
}

/** Phones: account, devices, settings and onboarding in one place. */
function YouPage() {
  const me = useStore((s) => s.me)!;
  const { done } = useOnboarding();
  const dismissed = useDismissed();
  const simple = useSimple();
  const { progress, steps, complete } = setupProgress(done);
  const isGuest = me.role === "guest";
  /** a row with its icon in a colored rounded tile, like iOS Settings */
  const row = (icon: ReactNode, label: string, to: string | (() => void), hint?: string, desc?: string, color = "#8e8e93") => {
    const cls = "w-full text-left flex items-center gap-3 px-3.5 min-h-14 py-2 border-b border-line last:border-0 hover:bg-hover";
    const inner = (
      <>
        <span className="size-8 shrink-0 rounded-[10px] grid place-items-center" style={{ color, background: `color-mix(in oklab, ${color} 16%, transparent)` }}>{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[15px]">{label}</span>
          {desc && <span className="block text-xs text-muted">{desc}</span>}
        </span>
        {hint && <span className="text-xs text-muted tabular-nums">{hint}</span>}
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
  return (
    <div className="flex-1 overflow-y-auto safe-top">
      <div className="p-4 space-y-5">
        <div className="flex items-center gap-3 pt-2">
          <UserAvatar name={me.user.name} size={52} />
          <div className="min-w-0">
            <div className="text-lg font-semibold truncate">{me.user.name}</div>
            <div className="text-sm text-muted truncate">
              {me.user.email} · {me.role}
            </div>
          </div>
        </div>
        {!complete && <div className="rounded-3xl bg-bg overflow-hidden">{row(<Sparkles size={17} strokeWidth={2.4} />, dismissed ? "Finish setup" : "Get started", href({ view: "welcome" }), dismissed ? `${progress} of ${steps}` : `${progress}/${steps}`, undefined, "#ff9f0a")}</div>}
        <div className="rounded-3xl bg-bg overflow-hidden">
          {row(<LayoutDashboard size={17} strokeWidth={2.4} />, "Dashboard", href({ view: "dashboard" }), undefined, undefined, "#0a84ff")}
          {row(<ListTodo size={17} strokeWidth={2.4} />, "Tasks", href({ view: "tasks" }), undefined, "Work you handed to a helper", "#30b0c7")}
          {!isGuest && row(<SquarePen size={17} strokeWidth={2.4} />, "New task", () => useStore.setState({ newTaskOpen: true }), undefined, undefined, "#34c759")}
        </div>
        <div className="rounded-3xl bg-bg overflow-hidden">
          {row(<BookOpen size={17} strokeWidth={2.4} />, "Memory", href({ view: "vault", path: null }), undefined, "Notes you and your helpers share", "#af52de")}
          {row(<Brain size={17} strokeWidth={2.4} />, "About you", href({ view: "about" }), undefined, "What helpers should know about you", "#ff2d55")}
          {!simple && row(<Users size={17} strokeWidth={2.4} />, "Teams", href({ view: "teams", teamId: null }), undefined, "Groups of helpers that work together", "#5856d6")}
          {row(<Plug size={17} strokeWidth={2.4} />, "Connected apps", href({ view: "connectors" }), undefined, "Gmail, Slack and other apps helpers can use", "#ff9500")}
          {row(<Wand2 size={17} strokeWidth={2.4} />, "Skills", href({ view: "skills" }), undefined, "Things helpers know how to do", "#ffcc00")}
          {row(<Server size={17} strokeWidth={2.4} />, "Devices", href({ view: "nodes" }), undefined, "Computers running Warren", "#64748b")}
        </div>
        <div className="rounded-3xl bg-bg overflow-hidden">
          {row(<LifeBuoy size={17} strokeWidth={2.4} />, "Help", href({ view: "help" }), undefined, "Answers, setup, and what words mean", "#32ade6")}
          {row(<Settings size={17} strokeWidth={2.4} />, "Settings", href({ view: "settings" }), undefined, undefined, "#8e8e93")}
        </div>
        <ModePicker />
        <button onClick={logout} className="w-full h-12 rounded-full bg-bg text-bad text-[15px] font-medium inline-flex items-center justify-center gap-2">
          <LogOut size={17} /> Sign out
        </button>
      </div>
    </div>
  );
}

/** Light, dark, or whatever the device uses. Color themes live in Settings. */
function ModePicker() {
  const { mode, setMode } = useAppearance();
  const options: [ModeChoice, string, ReactNode][] = [
    ["system", "System", <SunMoon key="s" size={16} />],
    ["light", "Light", <Sun key="l" size={16} />],
    ["dark", "Dark", <Moon key="d" size={16} />],
  ];
  return (
    <div className="flex rounded-full bg-bg p-1" role="radiogroup" aria-label="Mode">
      {options.map(([value, label, icon]) => (
        <button key={value} role="radio" aria-checked={mode === value} onClick={() => setMode(value)} className={cx("flex-1 h-10 rounded-full text-[15px] inline-flex items-center justify-center gap-2 transition-colors", mode === value ? "bg-panel shadow-panel text-ink font-medium" : "text-muted")}>
          {icon} {label}
        </button>
      ))}
    </div>
  );
}

export async function logout() {
  await api("POST", "/api/auth/logout").catch(() => {});
  setToken(null);
  location.hash = "";
  location.reload();
}
