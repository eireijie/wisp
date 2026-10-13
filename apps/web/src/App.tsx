import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Bot, Brain, CircleUser, LogOut, MessageSquare, Monitor, Moon, Search, Server, Settings, Sparkles, ChevronRight, Sun, SunMoon, Users } from "./icons.tsx";
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
import { primeTasks } from "./notifications.ts";
import { Loader, UserAvatar, cx } from "./components/ui.tsx";
import { useOnboarding } from "./onboarding.ts";

export function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
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

  // the phone-only pages have desktop equivalents, and the bare root is the chats list on phones
  useEffect(() => {
    if (!phone && route.view === "chats") go({ view: "chat", channelId: null, threadId: null });
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
        return <ChannelView route={route} onBack={phone ? toChats : undefined} />;
      case "chats":
        return <ChatsPage route={route} />;
      case "you":
        return <YouPage />;
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
        return <ComputersView computerId={route.computerId} teach={route.teach ?? null} onBack={phone ? toYou : undefined} />;
      case "nodes":
        return <NodesView onBack={phone ? toYou : undefined} />;
      case "settings":
        return <SettingsView page={route.page ?? null} onBack={phone ? toYou : undefined} />;
      case "welcome":
        return <WelcomeView />;
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
        {/* on a computer, the page is a rounded sheet floating on the window */}
        <main className={cx("flex-1 min-h-0 flex flex-col bg-panel overflow-hidden", !phone && "sheet m-2 ml-0 rounded-2xl")}>{page}</main>
        {showTabs && <TabBar route={route} />}
      </div>
      <CommandPalette />
      {newTaskOpen && <NewTask onClose={() => useStore.setState({ newTaskOpen: false })} />}
    </div>
  );
}

function TabBar({ route }: { route: Route }) {
  const channels = useStore((s) => s.channels);
  const setPalette = useStore((s) => s.setPalette);
  const unread = channels.reduce((n, c) => n + (c.joined || c.kind === "dm" ? c.unread : 0), 0);
  const tab = (active: boolean, label: string, icon: ReactNode, target: string | (() => void), badge?: number) => {
    const cls = cx("flex-1 flex flex-col items-center justify-center gap-0.5 text-[11px] h-14", active ? "text-accent-text font-medium" : "text-muted");
    const inner = (
      <>
        <span className="relative">
          {icon}
          {!!badge && <span className="absolute -top-1.5 -right-2.5 min-w-4 h-4 px-1 rounded-full bg-accent text-accent-ink text-[10px] font-semibold grid place-items-center">{badge > 99 ? "99+" : badge}</span>}
        </span>
        {label}
      </>
    );
    return typeof target === "string" ? (
      <a href={target} className={cls} aria-current={active ? "page" : undefined}>
        {inner}
      </a>
    ) : (
      <button onClick={target} className={cls}>
        {inner}
      </button>
    );
  };
  return (
    <nav className="shrink-0 flex border-t border-line bg-panel safe-bottom" aria-label="Main">
      {tab(route.view === "chats" || route.view === "chat", "Chats", <MessageSquare size={22} />, href({ view: "chats" }), unread)}
      {tab(route.view === "agents", "Agents", <Bot size={22} />, href({ view: "agents", agentId: null }))}
      {tab(false, "Search", <Search size={22} />, () => setPalette(true))}
      {tab(route.view === "vault", "Memory", <BookOpen size={22} />, href({ view: "vault", path: null }))}
      {tab(["you", "settings", "nodes", "computers", "welcome", "teams", "about"].includes(route.view), "You", <CircleUser size={22} />, href({ view: "you" }))}
    </nav>
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
  const progress = Object.values(done).filter(Boolean).length;
  const row = (icon: ReactNode, label: string, to: string, hint?: string) => (
    <a href={to} className="flex items-center gap-3 px-4 h-14 border-b border-line last:border-0">
      <span className="text-muted">{icon}</span>
      <span className="flex-1 text-[15px]">{label}</span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
      <ChevronRight size={16} className="text-faint" />
    </a>
  );
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
        <div className="rounded-2xl border border-line overflow-hidden">
          {progress < Object.keys(done).length ? row(<Sparkles size={19} />, "Get started", href({ view: "welcome" }), `${progress}/${Object.keys(done).length}`) : null}
          {row(<Brain size={19} />, "About you", href({ view: "about" }))}
          {row(<Users size={19} />, "Teams", href({ view: "teams", teamId: null }))}
          {row(<Monitor size={19} />, "Computers", href({ view: "computers", computerId: null }))}
          {row(<Server size={19} />, "Devices", href({ view: "nodes" }))}
          {row(<Settings size={19} />, "Settings", href({ view: "settings" }))}
        </div>
        <ModePicker />
        <button onClick={logout} className="w-full h-12 rounded-2xl border border-line text-bad text-[15px] inline-flex items-center justify-center gap-2">
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
    <div className="flex rounded-2xl border border-line p-1" role="radiogroup" aria-label="Mode">
      {options.map(([value, label, icon]) => (
        <button key={value} role="radio" aria-checked={mode === value} onClick={() => setMode(value)} className={cx("flex-1 h-10 rounded-xl text-[15px] inline-flex items-center justify-center gap-2", mode === value ? "bg-hover text-ink font-medium" : "text-muted")}>
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
