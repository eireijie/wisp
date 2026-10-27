import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, Brain, Building2, LifeBuoy, ListTodo, SquarePen, ChevronRight, LogOut, Moon, Settings, Sparkles, Store, Sun, SunMoon, Blocks, X } from "lucide-react";
import { api, connectEvents, getToken, setToken } from "./api.ts";
import { useChatsUnread, useInboxCount, useStore } from "./store.ts";
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
import { logout } from "./logout.ts";
import { YouPage } from "./views/YouPage.tsx";
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
import { Loader, PopBadge, cx } from "./components/ui.tsx";
import { enterDeskPane, enterPane, staggerRows, useBounce, usePresence } from "./motion.ts";
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

/** Which tab or page a route belongs to. Moving between groups animates; moving within one doesn't. */
function tabGroup(route: Route): string {
  switch (route.view) {
    case "dashboard":
      return "0";
    case "chat":
    case "chats":
      return "1";
    case "agents":
      return "2";
    case "computers":
      return "3";
    default:
      return route.view;
  }
}
const tabOrder = (group: string) => (/^\d$/.test(group) ? Number(group) : 4);

/** Phones: the open chat, a layer that slides in over the list (and out again when it leaves). */
function ChatLayer({ leaving, instant, children }: { leaving: boolean; instant: boolean; children: ReactNode }) {
  // a chat that's already open when the app loads is simply there, it doesn't slide in
  const [skip] = useState(instant);
  return (
    <div className="m-chat-layer absolute inset-0 z-10 flex flex-col bg-panel" data-state={leaving ? "out" : "in"} data-skip={skip || undefined}>
      {children}
    </div>
  );
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

  // --- motion: tabs cross-fade, lists stagger, a chat slides in over the list on phones ---------------
  const shellRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const heldChat = useRef<ReactNode>(null);
  useEffect(() => {
    if (me) started.current = true;
  }, [me]);
  const group = tabGroup(route);
  const chatKey = route.view === "chat" ? route.channelId : null;
  const chatOpen = phone && route.view === "chat" && !!route.channelId;
  const chatPresence = usePresence(chatOpen, 320);
  const was = useRef({ group, chatKey });
  // runs when the tab or the open chat changes, never on a plain re-render
  useLayoutEffect(() => {
    const before = was.current;
    was.current = { group, chatKey };
    if (!started.current) return;
    const groupChanged = before.group !== group;
    if (!groupChanged && before.chatKey === chatKey) return;
    if (phone) {
      if (groupChanged) {
        enterPane(baseRef.current, tabOrder(group) > tabOrder(before.group) ? 8 : -8);
        staggerRows(shellRef.current);
      }
      return;
    }
    const panes = Array.from(mainRef.current?.children ?? []);
    if (groupChanged) {
      enterDeskPane(panes, 8, 180);
      staggerRows(shellRef.current);
    } else enterDeskPane(panes, 6, 160);
  }, [group, chatKey, phone]);

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
        return <ComputersView computerId={route.computerId} teach={route.teach ?? null} deviceId={route.deviceId ?? null} />;
      case "settings":
        return <SettingsView page={route.page ?? null} onBack={toYou} fullWindow={!phone} />;
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
  // the tab bar stays on phones (it slips away while a chat is open), except in the vault
  const showTabs = phone && route.view !== "vault";
  if (chatOpen) heldChat.current = page;
  const chatLayer = chatOpen || chatPresence.mounted;
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

  // desktops: Chats is a column and the open chat side by side, like one panel split in two
  const withColumn = !phone && (route.view === "chat" || route.view === "chats");

  return (
    <div ref={shellRef} className="h-full flex overflow-hidden bg-app">
      {!phone && <Rail route={route} />}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="relative flex-1 min-h-0 flex">
          {withColumn && (
            <aside className="w-[300px] shrink-0 my-2 rounded-xl border border-edge bg-panel overflow-hidden" data-pane>
              <ChatList route={route} />
            </aside>
          )}
          {/* the floating tab bar sits over the page, so pages leave room for it at the bottom */}
          <main ref={mainRef} className={cx("flex-1 min-w-0 min-h-0 flex flex-col bg-panel overflow-hidden", !phone && "my-2 mr-2 rounded-xl border border-edge", !phone && withColumn && "ml-2")}>
            <OfflineBanner phone={phone} />
            {phone ? (
              // phones: the page, and over it the open chat. The page shifts back 96px and dims as the chat slides in
              <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
                <div ref={baseRef} data-open={chatOpen} inert={chatOpen} className={cx("m-under absolute inset-0 flex flex-col", showTabs && "[&_.overflow-y-auto]:pb-28")}>
                  {chatOpen ? <ChatsPage route={route} /> : page}
                </div>
                <div className="m-dim" data-open={chatOpen} aria-hidden />
                {chatLayer && heldChat.current && (
                  <ChatLayer leaving={!chatOpen} instant={!started.current}>
                    {heldChat.current}
                  </ChatLayer>
                )}
              </div>
            ) : (
              page
            )}
          </main>
          {showTabs && <TabBar route={route} away={chatOpen} />}
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

/** One place in the tab bar: its icon bounces when it becomes the selected one. */
function Tab({ active, label, icon, target, badge, dot, accent }: { active: boolean; label: string; icon: ReactNode; target: string; badge?: number; dot?: boolean; accent: string }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  useBounce(iconRef, active);
  return (
    <a href={target} aria-current={active ? "page" : undefined} className={cx("relative z-[1] flex-1 flex flex-col items-center justify-center gap-[2px] h-[48px] rounded-full text-xs", active ? "text-ink font-medium" : "text-muted font-normal")}>
      <span ref={iconRef} className="m-tab-icon" style={active ? { color: `var(--accent-${accent})` } : undefined}>{icon}</span>
      {label}
      {badge !== undefined && <PopBadge count={badge} label={badge > 99 ? "99+" : String(badge)} className="absolute top-1 left-[calc(50%+8px)] min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-semibold text-black grid place-items-center tabular-nums" style={{ background: `var(--accent-${accent})` }} />}
      {dot && <span className="absolute top-2 left-[calc(50%+10px)] size-2 rounded-full bg-st-working animate-pulse" aria-label="An agent is working" />}
    </a>
  );
}

/** Phones: the floating glass bar with the four places. `away` slips it down while a chat is open. */
function TabBar({ route, away }: { route: Route; away: boolean }) {
  const isGuest = useStore((s) => s.me?.role === "guest");
  const computers = useStore((s) => s.computers);
  const inbox = useInboxCount();
  const unreadChats = useChatsUnread();
  const working = computers.some((c) => c.activity && Date.now() - new Date(c.activity.at).getTime() < 30_000);
  const count = isGuest ? 3 : 4;
  const index = route.view === "dashboard" ? 0 : route.view === "chats" || route.view === "chat" ? 1 : route.view === "agents" ? 2 : route.view === "computers" && !isGuest ? 3 : -1;
  return (
    <div data-away={away} inert={away} className="m-tabs absolute inset-x-0 bottom-0 z-30 px-6 pb-6 pointer-events-none safe-bottom">
      <nav className="glass pointer-events-auto relative mx-auto max-w-md h-[60px] flex items-center justify-between p-1.5 rounded-[30px]" aria-label="Main">
        {/* the selection slides from tab to tab with a little overshoot */}
        <span aria-hidden className="m-ind left-1.5 top-[5px] h-12 rounded-full" style={{ background: `color-mix(in srgb, var(--accent-${["inbox", "chats", "agents", "computers"][Math.max(index, 0)]}) 16%, transparent)`, width: `calc((100% - 12px) / ${count})`, transform: `translateX(${Math.max(index, 0) * 100}%)`, opacity: index < 0 ? 0 : 1 }} />
        <Tab active={index === 0} label="Inbox" icon={<InboxIcon size={22} />} accent="inbox" target={href({ view: "dashboard" })} badge={inbox} />
        <Tab active={index === 1} label="Chats" icon={<ChatsIcon size={22} />} accent="chats" target={href({ view: "chats" })} badge={unreadChats} />
        <Tab active={index === 2} label="Agents" icon={<AgentsIcon size={22} />} accent="agents" target={href({ view: "agents", agentId: null })} />
        {!isGuest && <Tab active={index === 3} label="Computers" icon={<ComputersIcon size={22} />} accent="computers" target={href({ view: "computers", computerId: null })} dot={working} />}
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

export { logout };
