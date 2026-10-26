import { useEffect, type ReactNode } from "react";
import { Bell, Blocks, BookOpen, ChevronLeft, ChevronRight, Cpu, Database, Gauge, Info, KeyRound, LifeBuoy, Link2, ListTodo, Mic, Monitor, Palette, Plug, Settings, ShieldCheck, SlidersHorizontal, Smartphone, Sparkles, Store, User, Users, Wifi, Wrench, Building2, Bot, SquareTerminal } from "lucide-react";
import { resolveFeatures, type Features } from "@wisp/core";
import { useStore } from "../store.ts";
import { go, href, type SettingsPage } from "../router.ts";
import { cx } from "../components/ui.tsx";
import { useFeatures } from "../features.ts";
import { AppearancePage, NotificationsPage, PreferencesPage, ProfilePage, SecurityPage } from "./settings/account.tsx";
import { AgentsPolicyPage, ComputersPage, ConnectionsPage, DataPage, GeneralPage, PeoplePage } from "./settings/workspace.tsx";
import { RuntimesPage } from "./settings/runtimes.tsx";
import { HarnessesPage } from "./settings/harnesses.tsx";
import { VoicePage } from "./settings/voice.tsx";
import { MemoryPage } from "./settings/memory.tsx";
import { DevicesPage } from "./settings/devices.tsx";
import { MobilePage } from "./settings/mobile.tsx";
import { LoginsPage } from "./settings/logins.tsx";
import { ModsPage } from "./settings/features.tsx";
import { UsagePage } from "./settings/usage.tsx";
import { AskAndChanges } from "./settings/changes.tsx";
import { AgentDefaultsPage } from "./settings/defaults.tsx";
import { AboutPage } from "./settings/about.tsx";
import { SignOutButton } from "./settings/signout.tsx";
import { MarketplaceView } from "./MarketplaceView.tsx";
import { AccessPanel } from "../components/Access.tsx";
import { PageHeader } from "./settings/parts.tsx";

/**
 * Settings: a short list of sections. A section with more than one page lists them under it
 * while it's open. A page can need a feature (Voice, People, Usage), and some aren't for guests.
 * Page ids are the routes (SETTINGS_PAGES), so old links still open the same page.
 */
type NavPage = { id: SettingsPage; label: string; icon: ReactNode; noGuests?: boolean; feature?: keyof Features };
type NavSection = { section: string; pages: NavPage[] };
const ic = (I: typeof Settings) => <I size={17} strokeWidth={1.8} />;
const NAV: NavSection[] = [
  {
    section: "You",
    pages: [
      { id: "profile", label: "Profile", icon: ic(User) },
      { id: "notifications", label: "Notifications", icon: ic(Bell) },
      { id: "appearance", label: "Appearance", icon: ic(Palette) },
      { id: "preferences", label: "App behavior", icon: ic(SlidersHorizontal) },
      { id: "voice", label: "Voice", icon: ic(Mic), feature: "voice", noGuests: true },
      { id: "security", label: "Security", icon: ic(ShieldCheck) },
    ],
  },
  {
    section: "Workspace",
    pages: [
      { id: "general", label: "Workspace", icon: ic(Building2), noGuests: true },
      { id: "people", label: "People", icon: ic(Users), feature: "invite", noGuests: true },
      { id: "usage", label: "Usage", icon: ic(Gauge), feature: "background", noGuests: true },
      { id: "features", label: "Mods", icon: ic(Blocks), noGuests: true },
    ],
  },
  {
    section: "Agents",
    pages: [
      { id: "agents", label: "Agents policy", icon: ic(Bot), noGuests: true },
      { id: "agent-defaults", label: "Agent defaults", icon: ic(Wrench), noGuests: true },
      { id: "harnesses", label: "AI tool settings", icon: ic(SquareTerminal), noGuests: true },
      { id: "runtimes", label: "Agent runtimes", icon: ic(Cpu), noGuests: true },
      { id: "logins", label: "Agent logins", icon: ic(KeyRound), noGuests: true },
      { id: "apps", label: "Connected apps", icon: ic(Store), noGuests: true },
      { id: "connections", label: "Connections", icon: ic(Plug), noGuests: true },
      { id: "memory", label: "Memory", icon: ic(BookOpen), noGuests: true },
    ],
  },
  {
    section: "Devices",
    pages: [
      { id: "devices", label: "Devices", icon: ic(Monitor), noGuests: true },
      { id: "computers", label: "Agent computers", icon: ic(Sparkles), noGuests: true },
      { id: "access", label: "Access", icon: ic(Wifi), noGuests: true },
      { id: "mobile", label: "Mobile", icon: ic(Smartphone), noGuests: true },
    ],
  },
  {
    section: "More",
    pages: [
      { id: "data", label: "Data and export", icon: ic(Database), noGuests: true },
      { id: "updates", label: "About", icon: ic(Info) },
    ],
  },
];

/** The settings sections for a guest or not, with the organization's features. Pages that don't apply, and sections left empty, are left out. */
export function settingsNav(guest: boolean, features: Features = resolveFeatures(null)): NavSection[] {
  return NAV.map((s) => ({ ...s, pages: s.pages.filter((p) => !(guest && p.noGuests) && (!p.feature || features[p.feature])) })).filter((s) => s.pages.length);
}

const PAGES: Record<Exclude<SettingsPage, "apps">, () => ReactNode> = {
  profile: () => <ProfilePage />,
  preferences: () => <PreferencesPage />,
  notifications: () => <NotificationsPage />,
  voice: () => <VoicePage />,
  appearance: () => <AppearancePage />,
  security: () => <SecurityPage />,
  devices: () => <DevicesPage />,
  mobile: () => <MobilePage />,
  usage: () => <UsagePage />,
  general: () => (
    <>
      <AskAndChanges />
      <GeneralPage />
    </>
  ),
  access: () => (
    <>
      <PageHeader title="Access">Use Wisp on any Wi-Fi or on cell data.</PageHeader>
      <AccessPanel />
    </>
  ),
  "agent-defaults": () => <AgentDefaultsPage />,
  features: () => <ModsPage />,
  people: () => <PeoplePage />,
  agents: () => <AgentsPolicyPage />,
  runtimes: () => <RuntimesPage />,
  harnesses: () => <HarnessesPage />,
  memory: () => <MemoryPage />,
  computers: () => <ComputersPage />,
  logins: () => <LoginsPage />,
  connections: () => <ConnectionsPage />,
  data: () => <DataPage />,
  updates: () => <AboutPage />,
};

/** A link in the list that isn't a settings page: it opens its own area. */
const LINKS: { after: string; label: string; icon: ReactNode; to: () => string; noGuests?: boolean; feature?: keyof Features }[] = [
  { after: "You", label: "Memory", icon: ic(BookOpen), to: () => href({ view: "vault", path: null }) },
  { after: "You", label: "Marketplace", icon: ic(Store), to: () => href({ view: "marketplace" }), noGuests: true },
  { after: "You", label: "Tasks", icon: ic(ListTodo), to: () => href({ view: "tasks" }), noGuests: true, feature: "tasks" },
  { after: "Devices", label: "Computers and devices", icon: ic(Monitor), to: () => href({ view: "computers", computerId: null }), noGuests: true },
  { after: "More", label: "Help", icon: ic(LifeBuoy), to: () => href({ view: "help" }) },
];

/** The links under a section, for a guest or not, with the organization's features. */
export function settingsLinks(section: string, guest: boolean, features: Features = resolveFeatures(null)) {
  return LINKS.filter((l) => l.after === section && !(guest && l.noGuests) && (!l.feature || features[l.feature]));
}

/**
 * Settings: on desktops a full page inside the rail layout, a list of sections on the left and the
 * page on the right. On phones it is a list, then a page with a back button.
 */
export function SettingsView({ page, onBack, fullWindow }: { page: SettingsPage | null; onBack?: () => void; fullWindow?: boolean }) {
  const me = useStore((s) => s.me)!;
  const guest = me.role === "guest";
  const features = useFeatures();
  const nav = settingsNav(guest, features);
  const all = nav.flatMap((s) => s.pages);
  // a page whose feature is off (or that a guest can't use) isn't shown; fall back to the first page
  const known = page && all.some((p) => p.id === page) ? page : null;
  const current = known ?? (fullWindow ? all[0].id : null);
  const label = all.find((p) => p.id === current)?.label;
  const who = `${me.user.name} · ${me.role === "owner" ? "Owner" : me.role === "guest" ? "Guest" : "Member"}`;

  const items = (s: NavSection) => [
    ...s.pages.map((p) => ({ key: p.id, label: p.label, icon: p.icon, to: href({ view: "settings", page: p.id }), on: current === p.id })),
    ...settingsLinks(s.section, guest, features).map((l) => ({ key: l.label, label: l.label, icon: l.icon, to: l.to(), on: false })),
  ];

  const list = fullWindow ? (
    <nav aria-label="Settings" className="space-y-px">
      {nav.map((s) => (
        <div key={s.section}>
          <div className="px-3 pt-4 pb-1.5 text-xs font-medium tracking-wide text-faint uppercase">{s.section}</div>
          {items(s).map((it) => (
            <a
              key={it.key}
              href={it.to}
              aria-current={it.on ? "page" : undefined}
              className={cx("flex items-center gap-2.5 h-10 px-3 rounded-xl text-sm font-medium", it.on ? "bg-control text-ink font-medium" : "text-ink/80 hover:text-ink hover:bg-side-hover")}
            >
              <span className="shrink-0 opacity-80">{it.icon}</span>
              <span className="truncate">{it.label}</span>
            </a>
          ))}
        </div>
      ))}
    </nav>
  ) : (
    <nav aria-label="Settings" className="space-y-5">
      {nav.map((s) => (
        <section key={s.section}>
          <h2 className="px-4 pb-1.5 text-[13px] font-semibold text-faint">{s.section}</h2>
          <div className="rounded-3xl bg-card overflow-hidden">
            {items(s).map((it) => (
              <a key={it.key} href={it.to} className="flex items-center gap-3.5 px-4 min-h-12 border-b border-line last:border-0 hover:bg-hover">
                <span className="size-5 shrink-0 grid place-items-center text-muted">{it.icon}</span>
                <span className="flex-1 text-body">{it.label}</span>
                <ChevronRight size={16} className="text-faint" />
              </a>
            ))}
          </div>
        </section>
      ))}
      <SignOutButton icon className="w-full h-12 rounded-full bg-card text-bad text-body font-medium inline-flex items-center justify-center gap-2" />
    </nav>
  );

  const body = (id: SettingsPage) =>
    id === "apps" ? (
      <MarketplaceView section="installed" embedded />
    ) : (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={cx("max-w-[640px] pb-16", fullWindow ? "mx-auto px-8 py-9" : "p-4")}>{PAGES[id]()}</div>
      </div>
    );

  if (fullWindow)
    return (
      <div className="flex-1 min-w-0 flex">
        <aside className="w-[268px] shrink-0 border-r border-line overflow-y-auto px-3.5 py-7 safe-top flex flex-col">
          <div className="px-3 pb-1.5">
            <h1 className="t-title">Settings</h1>
            <div className="mt-0.5 text-[13px] text-faint truncate">{who}</div>
          </div>
          {list}
          <SignOutButton label="Sign out" className="mt-4 h-10 px-3 rounded-xl text-sm font-medium text-bad hover:bg-side-hover text-left" />
        </aside>
        <main className="flex-1 min-w-0 flex flex-col" aria-label={label ? `${label} settings` : "Settings"}>
          {body(current!)}
        </main>
      </div>
    );

  // phones: the list first, then a page with Back
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {current !== "apps" && (
        <header className="shrink-0 px-[18px] pt-3 pb-2 flex items-center gap-3 safe-top">
          {(onBack || current) && (
            <button className="circle shrink-0" onClick={() => (current ? go({ view: "settings", page: null }) : onBack?.())} aria-label={current ? "Back to all settings" : "Back"}>
              <ChevronLeft size={22} aria-hidden />
            </button>
          )}
          <h1 className="t-title truncate">{label ?? "Settings"}</h1>
        </header>
      )}
      {current === "apps" ? (
        <MarketplaceView section="installed" embedded onBack={() => go({ view: "settings", page: null })} />
      ) : current ? (
        body(current)
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-[18px] pb-28">{list}</div>
        </div>
      )}
    </div>
  );
}
