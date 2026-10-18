import { useEffect, useState, type ReactNode } from "react";
import { Bell, Mic, Bot, Building2, ChevronLeft, ChevronRight, Cpu, Database, Link2, Lock, Monitor, Palette, RefreshCw, Shield, SlidersHorizontal, Smartphone, User, Users } from "lucide-react";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { go, href, type SettingsPage } from "../router.ts";
import { Button, Pill, cx } from "../components/ui.tsx";
import { useSimple } from "../experience.tsx";
import { AppearancePage, NotificationsPage, PreferencesPage, ProfilePage, SecurityPage } from "./settings/account.tsx";
import { AgentsPolicyPage, ComputersPage, ConnectionsPage, DataPage, GeneralPage, PeoplePage } from "./settings/workspace.tsx";
import { RuntimesPage } from "./settings/runtimes.tsx";
import { VoicePage } from "./settings/voice.tsx";
import { MemoryPage } from "./settings/memory.tsx";
import { MobilePage } from "./settings/mobile.tsx";
import { Card, PageHeader, Row, Section } from "./settings/parts.tsx";

/** Settings, split into pages like Linear's and Paperclip's: yours first, then the workspace's. */
type NavGroup = { group: string; hint?: string; pages: { id: SettingsPage; label: string; icon: ReactNode; ownerOnly?: boolean; noGuests?: boolean }[] };
const NAV: NavGroup[] = [
  {
    group: "Account",
    pages: [
      { id: "profile", label: "Profile", icon: <User size={16} /> },
      { id: "preferences", label: "App behavior", icon: <SlidersHorizontal size={16} /> },
      { id: "notifications", label: "Notifications", icon: <Bell size={16} /> },
      { id: "voice", label: "Voice", icon: <Mic size={16} /> },
      { id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
      { id: "security", label: "Security", icon: <Lock size={16} /> },
      { id: "mobile", label: "Mobile", icon: <Smartphone size={16} /> },
    ],
  },
  {
    group: "Workspace",
    pages: [
      { id: "general", label: "General", icon: <Building2 size={16} /> },
      { id: "people", label: "People", icon: <Users size={16} /> },
      { id: "agents", label: "Agents", icon: <Bot size={16} />, noGuests: true },
      { id: "runtimes", label: "Agent runtimes", icon: <Cpu size={16} />, noGuests: true },
      { id: "memory", label: "Memory", icon: <Shield size={16} /> },
      { id: "computers", label: "Computers", icon: <Monitor size={16} />, noGuests: true },
      { id: "connections", label: "Connections", icon: <Link2 size={16} />, noGuests: true },
      { id: "data", label: "Data & export", icon: <Database size={16} /> },
      { id: "updates", label: "Updates & about", icon: <RefreshCw size={16} /> },
    ],
  },
];

/** Pages most people never need; in Simple they sit under "Advanced" at the bottom of the list. */
const ADVANCED_PAGES: SettingsPage[] = ["runtimes", "connections"];

/** The settings list for Simple or Advanced. Simple moves the technical pages to the end, still reachable. */
export function settingsNav(simple: boolean, guest: boolean): NavGroup[] {
  const groups = NAV.map((g) => ({ ...g, pages: g.pages.filter((p) => !(guest && p.noGuests)) }));
  if (!simple) return groups;
  const advanced = groups.flatMap((g) => g.pages.filter((p) => ADVANCED_PAGES.includes(p.id)));
  const out = groups.map((g) => ({ ...g, pages: g.pages.filter((p) => !ADVANCED_PAGES.includes(p.id)) }));
  return advanced.length ? [...out, { group: "Advanced", hint: "For setting up agent tools by hand.", pages: advanced }] : out;
}

const PAGES: Record<SettingsPage, () => ReactNode> = {
  profile: () => <ProfilePage />,
  preferences: () => <PreferencesPage />,
  notifications: () => <NotificationsPage />,
  voice: () => <VoicePage />,
  appearance: () => <AppearancePage />,
  security: () => <SecurityPage />,
  mobile: () => <MobilePage />,
  general: () => <GeneralPage />,
  people: () => <PeoplePage />,
  agents: () => <AgentsPolicyPage />,
  runtimes: () => <RuntimesPage />,
  memory: () => <MemoryPage />,
  computers: () => <ComputersPage />,
  connections: () => <ConnectionsPage />,
  data: () => <DataPage />,
  updates: () => <UpdatesPage />,
};

export function SettingsView({ page, onBack }: { page: SettingsPage | null; onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const guest = me.role === "guest";
  const simple = useSimple();
  const nav = settingsNav(simple, guest);
  // desktops open on Profile; phones show the list first
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const current = page ?? (wide ? "profile" : null);
  const label = nav.flatMap((g) => g.pages).find((p) => p.id === current)?.label;

  const list = (
    <nav className="space-y-5" aria-label="Settings">
      {nav.map((g) => (
        <div key={g.group}>
          <div className="px-2 mb-1 text-[13px] font-semibold text-faint">{g.group}</div>
          {g.hint && <p className="px-2 mb-1.5 text-xs text-muted">{g.hint}</p>}
          <div className="space-y-px">
            {g.pages.map((p) => (
              <a
                key={p.id}
                href={href({ view: "settings", page: p.id })}
                aria-current={current === p.id ? "page" : undefined}
                className={cx("flex items-center gap-2.5 rounded-lg px-2 h-9 md:h-8 text-[15px] md:text-[13px]", current === p.id ? "bg-hover text-ink font-medium" : "text-muted hover:text-ink hover:bg-hover")}
              >
                <span className="shrink-0">{p.icon}</span>
                <span className="flex-1 truncate">{p.label}</span>
                <ChevronRight size={14} className="md:hidden text-faint" />
              </a>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {(onBack || (!wide && current)) && (
          <button
            className="md:hidden h-9 pl-0.5 pr-2 -ml-1.5 rounded-md hover:bg-hover inline-flex items-center gap-0.5 text-sm text-muted hover:text-ink"
            onClick={() => (current && !wide ? go({ view: "settings", page: null }) : onBack?.())}
            aria-label={current && !wide ? "Back to all settings" : "Back"}
          >
            <ChevronLeft size={22} aria-hidden />
            <span aria-hidden>Back</span>
          </button>
        )}
        <a
          href={href({ view: "dashboard" })}
          className="hidden md:inline-flex shrink-0 h-8 pl-1 pr-2.5 -ml-1.5 mr-1 rounded-md items-center gap-1 text-sm text-muted hover:text-ink hover:bg-hover"
        >
          <ChevronLeft size={16} aria-hidden /> Back to Warren
        </a>
        <span aria-hidden className="hidden md:block h-5 w-px bg-line mr-2" />
        <h1 className="text-lg font-bold tracking-tight truncate">
          Settings
          {label && <span className="text-muted font-normal normal-case tracking-normal"> / {label}</span>}
        </h1>
      </header>
      <div className="flex-1 min-h-0 flex">
        <aside className="hidden md:block w-56 shrink-0 border-r border-line overflow-y-auto p-3">{list}</aside>
        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-3xl p-4 md:p-8 pb-16">{current ? PAGES[current]() : <div className="md:hidden">{list}</div>}</div>
        </main>
      </div>
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
