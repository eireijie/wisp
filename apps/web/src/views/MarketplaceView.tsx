import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AudioLines,
  ChevronLeft,
  Code2,
  Image,
  Laptop,
  LayoutGrid,
  MessageSquare,
  MousePointerClick,
  NotebookText,
  Palette,
  Plug,
  Plus,
  Presentation,
  RefreshCw,
  Rocket,
  Search,
  Shield,
  Sheet,
  Sparkles,
  FileText,
  GitPullRequest,
  Wand2,
  Bot,
  Puzzle,
  Package,

  Download,
  Trash2,
  Upload,
} from "lucide-react";
import {
  APP_CATEGORIES,
  CONNECTOR_CATALOG,
  FEATURE_INFO,
  FEATURE_KEYS,
  HARNESSES,
  POPULAR_APPS,
  SKILL_CATALOG,
  appCategory,
  catalogSkill,
  harnessSupportsConnectors,
  shelfSummary,
  skillSlug,
  skillTitle,
  trustLabel,
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
import { setFeatures, useFeatures } from "../features.ts";
import { href, type MarketSection } from "../router.ts";
import { Loader, cx } from "../components/ui.tsx";
import { Add, AppTile, Badge, Chip, Circle, Dlg, Item, Label, Panel, Prim, Sec, SearchBox, Tile, TrustPill } from "../components/MarketParts.tsx";
import { AgentPicker, CatalogIcon } from "../components/ShopParts.tsx";
import { ConnectorForm, connectorWhere, registryCatalog, type ConnectSummary } from "./ConnectorsView.tsx";
import { AppDetail, Connected, ConnectSignIn, ManageApp, type AppItem } from "./AppPages.tsx";
import { InstallModal, SkillDetail, SkillEditor, SkillShare, StoreSkillDetail, TryDialog, skillOrigin, whatItsFor, type Open } from "./SkillsView.tsx";
import { openDm } from "../openDm.ts";

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

type SkillItem = { key: string; name: string; description: string; who: string; icon: ReactNode } & ({ library: CatalogSkill } | { store: StoreSkill });

/** What is open in place of the shelves. */
type Detail = { kind: "app"; app: AppItem } | { kind: "skill"; open: Open } | { kind: "store"; skill: StoreSkill; icon: ReactNode };

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
    [/\b(xlsx|spreadsheet|sheets?|excel|csv)\b/, <Sheet size={20} strokeWidth={1.7} />],
    [/\b(pptx|slides?|deck|presentation)\b/, <Presentation size={20} strokeWidth={1.7} />],
    [/\b(pdf|docx|documents?|docs?|writ\w+)\b/, <FileText size={20} strokeWidth={1.7} />],
    [/\b(design|art|theme|canvas|frontend|figma|brand|ui)\b/, <Palette size={20} strokeWidth={1.7} />],
    [/\b(images?|gif|imagegen|screenshot)\b/, <Image size={20} strokeWidth={1.7} />],
    [/\b(speech|transcribe|audio|voice)\b/, <AudioLines size={20} strokeWidth={1.7} />],
    [/\b(deploy\w*|vercel|netlify|render|cloudflare|ship)\b/, <Rocket size={20} strokeWidth={1.7} />],
    [/\b(security|threat|secure)\b/, <Shield size={20} strokeWidth={1.7} />],
    [/\b(gh|github|pull request|pr|ci|review)\b/, <GitPullRequest size={20} strokeWidth={1.7} />],
    [/\b(test\w*|playwright|browser|webapp)\b/, <MousePointerClick size={20} strokeWidth={1.7} />],
    [/\b(research|search|arxiv|papers?)\b/, <Search size={20} strokeWidth={1.7} />],
    [/\b(notion|notes?|knowledge|wiki|meeting)\b/, <NotebookText size={20} strokeWidth={1.7} />],
    [/\b(comms|slack|messages?|email|chat)\b/, <MessageSquare size={20} strokeWidth={1.7} />],
    [/\b(mcp|api|cli|code|aspnet|winui|jupyter|sdk)\b/, <Code2 size={20} strokeWidth={1.7} />],
  ];
  return pick.find(([re]) => re.test(t))?.[1] ?? <Wand2 size={20} strokeWidth={1.7} />;
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

/** An app has a sign-in that isn't done yet. */
const needsSignIn = (c: Connector) => !!c.auth?.required && !c.auth.signedIn;
const CONNECTING = "wisp.connecting";

const SECTION_LABEL: Record<MarketSection, string> = { all: "All", apps: "Apps", skills: "Skills", agents: "Agents", mods: "Mods", devices: "On your devices", installed: "Installed" };

/**
 * The marketplace: apps (MCP servers from the MCP Registry and Wisp's own list), skills (Wisp's
 * library and public SKILL.md repos), agents and mods, what your devices' harnesses already have,
 * and what's installed. Apps sign in once in Wisp and every agent picked gets them.
 */
export function MarketplaceView({ section, onBack, embedded }: { section: MarketSection; onBack?: () => void; embedded?: boolean }) {
  const me = useStore((s) => s.me);
  const agents = useStore((s) => s.agents);
  const features = useFeatures();
  const canEdit = !!me && me.role !== "guest";
  const isOwner = me?.role === "owner";
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
  // what's open in place of the shelves, and the dialogs on top
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState<{ entry?: CatalogConnector; existing?: Connector; presetEnv?: Record<string, string>; summary?: ConnectSummary; title?: string } | null>(null);
  const [signInFor, setSignInFor] = useState<string | null>(null);
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);
  const [trying, setTrying] = useState<{ name: string; description: string; agentIds: string[] } | null>(null);
  const [sharing, setSharing] = useState<Skill | "import" | null>(null);
  const [installing, setInstalling] = useState<{ entry: { name: string; description: string }; body: Record<string, string> } | null>(null);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const [bringAll, setBringAll] = useState(false);
  const [signedIn] = useState(() => new URLSearchParams(location.search).get("signin"));
  useEffect(() => {
    if (signedIn) history.replaceState(null, "", location.pathname + location.hash);
  }, [signedIn]);

  const loadConnectors = () => api<Connector[]>("GET", "/api/connectors").then((c) => (setConnectors(c), c), (e) => (setConnectors([]), setError((e as Error).message), [] as Connector[]));
  const loadSkills = () => api<Skill[]>("GET", "/api/skills").then((s) => (setSkills(s), s), () => (setSkills([]), [] as Skill[]));
  const loadShelves = () => (canEdit ? api<DeviceShelf[]>("GET", "/api/shelf").then(setShelves, () => setShelves([])) : Promise.resolve());
  useEffect(() => {
    void loadConnectors().then((list) => {
      // back from an app's sign-in page: show it connected
      if (signedIn === "ok") {
        let id: string | null = null;
        try {
          id = sessionStorage.getItem(CONNECTING);
          sessionStorage.removeItem(CONNECTING);
        } catch {
          /* private window */
        }
        if (id && list.some((c) => c.id === id)) setConnectedId(id);
      }
    });
    void loadSkills();
    void loadShelves();
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

  // moving between sections closes what was open
  useEffect(() => setDetail(null), [section]);

  const needle = q.trim().toLowerCase();
  const match = (...s: (string | null | undefined)[]) => !needle || s.some((x) => x?.toLowerCase().includes(needle));

  // --- apps ---
  const haveConnector = (a: AppItem) => (connectors ?? []).find((c) => c.catalogId === ("registry" in a ? `registry:${a.registry.id}` : a.builtIn.id) || squash(c.name) === squash(a.name));
  const apps: AppItem[] = useMemo(() => {
    const fromRegistry: AppItem[] = (market.entries ?? []).map((e) => ({ key: `r:${e.id}`, name: e.name, description: e.description, category: e.category, who: e.publisher, registry: e }));
    const names = new Set(fromRegistry.map((a) => squash(a.name)));
    const builtIn: AppItem[] = CONNECTOR_CATALOG.filter((c) => !names.has(squash(c.name)) && match(c.name, c.description, c.category)).map((c) => ({
      key: `b:${c.id}`,
      name: c.name,
      description: c.description,
      category: appCategory(c) ?? BUILT_IN_SHELF[c.category],
      who: "Wisp",
      builtIn: c,
    }));
    return [...fromRegistry, ...builtIn];
  }, [market.entries, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const popular = POPULAR_APPS.map((id) => featured.find((e) => e.id === id)).filter((e): e is StoreApp => !!e);
  const popularApps = popular.map((e) => apps.find((a) => a.key === `r:${e.id}`)).filter((a): a is AppItem => !!a);
  const shelfApps = (category === "All" ? apps : apps.filter((a) => a.category === category)).filter((a) => needle || section !== "all" || !popularApps.includes(a));
  const categories = APP_CATEGORIES.filter((c) => apps.some((a) => a.category === c));

  // --- skills ---
  const skillItems: SkillItem[] = useMemo(
    () => [
      ...SKILL_CATALOG.map((e) => ({ key: `w:${e.id}`, name: e.name, description: e.description, who: "Wisp", icon: <CatalogIcon name={e.icon} fallback={Wand2} size={20} />, library: e })),
      ...(store?.skills ?? []).map((s) => ({ key: `s:${s.id}`, name: s.name, description: s.description, who: s.source.label, icon: skillIcon(`${s.id} ${s.name}`), store: s })),
    ],
    [store],
  );
  const sources = ["All", ...new Set(skillItems.map((s) => s.who))];
  const shownSkills = skillItems.filter((s) => (skillSource === "All" || s.who === skillSource) && match(s.name, s.description, s.who));
  const installedSkill = (s: SkillItem) => (skills ?? []).find((k) => k.catalogId === ("library" in s ? s.library.id : s.store.id));
  const openSkill = (s: SkillItem) => {
    const have = installedSkill(s);
    if (have) setDetail({ kind: "skill", open: { skill: have } });
    else if ("library" in s) setDetail({ kind: "skill", open: { entry: s.library } });
    else setDetail({ kind: "store", skill: s.store, icon: s.icon });
  };
  const addSkill = (s: SkillItem) => {
    if (installedSkill(s)) return openSkill(s);
    if ("store" in s && !s.store.license.open) return openSkill(s);
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
  const connectorById = (id: string | null) => (id ? (connectors ?? []).find((c) => c.id === id) : undefined);
  async function signIn(c: Connector) {
    setError(null);
    try {
      const r = await api<{ url?: string }>("POST", `/api/connectors/${c.id}/signin`, { origin: location.origin });
      if (r.url) {
        try {
          sessionStorage.setItem(CONNECTING, c.id);
        } catch {
          /* private window */
        }
        location.href = r.url;
      } else void loadConnectors();
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
    await loadConnectors();
  }
  const afterSave = async (c?: Connector) => {
    const editedExisting = !!form?.existing;
    setForm(null);
    await loadConnectors();
    if (!c || editedExisting) return;
    if (c.auth?.required && !c.auth.signedIn) setSignInFor(c.id);
    else setConnectedId(c.id);
  };
  const refreshSkills = async (focus?: string) => {
    const list = await loadSkills();
    if (focus) {
      const s = list.find((x) => x.id === focus);
      setDetail(s ? { kind: "skill", open: { skill: s } } : null);
    }
  };
  const removeConnector = (c: Connector) => {
    if (!confirm(`Remove ${c.name}? Helpers will lose access to it.`)) return;
    setManageId(null);
    void act(api("DELETE", `/api/connectors/${c.id}`));
  };

  const connectedCount = connectors?.length ?? 0;
  const installedCount = connectedCount + (skills?.length ?? 0);
  const nav: { id: MarketSection; label: string; count?: number; icon: ReactNode }[] = [
    { id: "all", label: "All", icon: <LayoutGrid size={18} /> },
    { id: "apps", label: "Apps", icon: <Plug size={18} /> },
    { id: "skills", label: "Skills", icon: <Wand2 size={18} /> },
    { id: "agents", label: "Agents", icon: <Bot size={18} /> },
    { id: "mods", label: "Mods", icon: <Puzzle size={18} /> },
    ...(shelves.length ? [{ id: "devices" as const, label: "On your devices", count: pending.length || undefined, icon: <Laptop size={18} /> }] : []),
    { id: "installed", label: "Installed", count: installedCount || undefined, icon: <Package size={18} /> },
  ];
  const chips = nav.filter((n) => n.id !== "installed");

  // --- lists ---
  const appCards = (list: AppItem[], limit?: number) =>
    market.entries === null && !list.length ? (
      <Loader />
    ) : list.length === 0 ? (
      <p className="py-4 text-sm text-muted">{needle ? `No apps match "${q}".` : "No apps here yet."}</p>
    ) : (
      <Grid>
        {list.slice(0, limit).map((a) => {
          const have = haveConnector(a);
          return (
            <Entry
              key={a.key}
              tile={<AppTile name={a.name} category={a.category} />}
              title={a.name}
              badge={"registry" in a ? <TrustPill t={trustOf(a.registry)} /> : <Badge tone="blue">On Wisp's list</Badge>}
              sub={whatItsFor(a.description, 90) || a.who}
              onOpen={() => setDetail({ kind: "app", app: a })}
              action={canEdit && <Add onClick={() => setDetail({ kind: "app", app: a })} aria-label={`${have ? "Open" : "Add"} ${a.name}`} className={cx(have && "text-faint")}>{have ? "Added" : "Add"}</Add>}
            />
          );
        })}
      </Grid>
    );
  const skillCards = (list: SkillItem[], limit?: number) =>
    store === null && !list.length ? (
      <Loader />
    ) : list.length === 0 ? (
      <p className="py-4 text-sm text-muted">{needle ? `No skills match "${q}".` : "No skills here yet."}</p>
    ) : (
      <Grid>
        {list.slice(0, limit).map((s) => {
          const have = !!installedSkill(s);
          const linkOnly = "store" in s && !s.store.license.open;
          return (
            <Entry
              key={s.key}
              tile={<Tile size={40}>{s.icon}</Tile>}
              title={s.name}
              badge={"library" in s ? <Badge tone="green">Made by Wisp</Badge> : <Badge>From {s.who}</Badge>}
              sub={whatItsFor(s.description, 90) || s.who}
              onOpen={() => openSkill(s)}
              action={canEdit && (linkOnly ? <Add onClick={() => openSkill(s)} aria-label={`View ${s.name}`}>View</Add> : <Add onClick={() => addSkill(s)} aria-label={`${have ? "Open" : "Install"} ${s.name}`} className={cx(have && "text-faint")}>{have ? "Added" : "Install"}</Add>)}
            />
          );
        })}
      </Grid>
    );
  const agentCards = (limit?: number) => (
    <Grid>
      {HARNESSES.filter((h) => h.protocol !== "mcp")
        .slice(0, limit)
        .map((h) => (
          <Entry key={h.id} tile={<Tile size={40}><Bot size={20} strokeWidth={1.7} /></Tile>} title={h.label} badge={<Badge>{h.protocol === "native" ? "Built in" : "Open source"}</Badge>} sub={h.note} onOpen={() => (location.hash = href({ view: "agents", agentId: null }))} action={canEdit && <Add onClick={() => (location.hash = href({ view: "agents", agentId: null }))} aria-label={`Add an agent with ${h.label}`}>Add</Add>} />
        ))}
    </Grid>
  );
  const modCards = (limit?: number) => (
    <Grid>
      {FEATURE_KEYS.slice(0, limit).map((k) => (
        <Entry
          key={k}
          tile={<Tile size={40}><Sparkles size={20} strokeWidth={1.7} /></Tile>}
          title={FEATURE_INFO[k].name}
          badge={<Badge tone="green">Made by Wisp</Badge>}
          sub={FEATURE_INFO[k].description}
          action={features[k] ? <Badge tone="green">On</Badge> : isOwner ? <Add onClick={() => void setFeatures({ [k]: true }).catch((e) => setError((e as Error).message))}>Turn on</Add> : <Badge>Off</Badge>}
        />
      ))}
    </Grid>
  );

  // --- pages ---
  const shelf = (title: string, to: MarketSection, children: ReactNode) => (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm text-faint md:text-[14px] md:font-semibold md:text-ink">{title}</h2>
        <a href={href({ view: "marketplace", section: to })} className="text-sm text-muted hover:text-ink">
          View all
        </a>
      </div>
      {children}
    </section>
  );

  const makeYourOwn = canEdit && (
    <section aria-label="Make your own" className="space-y-2 md:hidden">
      <Label>Make your own</Label>
      <Panel>
        <Item icon={<Tile size={40}><Wand2 size={20} strokeWidth={1.7} /></Tile>} title="Create a skill" sub="Teach your helper a way of doing something" onClick={() => setEditing("new")} />
        <Item icon={<Tile size={40}><Plug size={20} strokeWidth={1.7} /></Tile>} title="Add your own app" sub="Use any MCP server or URL" onClick={() => setForm({})} />
        <Item icon={<Tile size={40}><Download size={20} strokeWidth={1.7} /></Tile>} title="Bring a skill in" sub="From a link or a file" onClick={() => setSharing("import")} />
      </Panel>
    </section>
  );

  const home = (
    <>
      {canEdit && pending.length > 0 && !needle && <DeviceBanner pending={pending} onOpen={() => (location.hash = href({ view: "marketplace", section: "devices" }))} />}
      {market.error && <RegistryError error={market.error} onRetry={() => setRetry((n) => n + 1)} />}
      {needle ? (
        <>
          {shelf("Apps", "apps", appCards(shelfApps, 12))}
          {shelf("Skills", "skills", skillCards(shownSkills, 12))}
        </>
      ) : (
        <>
          {popularApps.length > 0 ? shelf("Popular apps", "apps", appCards(popularApps, 4)) : shelf("Apps", "apps", appCards(shelfApps, 4))}
          {shelf("Skills", "skills", skillCards(takeTurns(shownSkills), 4))}
          {shelf("Agents and mods", "agents", <>{agentCards(2)}<div className="h-3" />{modCards(2)}</>)}
          {makeYourOwn}
        </>
      )}
    </>
  );

  const appsPage = (
    <>
      {categories.length > 0 && (
        <div role="group" aria-label="App categories" className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0">
          {["All", ...categories].map((c) => (
            <Chip key={c} on={category === c} onClick={() => setCategory(category === c && c !== "All" ? "All" : (c as AppCategory | "All"))}>
              {c}
            </Chip>
          ))}
        </div>
      )}
      {market.error && <RegistryError error={market.error} onRetry={() => setRetry((n) => n + 1)} />}
      {appCards(category === "All" && !needle ? [...popularApps, ...shelfApps] : shelfApps)}
    </>
  );

  const skillsPage = (
    <>
      {sources.length > 2 && (
        <div role="group" aria-label="Who made them" className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0">
          {sources.map((c) => (
            <Chip key={c} on={skillSource === c} onClick={() => setSkillSource(skillSource === c && c !== "All" ? "All" : c)}>
              {c}
            </Chip>
          ))}
        </div>
      )}
      {store?.errors.map((e) => (
        <p key={e} className="text-sm text-muted">
          {e}
        </p>
      ))}
      {skillCards(shownSkills)}
    </>
  );

  const devicesPage = (
    <Devices shelves={shelves} canEdit={canEdit} inWisp={inWisp} onBring={bringIn} onBringAll={() => setBringAll(true)} pending={pending} onRefresh={(id) => api("POST", `/api/shelf/${id}/refresh`).then(() => setTimeout(loadShelves, 2500), (e) => setError((e as Error).message))} />
  );

  const rowFor = (c: Connector) => {
    const needs = needsSignIn(c);
    return (
      <Item
        key={c.id}
        icon={<AppTile name={c.name} size={40} />}
        title={c.name}
        sub={c.auth?.error ? <span className="text-bad">{c.auth.error}</span> : needs ? "Needs sign-in again" : c.auth?.signedIn ? "Signed in" : connectorWhere(c) || "Set up"}
        right={
          <>
            {!c.enabled ? <Badge>Off</Badge> : needs ? <Badge tone="warn">Sign in</Badge> : <Badge tone="green">On</Badge>}
            {canEdit && (
              <>
                <Sec className="h-9 max-md:hidden" onClick={() => setManageId(c.id)}>
                  Manage
                </Sec>
                <Circle label={`Remove ${c.name}`} className="circle-sm" wrap="max-md:hidden" onClick={() => removeConnector(c)}>
                  <Trash2 size={16} />
                </Circle>
              </>
            )}
          </>
        }
        onClick={() => (needs && canEdit ? setSignInFor(c.id) : setManageId(c.id))}
        label={`${c.name}: ${needs ? "sign in" : "manage"}`}
      />
    );
  };

  const installedPage = (
    <>
      {connectors === null ? (
        <Loader />
      ) : connectors.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted">
          No apps yet. <a className="underline" href={href({ view: "marketplace", section: "apps" })}>Get one</a>
        </p>
      ) : (
        <>
          {connectors.filter((c) => c.catalogId && match(c.name, c.url, c.command)).length > 0 && (
            <section className="space-y-2">
              <Label>Connected</Label>
              <Panel>{connectors.filter((c) => c.catalogId && match(c.name, c.url, c.command)).map(rowFor)}</Panel>
            </section>
          )}
          {connectors.filter((c) => !c.catalogId && match(c.name, c.url, c.command)).length > 0 && (
            <section className="space-y-2">
              <Label>Your own apps</Label>
              <Panel>{connectors.filter((c) => !c.catalogId && match(c.name, c.url, c.command)).map(rowFor)}</Panel>
            </section>
          )}
        </>
      )}
      <section className="space-y-2">
        <Label>Skills</Label>
        {skills === null ? (
          <Loader />
        ) : skills.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted">
            No skills yet. <a className="underline" href={href({ view: "marketplace", section: "skills" })}>Add one</a>
          </p>
        ) : (
          <Panel>
            {skills
              .filter((s) => match(s.name, s.description))
              .map((s) => (
                <Item
                  key={s.id}
                  icon={<Tile size={40}>{catalogSkill(s.catalogId ?? "") ? <CatalogIcon name={catalogSkill(s.catalogId ?? "")!.icon} fallback={Wand2} size={20} /> : skillIcon(`${s.slug} ${s.name}`)}</Tile>}
                  title={s.name}
                  sub={`${skillOrigin(s)} · ${s.agentIds.length ? `${s.agentIds.length} helper${s.agentIds.length === 1 ? "" : "s"}` : "no one yet"}`}
                  onClick={() => setDetail({ kind: "skill", open: { skill: s } })}
                />
              ))}
          </Panel>
        )}
      </section>
      <Panel className="md:hidden">
        <Item icon={<Tile size={40}><Plus size={20} strokeWidth={1.7} /></Tile>} title="Get more" sub="Browse the marketplace" href={href({ view: "marketplace", section: "apps" })} />
      </Panel>
    </>
  );

  const body = (() => {
    switch (section) {
      case "all":
        return home;
      case "apps":
        return appsPage;
      case "skills":
        return skillsPage;
      case "agents":
        return (
          <>
            {agentCards()}
          </>
        );
      case "mods":
        return modCards();
      case "devices":
        return devicesPage;
      case "installed":
        return installedPage;
    }
  })();

  // an open detail replaces the shelves
  const detailPage = (() => {
    if (!detail) return null;
    if (detail.kind === "app") return <AppDetail app={detail.app} have={haveConnector(detail.app)} canEdit={canEdit} onManage={(c) => setManageId(c.id)} onConnect={(i) => connect(detail.app, i)} />;
    if (detail.kind === "store") return <StoreSkillDetail s={detail.skill} icon={detail.icon} canEdit={canEdit} onAdd={() => setInstalling({ entry: detail.skill, body: { storeId: detail.skill.id } })} onTry={() => setTrying({ name: detail.skill.name, description: detail.skill.description, agentIds: [] })} />;
    return <SkillDetail open={detail.open} agents={agents} canEdit={canEdit} onInstall={(e) => setInstalling({ entry: e, body: { catalogId: e.id } })} onEdit={(s) => setEditing(s)} onChanged={(id) => void refreshSkills(id)} onGone={() => setDetail(null)} onTry={setTrying} onShare={(s) => setSharing(s)} />;
  })();
  function connect(app: AppItem, installIndex: number) {
    if ("builtIn" in app) setForm({ entry: app.builtIn });
    else {
      const install = app.registry.installs[installIndex] ?? app.registry.installs[0];
      if (install) setForm({ entry: registryCatalog(app.registry, install) });
    }
  }

  const searchRow = (
    <div className="flex items-center gap-3">
      <SearchBox value={q} onChange={setQ} placeholder={section === "installed" ? "Search apps" : "Search apps and skills"} />
      {canEdit && section !== "installed" && (
        <div className="hidden items-center gap-3 md:flex">
          <Prim className="h-[42px] text-sm" onClick={() => setEditing("new")}>
            <Wand2 size={16} /> Create a skill
          </Prim>
          <Sec className="h-[42px] text-sm" onClick={() => setForm({})}>
            Add your own app
          </Sec>
          <Circle label="Bring a skill in" className="circle-sm" onClick={() => setSharing("import")}>
            <Upload size={16} />
          </Circle>
        </div>
      )}
      {section === "installed" && !embedded && (
        <a href={href({ view: "marketplace", section: "apps" })} className="hidden md:inline-flex">
          <Prim className="h-[42px] text-sm">
            <Plus size={16} /> Get more
          </Prim>
        </a>
      )}
    </div>
  );

  const titleBlock =
    section === "installed" ? (
      <div className="flex items-center gap-3">
        {(onBack || !embedded) && (
          <Circle label="Back" wrap="md:hidden" onClick={() => (onBack && embedded ? onBack() : (location.hash = href({ view: "marketplace", section: null })))}>
            <ChevronLeft size={22} />
          </Circle>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="t-title truncate">Connect apps</h1>
          <p className="hidden text-sm text-faint md:block">{connectedCount} connected</p>
        </div>
        <span className="text-sm text-faint md:hidden">{connectedCount} connected</span>
      </div>
    ) : (
      <div className="flex items-center gap-3 md:hidden">
        {onBack && (
          <Circle label="Back" onClick={onBack}>
            <ChevronLeft size={22} />
          </Circle>
        )}
        <h1 className="min-w-0 flex-1 truncate t-title">Marketplace</h1>
        <Sec onClick={() => (location.hash = href({ view: "marketplace", section: "installed" }))}>{connectedCount} connected</Sec>
      </div>
    );

  const content = (
    <div className="mx-auto w-full max-w-[1000px] space-y-5 px-4 pb-24 pt-4 md:px-8 md:pb-12 md:pt-8">
      {titleBlock}
      {!detail && searchRow}
      {!detail && section !== "installed" && (
        <nav aria-label="Marketplace sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:hidden">
          {chips.map((n) => (
            <a key={n.id} href={href({ view: "marketplace", section: n.id === "all" ? null : n.id })} aria-current={section === n.id ? "page" : undefined} className={cx("inline-flex h-9 shrink-0 items-center rounded-full border px-4 text-sm font-medium", section === n.id ? "border-accent bg-accent text-accent-ink" : "border-control-line bg-control text-ink/80")}>
              {n.label}
              {!!n.count && <span className="ml-1.5 tabular-nums opacity-70">{n.count}</span>}
            </a>
          ))}
        </nav>
      )}
      {detail && (
        <button type="button" onClick={() => setDetail(null)} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ChevronLeft size={18} aria-hidden /> {embedded ? "Back" : SECTION_LABEL[section] === "All" ? "Marketplace" : SECTION_LABEL[section]}
        </button>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
      {signedIn && signedIn !== "ok" && <p className="rounded-2xl bg-bad/10 px-4 py-3 text-sm text-bad">Sign-in didn't finish: {signedIn}</p>}
      {detail ? <div className="max-w-2xl">{detailPage}</div> : <div className="space-y-6">{body}</div>}
    </div>
  );

  const manageC = connectorById(manageId);
  const signInC = connectorById(signInFor);
  const connectedC = connectorById(connectedId);

  return (
    <div className="flex min-h-0 flex-1">
      {!embedded && (
        <aside className="hidden w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line px-3 pb-5 pt-7 pl-5 md:flex" aria-label="Marketplace">
          <h2 className="t-title px-3 pb-3.5">Marketplace</h2>
          {nav.map((n) => (
            <a key={n.id} href={href({ view: "marketplace", section: n.id === "all" ? null : n.id })} aria-current={section === n.id ? "page" : undefined} className={cx("flex h-11 items-center gap-3 rounded-2xl px-3 text-[15px]", section === n.id ? "bg-side-active font-medium text-ink" : "font-medium text-muted hover:bg-side-hover hover:text-ink")}>
              <span aria-hidden className="shrink-0">{n.icon}</span>
              <span className="flex-1">{n.label}</span>
              {!!n.count && <span className="tabular-nums text-sm text-faint">{n.count}</span>}
            </a>
          ))}
        </aside>
      )}
      <div className="min-w-0 flex-1 overflow-y-auto">{content}</div>

      {form && (
        <ConnectorForm
          entry={form.entry}
          existing={form.existing}
          presetEnv={form.presetEnv}
          summary={form.summary}
          title={form.title}
          agents={agents}
          taken={(connectors ?? []).filter((c) => c.id !== form.existing?.id).map((c) => c.name.toLowerCase())}
          onClose={() => setForm(null)}
          onSaved={(c) => void afterSave(c)}
        />
      )}
      {signInC && <ConnectSignIn connector={signInC} onClose={() => setSignInFor(null)} onSignIn={() => void signIn(signInC)} />}
      {connectedC && (
        <Connected
          connector={connectedC}
          agents={agents}
          onClose={() => setConnectedId(null)}
          onPick={() => (setConnectedId(null), setManageId(connectedC.id))}
          onTry={() => {
            const first = connectedC.agentIds[0];
            setConnectedId(null);
            if (first) void openDm(first, `Use ${connectedC.name} to help me. What can you do with it?`).catch((e) => setError((e as Error).message));
          }}
        />
      )}
      {manageC && (
        <ManageApp
          connector={manageC}
          agents={agents}
          canEdit={canEdit}
          onClose={() => setManageId(null)}
          onChanged={() => void loadConnectors()}
          onEdit={() => (setManageId(null), setForm({ existing: manageC, entry: CONNECTOR_CATALOG.find((x) => x.id === manageC.catalogId) }))}
          onSignIn={() => void signIn(manageC)}
          onSignOut={() => void act(api("POST", `/api/connectors/${manageC.id}/signout`))}
          onToggle={() => void act(api("PATCH", `/api/connectors/${manageC.id}`, { enabled: !manageC.enabled }))}
          onRemove={() => removeConnector(manageC)}
        />
      )}
      {trying && <TryDialog skill={trying} agents={agents} onClose={() => setTrying(null)} />}
      {sharing && (
        <SkillShare
          skill={sharing === "import" ? null : sharing}
          agents={agents}
          canEdit={canEdit}
          onClose={() => setSharing(null)}
          onBrought={async (s) => {
            setSharing(null);
            await refreshSkills(s.id);
          }}
          onDevices={() => (setSharing(null), (location.hash = href({ view: "marketplace", section: "devices" })))}
        />
      )}
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
          onShare={(s) => setSharing(s)}
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
            void loadSkills();
            void loadConnectors();
          }}
          onSetUp={(d, i) => (setBringAll(false), bringIn(d, i))}
        />
      )}
    </div>
  );
}

const trustOf = (e: StoreApp) => trustLabel(e);

/** Cards in a grid on desktops; plain rows on phones. */
function Grid({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4 md:grid md:grid-cols-2 md:gap-3.5 xl:grid-cols-4">{children}</div>;
}

/** An app, skill, agent or mod: a card on desktops (tile, name, badge, line, button) and a row on phones. */
function Entry({ tile, title, badge, sub, action, onOpen }: { tile: ReactNode; title: string; badge?: ReactNode; sub: string; action?: ReactNode; onOpen?: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-3.5 md:flex-col md:items-stretch md:gap-3 md:rounded-3xl md:border md:border-line md:bg-card md:p-4">
      <button type="button" onClick={onOpen} disabled={!onOpen} className="flex min-w-0 flex-1 items-center gap-3.5 text-left md:flex-none md:items-center md:gap-3">
        <span className="max-md:hidden">{tile}</span>
        <span className="md:hidden">{cloneSize(tile)}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[15px] font-medium md:text-base">{title}</span>
          <span className="hidden md:flex">{badge}</span>
          <span className="truncate text-sm text-faint md:hidden">{sub}</span>
        </span>
      </button>
      <span className="hidden min-h-10 text-sm leading-snug text-faint md:line-clamp-2 md:block">{sub}</span>
      {action && <div className="shrink-0 md:self-start">{action}</div>}
    </div>
  );
}
/** The phone row's tile is a little bigger. */
function cloneSize(tile: ReactNode): ReactNode {
  return <span className="block [&>span]:!size-[50px] [&>span]:!rounded-xl">{tile}</span>;
}

function RegistryError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-bad">
      {error}
      <Sec className="h-8 text-sm" onClick={onRetry}>
        Try again
      </Sec>
    </p>
  );
}

type Pending = { device: DeviceShelf; item: ShelfItem };

/** "Found on MacBook Pro: 14 skills and 3 apps your harnesses already use." */
function DeviceBanner({ pending, onOpen }: { pending: Pending[]; onOpen: () => void }) {
  const devices = [...new Set(pending.map((p) => p.device.nodeName))];
  return (
    <section aria-label="Found on your devices">
      <Panel>
        <Item icon={<Tile size={50}><Laptop size={22} strokeWidth={1.7} /></Tile>} title={`Found on ${sentence(devices)}`} sub={`${shelfSummary(pending.map((p) => p.item))} your harnesses already ${pending.length === 1 ? "uses" : "use"}`} onClick={onOpen} />
      </Panel>
    </section>
  );
}

function Devices({ shelves, canEdit, inWisp, onBring, onBringAll, pending, onRefresh }: { shelves: DeviceShelf[]; canEdit: boolean; inWisp: (nodeId: string, i: ShelfItem) => boolean; onBring: (d: DeviceShelf, i: ShelfItem) => void; onBringAll: () => void; pending: Pending[]; onRefresh: (nodeId: string) => void }) {
  return (
    <div className="space-y-6">
      {pending.length > 0 && (
        <Panel>
          <Item icon={<Tile size={50}><Laptop size={22} strokeWidth={1.7} /></Tile>} title={`Found on ${sentence([...new Set(pending.map((p) => p.device.nodeName))])}`} sub={`${shelfSummary(pending.map((p) => p.item))} your harnesses already ${pending.length === 1 ? "uses" : "use"}`} />
        </Panel>
      )}
      {shelves.map((d) => {
        const harnesses = [...new Set(d.items.map((i) => i.harness))];
        return (
          <section key={d.nodeId} aria-label={d.nodeName} className="space-y-2">
            <div className="flex items-center gap-2 px-1">
              <h2 className="flex-1 truncate text-sm text-faint">{d.nodeName}</h2>
              {!d.online && <Badge>Offline</Badge>}
              {d.online && (
                <button onClick={() => onRefresh(d.nodeId)} className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm text-muted hover:bg-hover hover:text-ink">
                  <RefreshCw size={14} /> Look again
                </button>
              )}
            </div>
            {d.items.length === 0 ? (
              <p className="px-1 text-sm text-muted">{d.nodeName}: Nothing found in its harnesses.</p>
            ) : (
              <Panel>
                {harnesses.flatMap((h) =>
                  d.items
                    .filter((i) => i.harness === h)
                    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
                    .map((i) => {
                      const have = inWisp(d.nodeId, i);
                      const needs = i.kind === "mcp" && !readyAsIs(i);
                      return (
                        <Item
                          key={i.key}
                          icon={i.kind === "mcp" ? <AppTile name={i.name} size={40} /> : <Tile size={40}>{skillIcon(i.name)}</Tile>}
                          title={i.kind === "skill" ? skillTitle(i.name) : i.name}
                          sub={`${harnessName(h)}${i.kind === "mcp" ? (needs ? " · app, needs a key" : " · app") : ""}`}
                          right={canEdit && (have ? <Badge tone="green">In Wisp</Badge> : <Add onClick={() => onBring(d, i)} aria-label={`Bring in ${i.name}`}>Bring in</Add>)}
                        />
                      );
                    }),
                )}
              </Panel>
            )}
          </section>
        );
      })}
      {canEdit && pending.length > 0 && (
        <Prim onClick={onBringAll} className="max-sm:w-full">
          Bring them in
        </Prim>
      )}
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
    <Dlg title="Bring them in" sub={ready.length ? `${shelfSummary(ready.map((p) => p.item))} come${ready.length === 1 ? "s" : ""} into Wisp as they are.` : "Each of these needs a key first."} onClose={errors.length ? onDone : onClose}>
      {ready.length > 0 && (
        <section className="space-y-2">
          <Label>Share with</Label>
          <AgentPicker agents={agents} value={agentIds} onChange={setAgentIds} disabled={busy !== null} />
          <p className="px-1 text-[13px] text-faint">You can give them to more helpers later. Apps that need a sign-in ask once, here in Wisp.</p>
        </section>
      )}
      {later.length > 0 && (
        <section className="space-y-2">
          <Label>Need a key</Label>
          <Panel>
            {later.map((p) => (
              <Item key={`${p.device.nodeId}:${p.item.key}`} icon={<AppTile name={p.item.name} size={40} />} title={p.item.name} right={<Add onClick={() => onSetUp(p.device, p.item)}>Set up</Add>} />
            ))}
          </Panel>
        </section>
      )}
      {errors.map((e) => (
        <p key={e} className="text-sm text-bad">
          {e}
        </p>
      ))}
      <div className="flex justify-end gap-2">
        <Sec onClick={errors.length ? onDone : onClose}>{errors.length ? "Done" : "Cancel"}</Sec>
        {ready.length > 0 && !errors.length && (
          <Prim className="h-11 text-[15px]" disabled={busy !== null} onClick={go}>
            {busy !== null ? `Bringing in ${busy + 1} of ${ready.length}…` : `Bring in ${ready.length}`}
          </Prim>
        )}
      </div>
    </Dlg>
  );
}

