import { GITHUB_URL } from "@warren/core";
import { useEffect, useState, type ReactNode } from "react";
import { Bell, ChevronLeft, ChevronRight, Gauge, Monitor, Palette, Settings, SlidersHorizontal, Users } from "lucide-react";
import { resolveFeatures, type Features } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { appHashBeforeSettings, go, href, type SettingsPage } from "../router.ts";
import { Button, Pill, cx } from "../components/ui.tsx";
import { useFeatures } from "../features.ts";
import { AppearancePage, NotificationsPage, PreferencesPage, ProfilePage, SecurityPage } from "./settings/account.tsx";
import { AgentsPolicyPage, ComputersPage, ConnectionsPage, DataPage, GeneralPage, PeoplePage } from "./settings/workspace.tsx";
import { RuntimesPage } from "./settings/runtimes.tsx";
import { HarnessesPage } from "./settings/harnesses.tsx";
import { VoicePage } from "./settings/voice.tsx";
import { MemoryPage } from "./settings/memory.tsx";
import { MobilePage } from "./settings/mobile.tsx";
import { ModsPage } from "./settings/features.tsx";
import { UsagePage } from "./settings/usage.tsx";
import { AskAndChanges } from "./settings/changes.tsx";
import { AgentDefaultsPage } from "./settings/defaults.tsx";
import { MarketplaceView } from "./MarketplaceView.tsx";
import { AccessPanel } from "../components/Access.tsx";
import { Card, PageHeader, Row, Section } from "./settings/parts.tsx";

/**
 * Settings: a short list of sections. A section with more than one page lists them under it
 * while it's open. A page can need a feature (Voice, People, Usage), and some aren't for guests.
 * Page ids are the routes (SETTINGS_PAGES), so old links still open the same page.
 */
type NavPage = { id: SettingsPage; label: string; noGuests?: boolean; feature?: keyof Features };
type NavSection = { section: string; icon: ReactNode; pages: NavPage[] };
const NAV: NavSection[] = [
  {
    section: "General",
    icon: <Settings size={16} />,
    pages: [
      { id: "general", label: "Workspace" },
      { id: "profile", label: "Profile" },
      { id: "preferences", label: "App behavior" },
      { id: "features", label: "Mods" },
    ],
  },
  { section: "Usage", icon: <Gauge size={16} />, pages: [{ id: "usage", label: "Usage", feature: "background" }] },
  {
    section: "People",
    icon: <Users size={16} />,
    pages: [
      { id: "people", label: "People", feature: "invite" },
      { id: "agents", label: "Agents", noGuests: true },
    ],
  },
  {
    section: "Notifications",
    icon: <Bell size={16} />,
    pages: [
      { id: "notifications", label: "Notifications" },
      { id: "voice", label: "Voice", feature: "voice" },
    ],
  },
  { section: "Appearance", icon: <Palette size={16} />, pages: [{ id: "appearance", label: "Appearance" }] },
  {
    section: "Devices",
    icon: <Monitor size={16} />,
    pages: [
      { id: "computers", label: "Computers", noGuests: true },
      { id: "mobile", label: "Mobile" },
      { id: "access", label: "Access" },
    ],
  },
  {
    section: "Advanced",
    icon: <SlidersHorizontal size={16} />,
    pages: [
      { id: "agent-defaults", label: "Agent defaults", noGuests: true },
      { id: "memory", label: "Memory" },
      { id: "apps", label: "Connected apps", noGuests: true },
      { id: "runtimes", label: "Agent runtimes", noGuests: true },
      { id: "harnesses", label: "Harnesses", noGuests: true },
      { id: "connections", label: "Connections", noGuests: true },
      { id: "security", label: "Security" },
      { id: "data", label: "Data" },
      { id: "updates", label: "About" },
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
      <PageHeader title="Access">Open Warren from anywhere with Tailscale, privately.</PageHeader>
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
  const features = useFeatures();
  const nav = settingsNav(guest, features);
  const all = nav.flatMap((s) => s.pages);
  // a page whose feature is off (or that a guest can't use) isn't shown; fall back to the first page
  const known = page && all.some((p) => p.id === page) ? page : null;
  const current = known ?? (fullWindow ? all[0].id : null);
  const label = all.find((p) => p.id === current)?.label;
  const open = nav.find((s) => s.pages.some((p) => p.id === current));

  const list = (
    <nav className="space-y-px" aria-label="Settings">
      {nav.map((s) => {
        const isOpen = s === open;
        return (
          <div key={s.section}>
            <a
              href={href({ view: "settings", page: s.pages[0].id })}
              aria-current={isOpen && s.pages.length === 1 ? "page" : undefined}
              className={cx(
                "flex items-center gap-2.5 rounded-lg px-2.5 text-[15px]",
                fullWindow ? "h-[34px] md:text-sm" : "h-11",
                isOpen ? (fullWindow ? "bg-side-active text-ink font-bold" : "bg-hover text-ink font-medium") : fullWindow ? "text-ink/80 font-medium hover:text-ink hover:bg-side-hover" : "text-ink hover:bg-hover",
              )}
            >
              <span className="shrink-0 opacity-80">{s.icon}</span>
              <span className="flex-1 truncate">{s.section}</span>
              {!fullWindow && <ChevronRight size={14} className="text-faint" />}
            </a>
            {fullWindow && isOpen && s.pages.length > 1 && (
              <div className="ml-[18px] my-1 pl-3 border-l border-line space-y-px">
                {s.pages.map((p) => (
                  <a
                    key={p.id}
                    href={href({ view: "settings", page: p.id })}
                    aria-current={current === p.id ? "page" : undefined}
                    className={cx("flex items-center h-[30px] px-2.5 rounded-lg text-sm truncate", current === p.id ? "text-ink font-bold bg-side-hover" : "text-muted hover:text-ink hover:bg-side-hover")}
                  >
                    {p.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );

  // phones: a section's other pages as a row of chips above the page
  const siblings =
    !fullWindow && open && open.pages.length > 1 ? (
      <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 mb-5" aria-label={`${open.section} pages`}>
        {open.pages.map((p) => (
          <a
            key={p.id}
            href={href({ view: "settings", page: p.id })}
            aria-current={current === p.id ? "page" : undefined}
            className={cx("shrink-0 h-8 px-3.5 rounded-full inline-flex items-center text-[13px] font-bold", current === p.id ? "bg-ink text-bg" : "bg-chip text-muted hover:text-ink")}
          >
            {p.label}
          </a>
        ))}
      </div>
    ) : null;

  const body = (id: SettingsPage) =>
    id === "apps" ? (
      <MarketplaceView section="installed" />
    ) : (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={cx("max-w-3xl pb-16", fullWindow ? "mx-auto px-7 py-10" : "p-4")}>
          {siblings}
          {PAGES[id]()}
        </div>
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
            {open && <span className="text-muted font-normal normal-case tracking-normal"> / {open.section}</span>}
          </h1>
        </header>
      )}
      {current === "apps" ? (
        <MarketplaceView section="installed" onBack={() => go({ view: "settings", page: null })} />
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
    <PageHeader title="About">Free and open source. Your data stays on this hub.</PageHeader>
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
          <a className="text-sm text-accent-text hover:underline" href={GITHUB_URL} target="_blank" rel="noreferrer">
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
