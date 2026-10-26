import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Brain, Building2, LifeBuoy, ListTodo, SquarePen, ChevronRight, LogOut, Moon, Server, Settings, Sparkles, Store, Sun, SunMoon, Blocks, X } from "lucide-react";
import { api, connectEvents, getToken, setToken } from "./api.ts";
import { useInboxCount, useStore } from "./store.ts";
import { go, href, routeForRole, useRoute, type Route } from "./router.ts";
import { useAppearance, type ModeChoice } from "./theme.ts";
import { ChatList, NewChatPicker } from "./components/ChatList.tsx";
import { Rail, chatsTarget, rememberChat, initialsOf } from "./components/Rail.tsx";
import { AgentsIcon, ChatsIcon, ComputersIcon, InboxIcon } from "./components/icons.tsx";
import { OfflineBanner, UpdatedBanner } from "./components/Banners.tsx";
import { OrgList, useOrgs } from "./components/OrgSwitcher.tsx";
import { ChannelBrowser } from "./components/Channels.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { ChannelView } from "./views/ChannelView.tsx";
import { VaultView } from "./views/VaultView.tsx";
import { AgentsView } from "./views/AgentsView.tsx";
import { NodesView } from "./views/NodesView.tsx";
import { DevicePage } from "./views/DevicePage.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { AuthScreen } from "./views/AuthScreen.tsx";
import { JoinApproval } from "./components/JoinApproval.tsx";
import { HelpPopup } from "./components/HelpPopup.tsx";
import { WelcomeView } from "./views/WelcomeView.tsx";
import { AboutView } from "./views/AboutView.tsx";
import { ComputersView } from "./views/ComputersView.tsx";
import { NewTask, TasksView } from "./views/TasksView.tsx";
import { DashboardView } from "./views/DashboardView.tsx";
import { MarketplaceView } from "./views/MarketplaceView.tsx";
import { ModsPage } from "./views/settings/features.tsx";
import { HelpView } from "./views/HelpView.tsx";
import { primeTasks } from "./notifications.ts";
import { Loader, cx } from "./components/ui.tsx";
import { setupProgress, useDismissed, useOnboarding } from "./onboarding.ts";
import { useFeatures } from "./features.ts";
import { BuddyView } from "./views/BuddyView.tsx";
import { AuthorizeView } from "./views/AuthorizeView.tsx";
import { useDesktopAgents } from "./desktop.ts";

export function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
  const route = useRoute();
  useEffect(() => {
    if (!authed && route.view !== "buddy") window.wispDesktop?.buddy.agents([], null);
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
  if (route.view === "authorize") return <AuthorizeView requestId={route.requestId} />;
  return <Workspace />;
}

/** Phones get the floating bottom bar and full-screen pages; larger screens get the rail and floating panels. */
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

/** Unread messages on the app icon: the Dock in Wisp's desktop app, or the installed PWA's badge. */
function useUnreadBadge() {
  const unread = useStore((s) => s.channels.reduce((n, c) => n + (c.unread || 0), 0));
  useEffect(() => {
    const desktop = (window as { wispDesktop?: { setBadge(n: number): void } }).wispDesktop;
    if (desktop) return desktop.setBadge(unread);
    const nav = navigator as Navigator & { setAppBadge?(n: number): Promise<void>; clearAppBadge?(): Promise<void> };
    (unread ? nav.setAppBadge?.(unread) : nav.clearAppBadge?.())?.catch(() => {});
  }, [unread]);
}

/** The chat or team with the newest message: where the Chats item lands when you haven't been in one yet. */
function newestChat(): string | null {
  const { channels } = useStore.getState();
  let best: { id: string; at: number } | null = null;
  for (const c of channels) {
    if (c.archivedAt || (c.kind === "channel" && !c.joined)) continue;
    const at = Date.parse(c.last?.at ?? c.createdAt);
    if (!best || at > best.at) best = { id: c.id, at };
  }
  return best?.id ?? null;
}

function Workspace() {
  const me = useStore((s) => s.me);
  const load = useStore((s) => s.load);
  const handle = useStore((s) => s.handle);
  const setConnected = useStore((s) => s.setConnected);
  const newTaskOpen = useStore((s) => s.newTaskOpen);
  const newChatOpen = useStore((s) => s.newChatOpen);
  const channelBrowser = useStore((s) => s.channelBrowser);
  const loaded = useStore((s) => s.channels.length > 0);
  const route = routeForRole(useRoute(), me?.role);
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

  useEffect(() => {
    if (route.view === "chat") rememberChat(route.channelId);
  }, [route]);

  // the phone-only pages have desktop equivalents, and the bare root is the chats list on phones
  useEffect(() => {
    // the bare root is the Inbox on desktops (replace, so Back doesn't bounce here again)
    if (!phone && route.view === "chat" && !route.channelId) location.replace(href({ view: "dashboard" }));
    // Chats on a desktop opens a chat beside the list: the last one you were in, else the newest
    if (!phone && route.view === "chats" && loaded) {
      const id = chatsTarget().includes("/c/") ? null : newestChat();
      if (chatsTarget().includes("/c/")) location.replace(chatsTarget());
      else if (id) location.replace(href({ view: "chat", channelId: id, threadId: null }));
    }
    if (!phone && route.view === "you") go({ view: "settings" });
    if (phone && route.view === "chat" && !route.channelId) go({ view: "chats" });
  }, [phone, route, loaded]);

  if (error)
    return (
      <div className="h-full grid place-items-center p-6 text-center text-sm">
        <div className="space-y-3">
          <p>Couldn't reach the Wisp hub: {error}</p>
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
        // the bare root: the Inbox on desktops, the chats list on phones (the effect above fixes the URL)
        if (!route.channelId) return phone ? <ChatsPage route={route} /> : <DashboardView />;
        return <ChannelView route={route} onBack={phone ? toChats : undefined} />;
      case "chats":
        return phone ? <ChatsPage route={route} /> : <EmptyChat />;
      case "you":
        return <YouPage />;
      case "dashboard":
        return <DashboardView />;
      case "marketplace":
        return <MarketplaceView section={route.section ?? "all"} onBack={phone ? toYou : undefined} />;
      // older addresses: a sign-in coming back lands on what's installed
      case "connectors":
        return <MarketplaceView section={new URLSearchParams(location.search).has("signin") ? "installed" : "apps"} onBack={phone ? toYou : undefined} />;
      case "skills":
        return <MarketplaceView section="skills" onBack={phone ? toYou : undefined} />;
      case "vault":
        return <VaultView path={route.path} />;
      case "agents":
        return <AgentsView agentId={route.agentId} tab={route.tab ?? null} />;
      case "about":
        return <AboutView onBack={phone ? toYou : undefined} />;
      case "tasks":
        return <TasksView onBack={phone ? () => go({ view: "dashboard" }) : undefined} />;
      case "computers":
        return <ComputersView computerId={route.computerId} teach={route.teach ?? null} />;
      case "nodes":
        return route.nodeId ? <DevicePage nodeId={route.nodeId} /> : <NodesView onBack={phone ? toYou : undefined} />;
      case "settings":
        return <SettingsView page={route.page ?? null} onBack={toYou} />;
      case "welcome":
        return <WelcomeView intro={route.intro} />;
      case "help":
        return <HelpView onBack={phone ? toYou : undefined} />;
      case "mods":
        return (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-4xl mx-auto px-4 md:px-8 pt-10 pb-8">
              <ModsPage />
            </div>
          </div>
        );
    }
  })();
  // conversations use the whole screen on phones; everything else keeps the tab bar
  const showTabs = phone && !(route.view === "chat" && route.channelId) && route.view !== "vault";
  // on larger screens Settings takes the whole window: its own list replaces the rail
  const fullSettings = !phone && route.view === "settings";
  const dialogs = (
    <>
      <CommandPalette />
      <JoinApproval />
      <HelpPopup />
      <UpdatedBanner phone={phone} />
      {newChatOpen && <NewChatPicker onClose={() => useStore.setState({ newChatOpen: false })} />}
      {newTaskOpen && <NewTask onClose={() => useStore.setState({ newTaskOpen: false })} />}
      {channelBrowser && <ChannelBrowser sectionId={channelBrowser.sectionId} create={channelBrowser.create} onClose={() => useStore.setState({ channelBrowser: null })} />}
    </>
  );

  if (fullSettings)
    return (
      <div className="h-full flex flex-col overflow-hidden bg-app">
        <div className="flex-1 min-h-0 flex">
          <SettingsView page={route.page ?? null} fullWindow />
        </div>
        {dialogs}
      </div>
    );

  // desktops: Chats is a column and the open chat side by side, like one panel split in two
  const withColumn = !phone && (route.view === "chat" || route.view === "chats");

  return (
    <div className="h-full flex overflow-hidden bg-app">
      {!phone && <Rail route={route} />}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="relative flex-1 min-h-0 flex">
          {withColumn && (
            <aside className="w-80 shrink-0 my-2.5 rounded-l-[28px] bg-panel overflow-hidden">
              <ChatList route={route} />
            </aside>
          )}
          {/* the floating tab bar sits over the page, so pages leave room for it at the bottom */}
          <main className={cx("flex-1 min-w-0 min-h-0 flex flex-col bg-panel overflow-hidden", showTabs && "[&_.overflow-y-auto]:pb-28", !phone && (withColumn ? "my-2.5 mr-2.5 rounded-r-[28px] border-l border-line" : "m-2.5 ml-0 rounded-[28px]"))}>
            <OfflineBanner phone={phone} />
            {page}
          </main>
          {showTabs && <TabBar route={route} />}
        </div>
      </div>
      {dialogs}
    </div>
  );
}

/** Desktops: Chats with no chat open yet. */
function EmptyChat() {
  return (
    <div className="flex-1 grid place-items-center p-8 text-center text-muted">
      <div className="space-y-2">
        <ChatsIcon size={40} className="mx-auto text-faint" />
        <p className="text-sm">Pick a chat, or press + to start one.</p>
      </div>
    </div>
  );
}

/** Phones: the floating glass bar with the four places. */
function TabBar({ route }: { route: Route }) {
  const isGuest = useStore((s) => s.me?.role === "guest");
  const computers = useStore((s) => s.computers);
  const inbox = useInboxCount();
  const working = computers.some((c) => c.activity && Date.now() - new Date(c.activity.at).getTime() < 30_000);
  const tab = (active: boolean, label: string, icon: ReactNode, target: string, badge?: number, dot?: boolean) => (
    <a href={target} aria-current={active ? "page" : undefined} className={cx("relative flex-1 flex flex-col items-center justify-center gap-[3px] h-[54px] rounded-full text-xs transition-colors", active ? "bg-ink/10 text-ink font-semibold" : "text-muted font-medium")}>
      {icon}
      {label}
      {!!badge && <span className="absolute top-1 left-[calc(50%+8px)] min-w-[18px] h-[18px] px-1 rounded-full bg-badge text-badge-ink text-[11px] font-semibold grid place-items-center tabular-nums">{badge > 99 ? "99+" : badge}</span>}
      {dot && <span className="absolute top-2 left-[calc(50%+10px)] size-2 rounded-full bg-ok" aria-label="An agent is working" />}
    </a>
  );
  return (
    <div className="absolute inset-x-0 bottom-0 z-30 px-[34px] pb-[30px] pointer-events-none safe-bottom">
      <nav className="glass pointer-events-auto mx-auto max-w-md h-[66px] flex items-center justify-between p-1.5 rounded-full" aria-label="Main">
        {tab(route.view === "dashboard", "Inbox", <InboxIcon size={23} />, href({ view: "dashboard" }), inbox)}
        {tab(route.view === "chats" || route.view === "chat", "Chats", <ChatsIcon size={23} />, href({ view: "chats" }))}
        {tab(route.view === "agents", "Agents", <AgentsIcon size={23} />, href({ view: "agents", agentId: null }))}
        {!isGuest && tab(route.view === "computers", "Computers", <ComputersIcon size={23} />, href({ view: "computers", computerId: null }), undefined, working)}
      </nav>
    </div>
  );
}

/** Phones: the home screen is the chats list. */
function ChatsPage({ route }: { route: Route }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <h1 className="sr-only">Chats</h1>
      <ChatList route={route} variant="page" />
    </div>
  );
}

/** Phones: you, your organizations, memory, marketplace, devices, help and settings in one place. */
function YouPage() {
  const me = useStore((s) => s.me)!;
  const { done } = useOnboarding();
  const dismissed = useDismissed();
  const features = useFeatures();
  const { current } = useOrgs();
  const [orgs, setOrgs] = useState(false);
  const { progress, steps, complete } = setupProgress(done);
  const isGuest = me.role === "guest";
  /** a row with a plain line icon, like iOS Settings */
  const row = (icon: ReactNode, label: string, to: string | (() => void), hint?: string, desc?: string) => {
    const cls = "w-full text-left flex items-center gap-3.5 px-4 min-h-14 py-2 border-b border-line last:border-0 hover:bg-hover";
    const inner = (
      <>
        <span className="size-5 shrink-0 grid place-items-center text-muted">{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[17px]">{label}</span>
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
  return (
    <div className="flex-1 overflow-y-auto safe-top">
      <div className="p-[18px] space-y-5">
        <div className="flex items-center gap-3.5 pt-2">
          <span className="circle" style={{ width: 56, height: 56 }}>
            {initialsOf(me.user.name)}
          </span>
          <div className="min-w-0">
            <div className="text-xl font-bold truncate">{me.user.name}</div>
            <div className="text-sm text-muted truncate">
              {me.user.email} · {me.role}
            </div>
          </div>
        </div>
        {!complete && <div className="rounded-3xl bg-card overflow-hidden">{row(<Sparkles size={20} strokeWidth={1.8} />, dismissed ? "Finish setup" : "Get started", href({ view: "welcome" }), dismissed ? `${progress} of ${steps}` : `${progress}/${steps}`)}</div>}
        <div className="rounded-3xl bg-card overflow-hidden">
          {row(<Building2 size={20} strokeWidth={1.8} />, current?.name ?? me.workspace.name, () => setOrgs(true), undefined, "Switch organization")}
        </div>
        <div className="rounded-3xl bg-card overflow-hidden">
          {features.tasks && row(<ListTodo size={20} strokeWidth={1.8} />, "Tasks", href({ view: "tasks" }), undefined, "Work you handed to an agent")}
          {features.tasks && !isGuest && row(<SquarePen size={20} strokeWidth={1.8} />, "New task", () => useStore.setState({ newTaskOpen: true }))}
          {row(<BookOpen size={20} strokeWidth={1.8} />, "Memory", href({ view: "vault", path: null }), undefined, "Notes you and your agents share")}
          {row(<Brain size={20} strokeWidth={1.8} />, "About you", href({ view: "about" }), undefined, "What agents should know about you")}
          {row(<Store size={20} strokeWidth={1.8} />, "Marketplace", href({ view: "marketplace" }), undefined, "Apps and skills for your agents")}
          {row(<Server size={20} strokeWidth={1.8} />, "Devices", href({ view: "nodes" }), undefined, "Computers running Wisp")}
          {row(<Blocks size={20} strokeWidth={1.8} />, "Mods", href({ view: "mods" }), undefined, "Optional parts of Wisp")}
        </div>
        <div className="rounded-3xl bg-card overflow-hidden">
          {row(<LifeBuoy size={20} strokeWidth={1.8} />, "Help", href({ view: "help" }), undefined, "Answers, setup, and what words mean")}
          {row(<Settings size={20} strokeWidth={1.8} />, "Settings", href({ view: "settings" }))}
        </div>
        <ModePicker />
        <button onClick={logout} className="w-full h-12 rounded-full bg-card text-bad text-[15px] font-medium inline-flex items-center justify-center gap-2">
          <LogOut size={17} /> Sign out
        </button>
      </div>
      {orgs && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && setOrgs(false)}>
          <div role="dialog" aria-modal="true" aria-label="Organizations" className="w-full bg-panel border-t border-line rounded-t-[38px] pb-6 safe-bottom">
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

/** Light, dark, or whatever the device uses. Color themes live in Settings. */
function ModePicker() {
  const { mode, setMode } = useAppearance();
  const options: [ModeChoice, string, ReactNode][] = [
    ["system", "System", <SunMoon key="s" size={16} />],
    ["light", "Light", <Sun key="l" size={16} />],
    ["dark", "Dark", <Moon key="d" size={16} />],
  ];
  return (
    <div className="flex rounded-full bg-card p-1" role="radiogroup" aria-label="Mode">
      {options.map(([value, label, icon]) => (
        <button key={value} role="radio" aria-checked={mode === value} onClick={() => setMode(value)} className={cx("flex-1 h-10 rounded-full text-[15px] inline-flex items-center justify-center gap-2 transition-colors", mode === value ? "bg-control border border-control-line text-ink font-medium" : "text-muted")}>
          {icon} {label}
        </button>
      ))}
    </div>
  );
}

export async function logout() {
  await api("POST", "/api/auth/logout").catch(() => {});
  window.wispDesktop?.setBadge(0);
  const nav = navigator as Navigator & { clearAppBadge?(): Promise<void>; setAppBadge?(n: number): Promise<void> };
  await (nav.clearAppBadge ? nav.clearAppBadge() : nav.setAppBadge?.(0))?.catch(() => {});
  setToken(null);
  location.hash = "";
  location.reload();
}

