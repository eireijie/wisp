import { useEffect, useMemo, useState, type ReactNode, useRef } from "react";
import {
  AudioLines,
  ChevronLeft,
  Code2,
  ExternalLink,
  FileText,
  GitPullRequest,
  Image,
  Laptop,
  MessageSquare,
  MousePointerClick,
  NotebookText,
  Palette,
  Plus,
  Presentation,
  RefreshCw,
  Rocket,
  Search,
  Sheet,
  Shield,
  Wand2,
} from "lucide-react";
import {
  APP_CATEGORIES,
  CONNECTOR_CATALOG,
  POPULAR_APPS,
  SKILL_CATALOG,
  appCategory,
  catalogSkill,
  harnessSupportsConnectors,
  logoUrl,
  shelfSummary,
  skillSlug,
  skillTitle,
  type Agent,
  type AppCategory,
  type CatalogConnector,
  type CatalogSkill,
  type Connector,
  type DeviceShelf,
  type ShelfItem,
  type Skill,
  type StoreApp,
  type StoreSkill,
} from "@wisp/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { href, type MarketSection } from "../router.ts";
import { renderMarkdown } from "../markdown.ts";
import { Button, Loader, Menu, Modal, Pill, cx } from "../components/ui.tsx";
import { AgentPicker, AppLogo, CatalogIcon, Group, SkillTile } from "../components/ShopParts.tsx";
import { ConnectedRow, ConnectorForm, MarketAdd, type ConnectSummary } from "./ConnectorsView.tsx";
import { InstallModal, SkillEditor, SkillPanel, skillOrigin, whatItsFor, type Open } from "./SkillsView.tsx";


const HARNESS_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", hermes: "Hermes" };
const harnessName = (h: string) => HARNESS_NAMES[h] ?? h;

/** Wisp's own catalog sorted onto the store's shelves. */
const BUILT_IN_SHELF: Record<CatalogConnector["category"], AppCategory> = {
  Code: "Developer",
  "Chat & docs": "Docs and notes",
  "Work tracking": "Developer",
  Data: "Data",
  "Web & browser": "Research",
  Payments: "Finance",
  Utilities: "Automation",
  "Cloud keys": "Developer",
};

type AppItem = { key: string; name: string; description: string; category: AppCategory | null; logos: string[]; who: string } & ({ registry: StoreApp } | { builtIn: CatalogConnector });
type SkillItem = { key: string; name: string; description: string; who: string; icon: ReactNode } & ({ library: CatalogSkill } | { store: StoreSkill });

/** One from each maker in turn, so a short shelf shows a bit of everyone's. */
function takeTurns<T extends { who: string }>(list: T[]): T[] {
  const by = new Map<string, T[]>();
  for (const x of list) by.set(x.who, [...(by.get(x.who) ?? []), x]);
  const lanes = [...by.values()];
  const out: T[] = [];
  for (let i = 0; out.length < list.length; i++) for (const lane of lanes) if (lane[i]) out.push(lane[i]);
  return out;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const sentence = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** A plain line icon for a skill, from what it's about. */
function skillIcon(text: string): ReactNode {
  const t = text.toLowerCase();
  const pick: [RegExp, ReactNode][] = [
    [/\b(xlsx|spreadsheet|sheets?|excel|csv)\b/, <Sheet size={22} strokeWidth={1.8} />],
    [/\b(pptx|slides?|deck|presentation)\b/, <Presentation size={22} strokeWidth={1.8} />],
    [/\b(pdf|docx|documents?|docs?|writ\w+)\b/, <FileText size={22} strokeWidth={1.8} />],
    [/\b(design|art|theme|canvas|frontend|figma|brand|ui)\b/, <Palette size={22} strokeWidth={1.8} />],
    [/\b(images?|gif|imagegen|screenshot)\b/, <Image size={22} strokeWidth={1.8} />],
    [/\b(speech|transcribe|audio|voice)\b/, <AudioLines size={22} strokeWidth={1.8} />],
    [/\b(deploy\w*|vercel|netlify|render|cloudflare|ship)\b/, <Rocket size={22} strokeWidth={1.8} />],
    [/\b(security|threat|secure)\b/, <Shield size={22} strokeWidth={1.8} />],
    [/\b(gh|github|pull request|pr|ci|review)\b/, <GitPullRequest size={22} strokeWidth={1.8} />],
    [/\b(test\w*|playwright|browser|webapp)\b/, <MousePointerClick size={22} strokeWidth={1.8} />],
    [/\b(research|search|arxiv|papers?)\b/, <Search size={22} strokeWidth={1.8} />],
    [/\b(notion|notes?|knowledge|wiki|meeting)\b/, <NotebookText size={22} strokeWidth={1.8} />],
    [/\b(comms|slack|messages?|email|chat)\b/, <MessageSquare size={22} strokeWidth={1.8} />],
    [/\b(mcp|api|cli|code|aspnet|winui|jupyter|sdk)\b/, <Code2 size={22} strokeWidth={1.8} />],
  ];
  return pick.find(([re]) => re.test(t))?.[1] ?? <Wand2 size={22} strokeWidth={1.8} />;
}

/** How a shelf skill is known to Wisp once it's brought in. */
const deviceSkillId = (nodeId: string, i: ShelfItem) => `device:${nodeId}:${i.harness}:${i.key.split(":skill:")[1] ?? i.name}`;

/** A server a harness has, as something the connector form can fill in: its keys asked for, or a sign-in. */
function shelfConnector(nodeId: string, i: ShelfItem): CatalogConnector {
  // an Authorization header is a login: Wisp signs in itself instead (log in once, every agent gets it)
  const headers = (i.headers ?? []).filter((h) => h.toLowerCase() !== "authorization");
  const fields = [...(i.secrets ?? []), ...headers].map((k) => ({ key: k.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase(), label: k, secret: true, hint: "Kept on the device; enter it here once." }));
  return {
    id: `device:${nodeId}:${i.harness}:${i.name}`,
    name: i.name,
    description: `From ${harnessName(i.harness)}.`,
    icon: "Plug",
    category: "Utilities",
    kind: i.transport === "http" ? "mcp-http" : "mcp-stdio",
    command: i.command,
    args: i.args,
    url: i.url,
    headers: Object.fromEntries(headers.map((h) => [h, `{{${h.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}}}`])),
    fields,
  };
}

/** Ready to bring in as it is: nothing secret left behind on the device. */
const readyAsIs = (i: ShelfItem) => i.kind === "mcp" && !(i.secrets ?? []).length && !(i.headers ?? []).some((h) => h.toLowerCase() !== "authorization");

/**
 * The marketplace: apps (MCP servers from the MCP Registry and Wisp's own list), skills (Wisp's
 * library and public SKILL.md repos), what your devices' harnesses already have, and what's
 * installed. Apps sign in once in Wisp and every agent picked gets them.
 */
export function MarketplaceView({ section, onBack }: { section: MarketSection; onBack?: () => void }) {
  const me = useStore((s) => s.me);
  const agents = useStore((s) => s.agents);
  const canEdit = !!me && me.role !== "guest";
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<AppCategory | "All">("All");
  const [skillSource, setSkillSource] = useState("All");
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [market, setMarket] = useState<{ q: string; entries: StoreApp[] | null; error: string | null }>({ q: "", entries: null, error: null });
  const [featured, setFeatured] = useState<StoreApp[]>([]);
  const [store, setStore] = useState<{ skills: StoreSkill[]; errors: string[] } | null>(null);
  const [shelves, setShelves] = useState<DeviceShelf[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // what's open on top of the page
  const [adding, setAdding] = useState<StoreApp | null>(null);
  const [form, setForm] = useState<{ entry?: CatalogConnector; existing?: Connector; presetEnv?: Record<string, string>; summary?: ConnectSummary } | null>(null);
  const [skillOpen, setSkillOpen] = useState<Open | null>(null);
  const [storeOpen, setStoreOpen] = useState<StoreSkill | null>(null);
  const [installing, setInstalling] = useState<{ entry: { name: string; description: string }; body: Record<string, string> } | null>(null);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const [bringAll, setBringAll] = useState(false);
  const [signedIn] = useState(() => new URLSearchParams(location.search).get("signin"));
  useEffect(() => {
    if (signedIn) history.replaceState(null, "", location.pathname + location.hash);
  }, [signedIn]);

  const loadConnectors = () => api<Connector[]>("GET", "/api/connectors").then(setConnectors, (e) => (setConnectors([]), setError((e as Error).message)));
  const loadSkills = () => api<Skill[]>("GET", "/api/skills").then((s) => (setSkills(s), s), () => (setSkills([]), [] as Skill[]));
  const loadShelves = () => (canEdit ? api<DeviceShelf[]>("GET", "/api/shelf").then(setShelves, () => setShelves([])) : Promise.resolve());
  useEffect(() => {
    loadConnectors();
    loadSkills();
    loadShelves();
    api<{ skills: StoreSkill[]; errors: string[] }>("GET", "/api/skill-store").then(setStore, (e) => setStore({ skills: [], errors: [(e as Error).message] }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const searchGeneration = useRef(0);
  // the MCP Registry, searched on the hub (popular ones until someone types)
  useEffect(() => {
    const query = q.trim();
    // only the latest search may fill the list: an older, slower answer must not overwrite it
    const generation = ++searchGeneration.current;
    setMarket((m) => ({ ...m, entries: m.q === query ? m.entries : null, error: null }));
    const t = setTimeout(
      () =>
        api<{ entries: StoreApp[] }>("GET", `/api/marketplace?q=${encodeURIComponent(query)}`).then(
          (r) => {
            if (generation !== searchGeneration.current) return;
            setMarket({ q: query, entries: r.entries, error: null });
            if (!query) setFeatured(r.entries);
          },
          (e) => generation === searchGeneration.current && setMarket({ q: query, entries: [], error: (e as Error).message }),
        ),
      query ? 350 : 0,
    );
    return () => {
      searchGeneration.current++;
      clearTimeout(t);
    };
  }, [q, retry]);

  const needle = q.trim().toLowerCase();
  const match = (...s: (string | null | undefined)[]) => !needle || s.some((x) => x?.toLowerCase().includes(needle));

  // --- apps ---
  const added = (a: AppItem) => (connectors ?? []).some((c) => c.catalogId === ("registry" in a ? `registry:${a.registry.id}` : a.builtIn.id) || squash(c.name) === squash(a.name));
  const apps: AppItem[] = useMemo(() => {
    const fromRegistry: AppItem[] = (market.entries ?? []).map((e) => ({ key: `r:${e.id}`, name: e.name, description: e.description, category: e.category, logos: e.logos, who: e.publisher, registry: e }));
    const names = new Set(fromRegistry.map((a) => squash(a.name)));
    const builtIn: AppItem[] = CONNECTOR_CATALOG.filter((c) => !names.has(squash(c.name)) && match(c.name, c.description, c.category)).map((c) => ({
      key: `b:${c.id}`,
      name: c.name,
      description: c.description,
      category: appCategory(c) ?? BUILT_IN_SHELF[c.category],
      logos: [logoUrl([c.name])!],
      who: "Wisp",
      builtIn: c,
    }));
    return [...fromRegistry, ...builtIn];
  }, [market.entries, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const popular = POPULAR_APPS.map((id) => featured.find((e) => e.id === id)).filter((e): e is StoreApp => !!e);
  const shelfApps = (category === "All" ? apps : apps.filter((a) => a.category === category)).filter((a) => needle || section !== "all" || !popular.some((p) => `r:${p.id}` === a.key));
  const categories = APP_CATEGORIES.filter((c) => apps.some((a) => a.category === c));
  const getApp = (a: AppItem) => ("registry" in a ? setAdding(a.registry) : setForm({ entry: a.builtIn }));

  // --- skills ---
  const skillItems: SkillItem[] = useMemo(
    () => [
      ...SKILL_CATALOG.map((e) => ({ key: `w:${e.id}`, name: e.name, description: e.description, who: "Wisp", icon: <CatalogIcon name={e.icon} fallback={Wand2} size={22} />, library: e })),
      ...(store?.skills ?? []).map((s) => ({ key: `s:${s.id}`, name: s.name, description: s.description, who: s.source.label, icon: skillIcon(`${s.id} ${s.name}`), store: s })),
    ],
    [store],
  );
  const sources = ["All", ...new Set(skillItems.map((s) => s.who))];
  const shownSkills = skillItems.filter((s) => (skillSource === "All" || s.who === skillSource) && match(s.name, s.description, s.who));
  const installedSkill = (s: SkillItem) => (skills ?? []).find((k) => k.catalogId === ("library" in s ? s.library.id : s.store.id));
  const openSkill = (s: SkillItem) => {
    const have = installedSkill(s);
    if (have) setSkillOpen({ skill: have });
    else if ("library" in s) setSkillOpen({ entry: s.library });
    else setStoreOpen(s.store);
  };
  const addSkill = (s: SkillItem) => {
    const have = installedSkill(s);
    if (have) return setSkillOpen({ skill: have });
    if ("store" in s && !s.store.license.open) return setStoreOpen(s.store);
    setInstalling({ entry: s, body: "library" in s ? { catalogId: s.library.id } : { storeId: s.store.id } });
  };

  // --- on your devices ---
  const inWisp = (nodeId: string, i: ShelfItem) =>
    i.kind === "skill" ? (skills ?? []).some((s) => s.catalogId === deviceSkillId(nodeId, i) || s.slug === skillSlug(i.name)) : (connectors ?? []).some((c) => c.name.toLowerCase() === i.name.toLowerCase());
  const pending = shelves.flatMap((d) => d.items.filter((i) => !inWisp(d.nodeId, i)).map((i) => ({ device: d, item: i })));
  const bringIn = (d: DeviceShelf, i: ShelfItem) => {
    if (i.kind === "skill") setInstalling({ entry: { name: skillTitle(i.name), description: i.description ?? "" }, body: { nodeId: d.nodeId, harness: i.harness, skillId: i.key.split(":skill:")[1] ?? i.name } });
    else
      setForm({
        entry: shelfConnector(d.nodeId, i),
        presetEnv: i.env,
        summary: {
          can: `Your helpers will be able to use ${i.name}: read and act on what it allows.`,
          runBy: i.transport === "http" ? `It connects to ${new URL(i.url ?? "https://x").host}, as it did in ${harnessName(i.harness)}.` : `It runs on each agent's own device, as it did in ${harnessName(i.harness)}.`,
          caution: null,
        },
      });
  };

  // --- installed ---
  async function signIn(c: Connector) {
    setError(null);
    try {
      const r = await api<{ url?: string }>("POST", `/api/connectors/${c.id}/signin`, { origin: location.origin });
      if (r.url) location.href = r.url;
      else loadConnectors();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function act(p: Promise<unknown>) {
    setError(null);
    try {
      await p;
    } catch (e) {
      setError((e as Error).message);
    }
    loadConnectors();
  }
  const afterSave = (c?: Connector) => {
    setForm(null);
    setAdding(null);
    if (c?.auth?.required && !c.auth.signedIn) void signIn(c);
    else loadConnectors();
  };
  const refreshSkills = async (focus?: string) => {
    const list = await loadSkills();
    if (focus) {
      const s = list.find((x) => x.id === focus);
      setSkillOpen(s ? { skill: s } : null);
    }
  };

  const tabs: { id: MarketSection; label: string; count?: number }[] = [
    { id: "all", label: "All" },
    { id: "apps", label: "Apps" },
    { id: "skills", label: "Skills" },
    ...(shelves.length ? [{ id: "devices" as const, label: "On your devices", count: pending.length || undefined }] : []),
    { id: "installed", label: "Installed", count: (connectors?.length ?? 0) + (skills?.length ?? 0) || undefined },
  ];

  const appsList = (list: AppItem[], limit?: number) =>
    market.entries === null && !list.length ? (
      <Loader />
    ) : list.length === 0 ? (
      <p className="text-sm text-muted py-4">{needle ? `No apps match "${q}".` : "No apps here yet."}</p>
    ) : (
      <RowGrid>
        {list.slice(0, limit).map((a) => (
          <Row
            key={a.key}
            icon={<AppLogo srcs={a.logos} />}
            title={a.name}
            sub={a.description || a.who}
            onOpen={() => getApp(a)}
            action={canEdit && <GetButton have={added(a)} onClick={() => getApp(a)} label={`Get ${a.name}`} />}
          />
        ))}
      </RowGrid>
    );
  const skillsList = (list: SkillItem[], limit?: number) =>
    store === null && !list.length ? (
      <Loader />
    ) : list.length === 0 ? (
      <p className="text-sm text-muted py-4">{needle ? `No skills match "${q}".` : "No skills here yet."}</p>
    ) : (
      <RowGrid>
        {list.slice(0, limit).map((s) => {
          const have = !!installedSkill(s);
          const linkOnly = "store" in s && !s.store.license.open;
          return (
            <Row
              key={s.key}
              icon={<SkillTile icon={s.icon} />}
              title={s.name}
              sub={s.who}
              onOpen={() => openSkill(s)}
              action={canEdit && (linkOnly ? <GetButton label={`View ${s.name}`} text="View" onClick={() => openSkill(s)} /> : <GetButton have={have} text="Add" label={`Add ${s.name}`} onClick={() => addSkill(s)} />)}
            />
          );
        })}
      </RowGrid>
    );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="shrink-0 px-4 md:px-8 pt-5 pb-3 safe-top">
        <div className="max-w-[1120px] mx-auto flex flex-wrap items-center gap-3">
          {onBack && (
            <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
              <ChevronLeft size={22} />
            </button>
          )}
          <h1 className="text-[26px] font-bold tracking-tight flex-1 min-w-0 truncate">Marketplace</h1>
          <label className="order-last sm:order-none basis-full sm:basis-auto sm:flex-[0_1_420px] flex items-center gap-2.5 h-11 rounded-full bg-chip px-4 focus-within:ring-3 focus-within:ring-ring/30">
            <Search size={18} className="text-muted shrink-0" aria-hidden />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps and skills" aria-label="Search apps and skills" className="flex-1 min-w-0 bg-transparent outline-none text-[15px] placeholder:text-faint" />
          </label>
          {canEdit && (
            <Menu
              align="right"
              trigger={(_open, toggle) => (
                <button onClick={toggle} aria-label="Make your own" className="size-11 shrink-0 rounded-full bg-chip grid place-items-center hover:bg-hover">
                  <Plus size={20} />
                </button>
              )}
              items={[{ label: "Create a skill", icon: <Wand2 size={15} />, onSelect: () => setEditing("new") }, ...([{ label: "Add your own app", icon: <Plus size={15} />, onSelect: () => setForm({}) }])]}
            />
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1120px] mx-auto px-4 md:px-8 pb-12 pt-2 space-y-7">
          <nav aria-label="Marketplace sections" className="flex gap-2 overflow-x-auto [scrollbar-width:none] -mx-4 px-4 md:mx-0 md:px-0 md:flex-wrap">
            {tabs.map((t) => (
              <a
                key={t.id}
                href={href({ view: "marketplace", section: t.id === "all" ? null : t.id })}
                aria-current={section === t.id ? "page" : undefined}
                className={cx("h-9 px-4 rounded-full text-sm whitespace-nowrap inline-flex items-center gap-1.5", section === t.id ? "bg-accent text-accent-ink font-semibold" : "bg-chip text-ink hover:bg-hover")}
              >
                {t.label}
                {t.count !== undefined && <span className={cx("tabular-nums", section === t.id ? "opacity-70" : "text-muted")}>{t.count}</span>}
              </a>
            ))}
          </nav>

          {error && <p className="text-sm text-bad">{error}</p>}
          {signedIn && <p className={cx("text-sm rounded-lg px-3 py-2", signedIn === "ok" ? "bg-ok/10 text-ok" : "bg-bad/10 text-bad")}>{signedIn === "ok" ? "Signed in. Agents use it from their next run." : `Sign-in didn't finish: ${signedIn}`}</p>}

          {section === "all" && (
            <>
              {canEdit && pending.length > 0 && !needle && <DeviceBanner pending={pending} onBring={() => setBringAll(true)} />}
              {!needle && popular.length > 0 && category === "All" && (
                <section aria-labelledby="popular-h" className="space-y-3.5">
                  <h2 id="popular-h" className="text-xl font-bold">
                    Popular
                  </h2>
                  <div className="flex gap-4 overflow-x-auto snap-x snap-mandatory -mx-4 px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 sm:grid sm:grid-cols-2 lg:grid-cols-3 sm:overflow-visible">
                    {popular.map((e) => {
                      const a = apps.find((x) => x.key === `r:${e.id}`);
                      return a ? <PopularCard key={e.id} a={a} have={added(a)} canEdit={canEdit} onGet={() => getApp(a)} /> : null;
                    })}
                  </div>
                </section>
              )}
              <Chips value={category} options={categories} onChange={(c) => setCategory(c as AppCategory | "All")} label="App categories" />
              {market.error && <RegistryError error={market.error} onRetry={() => setRetry((n) => n + 1)} />}
              <Shelf title="Apps" more={href({ view: "marketplace", section: "apps" })}>
                {appsList(shelfApps, needle ? 12 : 8)}
              </Shelf>
              <Shelf title="Skills" more={href({ view: "marketplace", section: "skills" })}>
                {skillsList(needle ? shownSkills : takeTurns(shownSkills), needle ? 12 : 9)}
              </Shelf>
            </>
          )}

          {section === "apps" && (
            <>
              <Chips value={category} options={categories} onChange={(c) => setCategory(c as AppCategory | "All")} label="App categories" />
              {market.error && <RegistryError error={market.error} onRetry={() => setRetry((n) => n + 1)} />}
              {appsList(shelfApps)}
            </>
          )}

          {section === "skills" && (
            <>
              <Chips value={skillSource} options={sources.filter((s) => s !== "All")} onChange={setSkillSource} label="Who made them" />
              {store?.errors.map((e) => (
                <p key={e} className="text-sm text-muted">
                  {e}
                </p>
              ))}
              {skillsList(shownSkills)}
            </>
          )}

          {section === "devices" && <Devices shelves={shelves} canEdit={canEdit} inWisp={inWisp} onBring={bringIn} onBringAll={() => setBringAll(true)} pending={pending.length} onRefresh={(id) => api("POST", `/api/shelf/${id}/refresh`).then(() => setTimeout(loadShelves, 2500), (e) => setError((e as Error).message))} />}

          {section === "installed" && (
            <>
              <Shelf title="Apps">
                {connectors === null ? (
                  <Loader />
                ) : connectors.length === 0 ? (
                  <p className="text-sm text-muted py-2">
                    No apps yet. <a className="underline" href={href({ view: "marketplace", section: "apps" })}>Get one</a>
                  </p>
                ) : (
                  <div className="rounded-2xl border border-line divide-y divide-line">
                    {connectors
                      .filter((c) => match(c.name, c.url, c.command))
                      .map((c) => (
                        <ConnectedRow key={c.id} c={c} agents={agents} canEdit={canEdit} onSignIn={() => signIn(c)} onSignOut={() => act(api("POST", `/api/connectors/${c.id}/signout`))} onEdit={() => setForm({ existing: c, entry: CONNECTOR_CATALOG.find((x) => x.id === c.catalogId) })} onToggle={() => act(api("PATCH", `/api/connectors/${c.id}`, { enabled: !c.enabled }))} onRemove={() => confirm(`Remove ${c.name}? Agents lose it on their next run.`) && act(api("DELETE", `/api/connectors/${c.id}`))} />
                      ))}
                  </div>
                )}
              </Shelf>
              <Shelf title="Skills">
                {skills === null ? (
                  <Loader />
                ) : skills.length === 0 ? (
                  <p className="text-sm text-muted py-2">
                    No skills yet. <a className="underline" href={href({ view: "marketplace", section: "skills" })}>Add one</a>
                  </p>
                ) : (
                  <RowGrid>
                    {skills
                      .filter((s) => match(s.name, s.description))
                      .map((s) => (
                        <Row key={s.id} icon={<SkillTile icon={catalogSkill(s.catalogId ?? "") ? <CatalogIcon name={catalogSkill(s.catalogId ?? "")!.icon} fallback={Wand2} size={22} /> : skillIcon(`${s.slug} ${s.name}`)} />} title={s.name} sub={`${skillOrigin(s)} · ${s.agentIds.length ? `${s.agentIds.length} helper${s.agentIds.length === 1 ? "" : "s"}` : "no one yet"}`} onOpen={() => setSkillOpen({ skill: s })} />
                      ))}
                  </RowGrid>
                )}
              </Shelf>
            </>
          )}
        </div>
      </div>

      {adding && <MarketAdd entry={adding} agents={agents} taken={(connectors ?? []).map((c) => c.name.toLowerCase())} onClose={() => setAdding(null)} onSaved={afterSave} />}
      {form && (
        <ConnectorForm
          entry={form.entry}
          existing={form.existing}
          presetEnv={form.presetEnv}
          summary={form.summary}
          agents={agents}
          taken={(connectors ?? []).filter((c) => c.id !== form.existing?.id).map((c) => c.name.toLowerCase())}
          onClose={() => setForm(null)}
          onSaved={afterSave}
        />
      )}
      {skillOpen && <SkillPanel open={skillOpen} agents={agents} canEdit={canEdit} onClose={() => setSkillOpen(null)} onInstall={(e) => setInstalling({ entry: e, body: { catalogId: e.id } })} onEdit={(s) => setEditing(s)} onChanged={(id) => refreshSkills(id)} />}
      {storeOpen && <StoreSkillPanel s={storeOpen} canEdit={canEdit} onClose={() => setStoreOpen(null)} onAdd={() => (setStoreOpen(null), setInstalling({ entry: storeOpen, body: { storeId: storeOpen.id } }))} />}
      {installing && (
        <InstallModal
          entry={installing.entry}
          body={installing.body}
          agents={agents}
          onClose={() => setInstalling(null)}
          onDone={async (s) => {
            setInstalling(null);
            await refreshSkills(s.id);
          }}
        />
      )}
      {editing && (
        <SkillEditor
          skill={editing === "new" ? null : editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onSaved={async (s) => {
            setEditing(null);
            await refreshSkills(s.id);
          }}
        />
      )}
      {bringAll && (
        <BringAll
          pending={pending}
          agents={agents}
          onClose={() => setBringAll(false)}
          onDone={() => {
            setBringAll(false);
            loadSkills();
            loadConnectors();
          }}
          onSetUp={(d, i) => (setBringAll(false), bringIn(d, i))}
        />
      )}
    </div>
  );
}

function Shelf({ title, more, children }: { title: string; more?: string; children: ReactNode }) {
  const id = `shelf-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <h2 id={id} className="text-xl font-bold">
          {title}
        </h2>
        {more && (
          <a href={more} className="text-sm text-muted hover:text-ink">
            See all
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

function RowGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-x-6">{children}</div>;
}

function Row({ icon, title, sub, action, onOpen }: { icon: ReactNode; title: string; sub: string; action?: ReactNode; onOpen?: () => void }) {
  return (
    <div className="flex items-center gap-3.5 py-3 border-b border-line min-w-0">
      <button className="flex items-center gap-3.5 flex-1 min-w-0 text-left" onClick={onOpen}>
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold truncate">{title}</span>
          <span className="block text-[13px] text-muted truncate">{sub}</span>
        </span>
      </button>
      {action}
    </div>
  );
}

function GetButton({ have, onClick, label, text = "Get" }: { have?: boolean; onClick: () => void; label: string; text?: string }) {
  return have ? (
    <button onClick={onClick} className="shrink-0 h-8 px-3.5 rounded-full border border-line text-sm text-muted hover:text-ink">
      Added
    </button>
  ) : (
    <button onClick={onClick} aria-label={label} className="shrink-0 h-8 px-4 rounded-full bg-chip text-sm font-semibold hover:bg-hover">
      {text}
    </button>
  );
}

function Chips({ value, options, onChange, label }: { value: string; options: readonly string[]; onChange: (v: string) => void; label: string }) {
  if (!options.length) return null;
  return (
    <div role="group" aria-label={label} className="flex gap-2 overflow-x-auto [scrollbar-width:none] -mx-4 px-4 md:mx-0 md:px-0 md:flex-wrap">
      {["All", ...options].map((c) => (
        <button key={c} aria-pressed={value === c} onClick={() => onChange(value === c && c !== "All" ? "All" : c)} className={cx("h-8 px-3.5 rounded-full text-sm whitespace-nowrap border", value === c ? "border-transparent bg-accent-soft text-ink font-medium" : "border-line text-muted hover:text-ink")}>
          {c}
        </button>
      ))}
    </div>
  );
}

function RegistryError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <p className="text-sm text-bad flex flex-wrap items-center gap-2">
      {error}
      <Button className="h-7" onClick={onRetry}>
        Try again
      </Button>
    </p>
  );
}

function PopularCard({ a, have, canEdit, onGet }: { a: AppItem; have: boolean; canEdit: boolean; onGet: () => void }) {
  return (
    <article className="shrink-0 w-[82%] sm:w-auto snap-start rounded-[20px] border border-line bg-bg p-5 flex flex-col gap-4 min-h-44">
      <AppLogo srcs={a.logos} size={60} />
      <div className="flex-1">
        <h3 className="text-lg font-bold">{a.name}</h3>
        <p className="text-sm text-muted mt-1 line-clamp-2">{whatItsFor(a.description, 120) || a.who}</p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] text-muted truncate">{"registry" in a ? a.registry.publisher : "Wisp"}</span>
        {canEdit &&
          (have ? (
            <button onClick={onGet} className="h-9 px-4 rounded-full border border-line text-sm text-muted">
              Added
            </button>
          ) : (
            <button onClick={onGet} aria-label={`Get ${a.name}`} className="h-9 px-4 rounded-full bg-accent text-accent-ink text-sm font-semibold">
              Get
            </button>
          ))}
      </div>
    </article>
  );
}

type Pending = { device: DeviceShelf; item: ShelfItem };

/** "14 skills and 3 apps are already on MacBook Pro, in Claude Code and Hermes." */
function DeviceBanner({ pending, onBring }: { pending: Pending[]; onBring: () => void }) {
  const devices = [...new Set(pending.map((p) => p.device.nodeName))];
  const harnesses = [...new Set(pending.map((p) => harnessName(p.item.harness)))];
  return (
    <section aria-label="Found on your devices" className="flex flex-wrap items-center justify-between gap-4 rounded-[18px] border border-line bg-bg px-5 py-4">
      <div className="flex items-center gap-3.5 min-w-0">
        <span className="size-11 rounded-xl bg-chip grid place-items-center shrink-0" aria-hidden>
          <Laptop size={22} strokeWidth={1.8} />
        </span>
        <p className="text-[15px]">
          {shelfSummary(pending.map((p) => p.item))} {pending.length === 1 ? "is" : "are"} already on {sentence(devices)}, in {sentence(harnesses)}.
        </p>
      </div>
      <button onClick={onBring} className="h-10 px-5 rounded-full bg-accent text-accent-ink text-sm font-semibold shrink-0">
        Bring them in
      </button>
    </section>
  );
}

function Devices({ shelves, canEdit, inWisp, onBring, onBringAll, pending, onRefresh }: { shelves: DeviceShelf[]; canEdit: boolean; inWisp: (nodeId: string, i: ShelfItem) => boolean; onBring: (d: DeviceShelf, i: ShelfItem) => void; onBringAll: () => void; pending: number; onRefresh: (nodeId: string) => void }) {
  return (
    <div className="space-y-8">
      {canEdit && pending > 0 && (
        <div className="flex justify-end">
          <button onClick={onBringAll} className="h-10 px-5 rounded-full bg-accent text-accent-ink text-sm font-semibold">
            Bring them all in
          </button>
        </div>
      )}
      {shelves.map((d) => (
        <section key={d.nodeId} aria-label={d.nodeName} className="space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold flex-1 truncate">{d.nodeName}</h2>
            {!d.online && <Pill>Offline</Pill>}
            {d.online && (
              <button onClick={() => onRefresh(d.nodeId)} className="h-8 px-3 rounded-full text-sm text-muted hover:text-ink hover:bg-hover inline-flex items-center gap-1.5">
                <RefreshCw size={14} /> Look again
              </button>
            )}
          </div>
          {d.items.length === 0 && <p className="text-sm text-muted">Nothing found in its harnesses.</p>}
          {[...new Set(d.items.map((i) => i.harness))].map((h) => (
            <div key={h} className="space-y-1">
              <h3 className="text-[13px] font-semibold text-muted">{harnessName(h)}</h3>
              <RowGrid>
                {d.items
                  .filter((i) => i.harness === h)
                  .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
                  .map((i) => {
                    const have = inWisp(d.nodeId, i);
                    const needs = i.kind === "mcp" && !readyAsIs(i);
                    return (
                      <Row
                        key={i.key}
                        icon={i.kind === "mcp" ? <AppLogo srcs={[logoUrl([i.name])]} /> : <SkillTile icon={skillIcon(i.name)} />}
                        title={i.kind === "skill" ? skillTitle(i.name) : i.name}
                        sub={i.kind === "skill" ? (i.description ?? "Skill") : needs ? "App · needs a key" : "App"}
                        onOpen={() => !have && canEdit && onBring(d, i)}
                        action={canEdit && (have ? <span className="shrink-0 text-sm text-muted px-2">In Wisp</span> : <GetButton text="Bring in" label={`Bring in ${i.name}`} onClick={() => onBring(d, i)} />)}
                      />
                    );
                  })}
              </RowGrid>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** Bring everything in at once: skills and apps that need nothing, given to the agents picked. */
function BringAll({ pending, agents, onClose, onDone, onSetUp }: { pending: Pending[]; agents: Agent[]; onClose: () => void; onDone: () => void; onSetUp: (d: DeviceShelf, i: ShelfItem) => void }) {
  const ready = pending.filter((p) => p.item.kind === "skill" || readyAsIs(p.item));
  const later = pending.filter((p) => !ready.includes(p));
  const [agentIds, setAgentIds] = useState<string[]>(agents.length === 1 ? [agents[0].id] : []);
  const [busy, setBusy] = useState<number | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const who = "helpers";

  async function go() {
    const failed: string[] = [];
    for (let n = 0; n < ready.length; n++) {
      setBusy(n);
      const { device: d, item: i } = ready[n];
      try {
        if (i.kind === "skill") await api("POST", "/api/skills", { nodeId: d.nodeId, harness: i.harness, skillId: i.key.split(":skill:")[1] ?? i.name, agentIds });
        else {
          const kind = i.transport === "http" ? "mcp-http" : "mcp-stdio";
          const ids = agentIds.filter((id) => {
            const a = agents.find((x) => x.id === id);
            return !a || harnessSupportsConnectors(a.harness, kind);
          });
          await api("POST", "/api/connectors", kind === "mcp-http" ? { kind, name: i.name, url: i.url, catalogId: `device:${d.nodeId}:${i.harness}:${i.name}`, agentIds: ids } : { kind, name: i.name, command: i.command, args: i.args ?? [], env: i.env ?? {}, catalogId: `device:${d.nodeId}:${i.harness}:${i.name}`, agentIds: ids });
        }
      } catch (e) {
        failed.push(`${i.name}: ${(e as Error).message}`);
      }
    }
    setBusy(null);
    if (failed.length) setErrors(failed);
    else onDone();
  }

  return (
    <Modal title="Bring them in" onClose={errors.length ? onDone : onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {ready.length ? `${shelfSummary(ready.map((p) => p.item))} come${ready.length === 1 ? "s" : ""} into Wisp as they are.` : "Each of these needs a key first."} Apps that need a sign-in ask once, here in Wisp.
        </p>
        {ready.length > 0 && (
          <Group label={`Share with`} hint={`You can give them to more ${who} later.`}>
            <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} disabled={busy !== null} />
          </Group>
        )}
        {later.length > 0 && (
          <div className="space-y-1">
            <div className="text-sm font-medium">Need a key</div>
            <div className="rounded-lg border border-line divide-y divide-line">
              {later.map((p) => (
                <div key={`${p.device.nodeId}:${p.item.key}`} className="flex items-center gap-3 px-3 py-2">
                  <AppLogo srcs={[logoUrl([p.item.name])]} size={28} />
                  <span className="text-sm flex-1 truncate">{p.item.name}</span>
                  <Button className="h-7 text-xs" onClick={() => onSetUp(p.device, p.item)}>
                    Set up
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
        {errors.map((e) => (
          <p key={e} className="text-sm text-bad">
            {e}
          </p>
        ))}
        <div className="flex justify-end gap-2">
          <Button onClick={errors.length ? onDone : onClose}>{errors.length ? "Done" : "Cancel"}</Button>
          {ready.length > 0 && !errors.length && (
            <Button variant="primary" disabled={busy !== null} onClick={go}>
              {busy !== null ? `Bringing in ${busy + 1} of ${ready.length}…` : `Bring in ${ready.length}`}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** A public skill before it's added: who made it, its license, its instructions, and its source. */
function StoreSkillPanel({ s, canEdit, onClose, onAdd }: { s: StoreSkill; canEdit: boolean; onClose: () => void; onAdd: () => void }) {
  const [content, setContent] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    api<{ content: string | null }>("GET", `/api/skill-store/${encodeURIComponent(s.id)}`).then((r) => setContent(r.content), () => setContent(null));
  }, [s.id]);
  const html = useMemo(() => (content ? renderMarkdown(content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")) : ""), [content]);
  return (
    <Modal
      drawer
      onClose={onClose}
      label={s.name}
      title={
        <span className="flex items-center gap-2 min-w-0">
          <SkillTile icon={skillIcon(`${s.id} ${s.name}`)} size={28} />
          <span className="truncate">{s.name}</span>
        </span>
      }
    >
      <div className="space-y-5">
        <p className="text-sm text-muted">{s.description}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Pill>From {s.source.label}</Pill>
          <Pill tone={s.license.open ? "neutral" : "warn"}>{s.license.label}</Pill>
          <a href={s.url} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-ink inline-flex items-center gap-1">
            Source <ExternalLink size={11} />
          </a>
        </div>
        {canEdit && s.license.open && (
          <Button variant="primary" onClick={onAdd}>
            <Plus size={14} /> Add
          </Button>
        )}
        {!s.license.open && (
          <p className="text-sm text-muted">
            Its license doesn't allow copying it, so read it where it lives:{" "}
            <a className="underline" href={s.url} target="_blank" rel="noreferrer">
              {s.source.label}'s repo
            </a>
            .
          </p>
        )}
        {content === undefined ? <Loader /> : content && <div className="prose-w rounded-lg border border-line p-4 text-sm" dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </Modal>
  );
}
