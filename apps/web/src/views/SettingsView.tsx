import { useEffect, useState, type ReactNode } from "react";
import { Bell, Mic, Bot, Building2, ChevronLeft, ChevronRight, Cpu, Database, Link2, Lock, Monitor, Palette, Plug, RefreshCw, Shield, SlidersHorizontal, Smartphone, ToggleRight, User, Users, Wand2 } from "lucide-react";
import { resolveFeatures, type Features } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { appHashBeforeSettings, go, href, type SettingsPage } from "../router.ts";
import { Button, Pill, cx } from "../components/ui.tsx";
import { useSimple } from "../experience.tsx";
import { useFeatures } from "../features.ts";
import { AppearancePage, NotificationsPage, PreferencesPage, ProfilePage, SecurityPage } from "./settings/account.tsx";
import { AgentsPolicyPage, ComputersPage, ConnectionsPage, DataPage, GeneralPage, PeoplePage } from "./settings/workspace.tsx";
import { RuntimesPage } from "./settings/runtimes.tsx";
import { VoicePage } from "./settings/voice.tsx";
import { MemoryPage } from "./settings/memory.tsx";
import { MobilePage } from "./settings/mobile.tsx";
import { FeaturesPage } from "./settings/features.tsx";
import { AgentDefaultsPage } from "./settings/defaults.tsx";
import { ConnectorsView } from "./ConnectorsView.tsx";
import { Card, PageHeader, Row, Section } from "./settings/parts.tsx";

/**
 * Settings, split into pages: yours first ("You"), then the organization's. A page can need a
 * feature (Voice, People), and some aren't for guests.
 */
type NavPage = { id: SettingsPage; label: string; icon: ReactNode; noGuests?: boolean; feature?: keyof Features };
type NavGroup = { group: string; hint?: string; pages: NavPage[] };
const NAV: NavGroup[] = [
  {
    group: "You",
    pages: [
      { id: "profile", label: "Profile", icon: <User size={16} /> },
      { id: "preferences", label: "App behavior", icon: <SlidersHorizontal size={16} /> },
      { id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
      { id: "notifications", label: "Notifications", icon: <Bell size={16} /> },
      { id: "voice", label: "Voice", icon: <Mic size={16} />, feature: "voice" },
      { id: "security", label: "Security", icon: <Lock size={16} /> },
      { id: "mobile", label: "Mobile", icon: <Smartphone size={16} /> },
    ],
  },
  {
    group: "Organization",
    pages: [
      { id: "general", label: "General", icon: <Building2 size={16} /> },
      { id: "agent-defaults", label: "Agent defaults", icon: <Wand2 size={16} />, noGuests: true },
      { id: "agents", label: "Agents", icon: <Bot size={16} />, noGuests: true },
      { id: "computers", label: "Computers", icon: <Monitor size={16} />, noGuests: true },
      { id: "memory", label: "Memory", icon: <Shield size={16} /> },
      { id: "apps", label: "Connected apps", icon: <Plug size={16} />, noGuests: true },
      { id: "features", label: "Features", icon: <ToggleRight size={16} /> },
      { id: "people", label: "People", icon: <Users size={16} />, feature: "invite" },
      { id: "runtimes", label: "Agent runtimes", icon: <Cpu size={16} />, noGuests: true },
      { id: "connections", label: "Connections", icon: <Link2 size={16} />, noGuests: true },
      { id: "data", label: "Data & export", icon: <Database size={16} /> },
      { id: "updates", label: "Updates & about", icon: <RefreshCw size={16} /> },
    ],
  },
];

/** Pages most people never need; in Simple they sit under "Advanced" at the bottom of the list. */
const ADVANCED_PAGES: SettingsPage[] = ["runtimes", "connections"];

/**
 * The settings list for Simple or Advanced, for a guest or not, with the organization's features.
 * Simple moves the technical pages to the end, still reachable. Pages for a feature that's off
 * are left out.
 */
export function settingsNav(simple: boolean, guest: boolean, features: Features = resolveFeatures(null)): NavGroup[] {
  const groups = NAV.map((g) => ({ ...g, pages: g.pages.filter((p) => !(guest && p.noGuests) && (!p.feature || features[p.feature])) }));
  if (!simple) return groups;
  const advanced = groups.flatMap((g) => g.pages.filter((p) => ADVANCED_PAGES.includes(p.id)));
  const out = groups.map((g) => ({ ...g, pages: g.pages.filter((p) => !ADVANCED_PAGES.includes(p.id)) }));
  return advanced.length ? [...out, { group: "Advanced", hint: "For setting up agent tools by hand.", pages: advanced }] : out;
}

const PAGES: Record<Exclude<SettingsPage, "apps">, () => ReactNode> = {
  profile: () => <ProfilePage />,
  preferences: () => <PreferencesPage />,
  notifications: () => <NotificationsPage />,
  voice: () => <VoicePage />,
  appearance: () => <AppearancePage />,
  security: () => <SecurityPage />,
  mobile: () => <MobilePage />,
  general: () => <GeneralPage />,
  "agent-defaults": () => <AgentDefaultsPage />,
  features: () => <FeaturesPage />,
  people: () => <PeoplePage />,
  agents: () => <AgentsPolicyPage />,
  runtimes: () => <RuntimesPage />,
  memory: () => <MemoryPage />,
  computers: () => <ComputersPage />,
  connections: () => <ConnectionsPage />,
  data: () => <DataPage />,
  updates: () => <UpdatesPage />,
};

/**
 * On larger screens (`fullWindow`) Settings replaces the whole app, sidebar included: its own list
 * on the left with "Back to app", the page on the right. On phones it's a list, then a page.
 */
export function SettingsView({ page, onBack, fullWindow }: { page: SettingsPage | null; onBack?: () => void; fullWindow?: boolean }) {
  const me = useStore((s) => s.me)!;
  const guest = me.role === "guest";
  const simple = useSimple();
  const features = useFeatures();
  const nav = settingsNav(simple, guest, features);
  const all = nav.flatMap((g) => g.pages);
  // a page whose feature is off (or that a guest can't use) isn't shown; fall back to Profile
  const known = page && all.some((p) => p.id === page) ? page : null;
  const current = known ?? (fullWindow ? "profile" : null);
  const label = all.find((p) => p.id === current)?.label;

  const list = (
    <nav className="space-y-5" aria-label="Settings">
      {nav.map((g) => (
        <div key={g.group}>
          <div className={cx("px-2.5 mb-1 text-[13px] font-bold", fullWindow ? "text-muted" : "text-faint")}>{g.group}</div>
          {g.hint && <p className="px-2.5 mb-1.5 text-xs text-muted">{g.hint}</p>}
          <div className="space-y-px">
            {g.pages.map((p) => (
              <a
                key={p.id}
                href={href({ view: "settings", page: p.id })}
                aria-current={current === p.id ? "page" : undefined}
                className={cx(
                  "flex items-center gap-2.5 rounded-lg px-2.5 text-[15px]",
                  fullWindow ? "h-[34px] md:text-sm" : "h-9",
                  current === p.id ? (fullWindow ? "bg-side-active text-ink font-bold" : "bg-hover text-ink font-medium") : fullWindow ? "text-ink/80 font-medium hover:text-ink hover:bg-side-hover" : "text-muted hover:text-ink hover:bg-hover",
                )}
              >
                <span className="shrink-0 opacity-80">{p.icon}</span>
                <span className="flex-1 truncate">{p.label}</span>
                {!fullWindow && <ChevronRight size={14} className="text-faint" />}
              </a>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );

  const body = (id: SettingsPage) =>
    id === "apps" ? (
      <ConnectorsView />
    ) : (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={cx("max-w-3xl pb-16", fullWindow ? "mx-auto px-7 py-10" : "p-4")}>{PAGES[id]()}</div>
      </div>
    );

  if (fullWindow)
    return (
      <div className="flex-1 min-w-0 flex gap-2 p-2">
        <aside className="w-60 shrink-0 overflow-y-auto flex flex-col gap-4 px-1.5 py-2.5 safe-top">
          <a href={appHashBeforeSettings()} className="flex items-center gap-2 h-9 px-2.5 rounded-lg font-bold text-[15px] hover:bg-side-hover">
            <ChevronLeft size={16} strokeWidth={2.4} aria-hidden /> Back to app
          </a>
          {list}
        </aside>
        <main className="flex-1 min-w-0 flex flex-col bg-panel rounded-3xl border border-line shadow-panel overflow-hidden" aria-label={label ? `${label} settings` : "Settings"}>
          {body(current!)}
        </main>
      </div>
    );

  // phones: the list first, then a page with Back
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {current !== "apps" && (
        <header className="h-15 shrink-0 px-4 flex items-center gap-2 border-b border-line safe-top">
          {(onBack || current) && (
            <button
              className="h-9 pl-0.5 pr-2 -ml-1.5 rounded-md hover:bg-hover inline-flex items-center gap-0.5 text-sm text-muted hover:text-ink"
              onClick={() => (current ? go({ view: "settings", page: null }) : onBack?.())}
              aria-label={current ? "Back to all settings" : "Back"}
            >
              <ChevronLeft size={22} aria-hidden />
              <span aria-hidden>Back</span>
            </button>
          )}
          <h1 className="text-lg font-bold tracking-tight truncate">
            Settings
            {label && <span className="text-muted font-normal normal-case tracking-normal"> / {label}</span>}
          </h1>
        </header>
      )}
      {current === "apps" ? (
        <ConnectorsView onBack={() => go({ view: "settings", page: null })} />
      ) : current ? (
        body(current)
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-4 pb-16">{list}</div>
        </div>
      )}
    </div>
  );
}

interface UpdateInfo {
  version: { commit: string | null; date: string | null };
  check: { behind: number | null; changes: string[]; canUpdate: boolean; reason: string } | null;
  update: { state: "idle" | "updating" | "restarting" | "failed"; message: string; log: string[] };
}

/** The hub's version, what's new on GitHub, and a button to update. The page reloads once the hub is back. */
function UpdatesPage() {
  const isOwner = useStore((s) => s.me)?.role === "owner";
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setChecking(true);
    try {
      setInfo(await api<UpdateInfo>("POST", "/api/updates/check"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    api<UpdateInfo>("GET", "/api/updates").then(setInfo, () => {});
    check();
  }, []);

  // while the hub updates, follow along; it goes away while restarting, then comes back on the new version
  const busy = !!restarting || info?.update.state === "updating" || info?.update.state === "restarting";
  useEffect(() => {
    if (!busy) return;
    const from = restarting ?? info?.version.commit ?? null;
    const t = setInterval(async () => {
      const next = await api<UpdateInfo>("GET", "/api/updates").catch(() => null);
      if (!next) return setRestarting(from ?? "");
      if (next.update.state === "restarting") setRestarting(from ?? "");
      if (restarting !== null && next.version.commit !== restarting) return location.reload();
      setInfo(next);
    }, 2000);
    return () => clearInterval(t);
  }, [busy, restarting]);

  const update = async () => {
    setError(null);
    try {
      const r = await api<{ update: UpdateInfo["update"] }>("POST", "/api/updates/hub");
      setInfo((i) => i && { ...i, update: r.update });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const v = info?.version;
  const c = info?.check;
  const u = info?.update;
  return (
    <>
    <PageHeader title="Updates & about">Warren is free and open source (Apache-2.0). Your data stays on this hub.</PageHeader>
    <section className="space-y-3 mb-10">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Updates</h3>
          <p className="text-sm text-muted">
            {v?.commit ? (
              <>
                This hub runs Warren <code>{v.commit}</code>
                {v.date && <> from {new Date(v.date).toLocaleDateString()}</>}. Update devices from{" "}
                <a className="text-accent-text hover:underline" href="#/nodes">
                  Devices
                </a>
                .
              </>
            ) : (
              "Which version of Warren this hub runs, and what's new."
            )}
          </p>
        </div>
        <Button onClick={check} disabled={checking || busy} className="shrink-0">
          {checking ? "Checking…" : "Check now"}
        </Button>
      </div>
      <div className="rounded-xl border border-line p-4 space-y-3 text-sm">
        {busy ? (
          <p className="flex items-center gap-2">
            <Pill tone="info">{restarting !== null || u?.state === "restarting" ? "Restarting" : "Updating"}</Pill>
            <span className="text-muted">{restarting !== null || u?.state === "restarting" ? "The hub is restarting with the update. This page reloads when it's back." : (u?.log.at(-1) ?? "Updating…")}</span>
          </p>
        ) : !c ? (
          <p className="text-muted">{checking ? "Asking GitHub what's new…" : "Not checked yet."}</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              {c.canUpdate ? <Pill tone="accent">Update available</Pill> : c.behind === 0 ? <Pill tone="ok">Up to date</Pill> : <Pill tone="warn">Can't update here</Pill>}
              <span className="text-muted flex-1">{c.reason}</span>
              {c.canUpdate && isOwner && (
                <Button variant="primary" onClick={update}>
                  Update hub
                </Button>
              )}
            </div>
            {c.changes.length > 0 && (
              <ul className="space-y-1 text-muted">
                {c.changes.slice(0, 8).map((line) => (
                  <li key={line} className="truncate">
                    <code className="text-faint">{line.slice(0, line.indexOf(" "))}</code> {line.slice(line.indexOf(" ") + 1)}
                  </li>
                ))}
                {c.changes.length > 8 && <li className="text-faint">…and {c.changes.length - 8} more</li>}
              </ul>
            )}
            {c.canUpdate && !isOwner && <p className="text-xs text-muted">Only owners can update.</p>}
          </>
        )}
        {u?.state === "failed" && <p className="text-bad whitespace-pre-wrap">{u.message}</p>}
        {u?.state === "idle" && u.message && <p className="text-muted">{u.message}</p>}
        {error && <p className="text-bad">{error}</p>}
      </div>
    </section>
    <Section title="About">
      <Card>
        <Row label="Source code" hint="Issues, ideas and contributions welcome.">
          <a className="text-sm text-accent-text hover:underline" href="https://github.com/eireijie/warren" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </Row>
        <Row label="License" hint="Use it, change it, share it.">
          <span className="text-sm text-muted">Apache-2.0</span>
        </Row>
      </Card>
    </Section>
    </>
  );
}
