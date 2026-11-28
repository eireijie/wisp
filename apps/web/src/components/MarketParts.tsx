import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { PasswordInput } from "./PasswordInput.tsx";
import {
  AppWindow,
  BadgeCheck,
  BookOpen,
  ChevronRight,
  Cloud,
  Code2,
  CreditCard,
  Database,
  FileText,
  FolderOpen,
  GitPullRequest,
  Globe,
  KeyRound,
  Mail,
  MessageSquare,
  NotebookText,
  Palette,
  Plug,
  Search,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  SquareKanban,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import { brandLogo, isDarkMark, type BrandLogo } from "../brandLogos.ts";
import { entryLogos, logoUrl, type AppCategory, type MarketplaceEntry, type TrustLabel } from "@bubble-ai/core";
import { Modal, cx } from "./ui.tsx";

/*
 * The shapes the marketplace, harnesses and logins share, drawn from the approved market-*.dc.html
 * screens: logo tiles with a neutral line-icon fallback, grouped rounded cards, little pills, iOS-style
 * switches, segmented controls and dialogs with a round close button.
 */

const BY_NAME: [RegExp, LucideIcon][] = [
  [/\b(mail|gmail|outlook|inbox|imap)\b/i, Mail],
  [/\b(calendar|schedul|meeting|zoom|calendly)\b/i, FolderOpen],
  [/\b(drive|files?|dropbox|box|s3|storage)\b/i, FolderOpen],
  [/\b(notion|docs?|notes?|wiki|confluence|obsidian)\b/i, NotebookText],
  [/\b(slack|chat|discord|teams|messages?|telegram)\b/i, MessageSquare],
  [/\b(github|gitlab|git|pull request|bitbucket)\b/i, GitPullRequest],
  [/\b(linear|jira|asana|trello|issues?|tasks?|tracker|kanban)\b/i, SquareKanban],
  [/\b(stripe|paypal|payments?|billing|invoice|quickbooks|xero)\b/i, CreditCard],
  [/\b(postgres|sql|database|supabase|neon|mongo|redis|airtable|sheets?)\b/i, Database],
  [/\b(figma|canva|design|webflow|framer)\b/i, Palette],
  [/\b(search|research|browser|web|scrape|crawl|perplexity|exa)\b/i, Search],
  [/\b(vercel|cloudflare|aws|gcp|azure|deploy|cloud)\b/i, Cloud],
  [/\b(key|token|secret)\b/i, KeyRound],
];
const BY_CATEGORY: Partial<Record<AppCategory, LucideIcon>> = {
  "Email and calendar": Mail,
  Developer: Code2,
  "Docs and notes": FileText,
  Design: Palette,
  Sales: MessageSquare,
  Finance: CreditCard,
  Research: Search,
  Data: Database,
  Automation: Sparkles,
};

/** A plain line icon for an app, from its name and shelf. */
export function appIcon(name: string, category?: AppCategory | null): LucideIcon {
  return BY_NAME.find(([re]) => re.test(name))?.[1] ?? (category && BY_CATEGORY[category]) ?? Plug;
}

/** A neutral rounded square with a line icon (apps, skills, harnesses, password managers). */
export function Tile({ children, size = 40, className }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <span className={cx("shrink-0 grid place-items-center bg-chip text-ink/90", className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }} aria-hidden>
      {children}
    </span>
  );
}

/**
 * A tile for an app: its real logo (the registry's own icon, else the brand's from the hub's
 * /api/logo), on a light square so any brand color reads. Until a logo has really loaded, and when
 * none does, the tile is the plain line icon: a logo that is slow, blocked or never asked for
 * (a lazy image on a page the window isn't drawing) must not leave an empty white square.
 */
export function AppTile({ name, category, icon, size = 40, entry }: { name: string; category?: AppCategory | null; icon?: ReactNode; size?: number; entry?: Pick<MarketplaceEntry, "icon" | "name" | "brand" | "id"> | null }) {
  // a registry server's own icon comes first; then the logo Bubble AI carries; then the hub's lookup
  const ownIcon = !!entry?.icon && !/favicon/i.test(entry.icon);
  const bundled = icon || ownIcon ? null : brandLogo(name, entry?.brand, entry?.id.split("/").pop(), entry?.name);
  if (bundled) return <BrandTile logo={bundled} size={size} />;
  return <FetchedTile name={name} category={category} icon={icon} size={size} entry={entry} />;
}

/** A logo Bubble AI carries itself (brandLogos.ts): drawn at once, near-black marks in the ink colour. */
export function BrandTile({ logo, size = 40 }: { logo: BrandLogo; size?: number }) {
  const side = Math.round(size * 0.56);
  return (
    <Tile size={size} className="bg-white ring-1 ring-black/10 dark:bg-[#2c2c2e] dark:ring-white/10">
      <svg viewBox="0 0 24 24" width={side} height={side} aria-hidden role="img">
        <path d={logo.path} fill={isDarkMark(logo.hex) ? "var(--ink)" : `#${logo.hex}`} />
      </svg>
    </Tile>
  );
}

function FetchedTile({ name, category, icon, size = 40, entry }: { name: string; category?: AppCategory | null; icon?: ReactNode; size?: number; entry?: Pick<MarketplaceEntry, "icon" | "name" | "brand" | "id"> | null }) {
  const I = appIcon(name, category);
  const sources = icon ? [] : entry ? entryLogos(entry) : [logoUrl([name])].filter((x): x is string => !!x);
  const [failed, setFailed] = useState(0);
  const [loaded, setLoaded] = useState<string | null>(null);
  const key = sources.join("|");
  const [forKey, setForKey] = useState(key);
  if (forKey !== key) {
    setForKey(key);
    setFailed(0);
    setLoaded(null);
  }
  const src = sources[failed];
  const shown = !!src && loaded === src;
  const side = Math.round(size * 0.58);
  return (
    <Tile size={size} className={shown ? "bg-white ring-1 ring-black/10" : undefined}>
      {src && (
        <img
          key={src}
          // an image that was already in the cache can finish before React listens for it
          ref={(el) => {
            if (el?.complete && el.naturalWidth > 0) setLoaded(src);
          }}
          src={src}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(src)}
          onError={() => setFailed((n) => n + 1)}
          style={{ width: side, height: side, display: shown ? undefined : "none" }}
          className="object-contain"
        />
      )}
      {!shown && (icon ?? <I size={Math.round(size * 0.5)} strokeWidth={1.7} />)}
    </Tile>
  );
}

export const SkillGlyph = Wand2;
export const HarnessGlyph = AppWindow;
export const ManagerGlyph = ShieldCheck;
export const GlobeGlyph = Globe;
export const BookGlyph = BookOpen;

type Tone = "blue" | "green" | "grey" | "warn";
const TONE: Record<Tone, string> = {
  blue: "bg-[#0a84ff]/15 text-[#0a6fd6] dark:text-[#5ea8ff]",
  green: "bg-ok/15 text-ok",
  grey: "bg-chip text-muted",
  warn: "bg-warn/15 text-warn",
};

/** A small status pill ("On", "Signed in", "Coming soon"). */
export function Badge({ tone = "grey", icon, children, title }: { tone?: Tone; icon?: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-xs font-medium", TONE[tone])}>
      {icon}
      {children}
    </span>
  );
}

/**
 * Who stands behind an app, from the registry's own word (the real trust levels): the maker, a
 * verified publisher, or nobody confirmed. The full explanation is on hover and for screen readers.
 */
export function TrustPill({ t }: { t: TrustLabel }) {
  return (
    <span title={t.explanation} aria-label={`${t.text}. ${t.explanation}`} className="inline-flex">
      <Badge tone={t.kind === "unverified" ? "grey" : "blue"} icon={t.kind === "unverified" ? <ShieldQuestion size={13} aria-hidden /> : t.kind === "maker" ? <BadgeCheck size={13} aria-hidden /> : <ShieldCheck size={13} aria-hidden />}>
        {t.text}
      </Badge>
    </span>
  );
}

/** An iOS-style switch. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={cx("relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors disabled:opacity-40", on ? "m-switch-on" : "bg-ink/20")}>
      <span className={cx("m-knob absolute top-0.5 left-0.5 size-[27px] rounded-full bg-white shadow", on && "translate-x-5")} />
    </button>
  );
}

/** A segmented control: one option on. */
export function Seg<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-full bg-control p-[3px]">
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled} onClick={() => onChange(v)} className={cx("h-[38px] flex-1 rounded-[8px] px-3 text-sm font-medium whitespace-nowrap disabled:opacity-50", value === v ? "bg-ink/12 text-ink" : "text-muted hover:text-ink")}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** A small grey label over a card. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cx("px-1 text-[13px] tracking-wide text-faint", className)}>{children}</h3>;
}

/** A grouped card: rows with hairlines between them. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("overflow-hidden rounded-3xl bg-card md:border md:border-line [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:left-4 [&>*+*]:before:right-0 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-line", className)}>{children}</div>;
}

/** One row in a Panel: a tile, a title with a line under it, and something on the right. */
export function Item({ icon, title, sub, right, onClick, href, danger, disabled, children, label, selected }: { icon?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; href?: string; danger?: boolean; disabled?: boolean; children?: ReactNode; label?: string; selected?: boolean }) {
  const body = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className={cx("truncate text-body font-medium", danger && "text-bad")}>{title}</span>
        {sub && <span className="truncate text-sm text-faint">{sub}</span>}
        {children}
      </span>
    </>
  );
  const cls = "flex min-h-14 w-full min-w-0 items-center gap-3.5 px-4 py-2.5 text-left";
  // a row that goes somewhere can still hold its own button on the right, so the two are siblings
  if (!onClick && !href)
    return (
      <div className={cx(cls, disabled && "opacity-60")}>
        {body}
        {right}
      </div>
    );
  const Main = href ? "a" : "button";
  return (
    <div className={cx("flex min-w-0 items-center hover:bg-hover", selected && "bg-hover")}>
      <Main {...(href ? { href } : { type: "button" as const, onClick, disabled })} aria-label={label} className={cx(cls, "disabled:opacity-60", !!right && "flex-1")}>
        {body}
      </Main>
      {right && <div className="flex shrink-0 items-center gap-2 pr-4">{right}</div>}
    </div>
  );
}

const btn = "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50";

/** The one main action: a big filled capsule. */
export function Prim({ className, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...p} className={cx(btn, "h-[50px] rounded-[8px] bg-accent px-6 text-base font-medium text-accent-ink hover:bg-accent/90", className)} />;
}

/** A secondary capsule. */
export function Sec({ className, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...p} className={cx(btn, "h-11 rounded-[8px] border border-control-line bg-control px-[18px] text-body hover:bg-hover", className)} />;
}

/** "Add", "Bring in", "Set up": the one action at the end of a row, a hairline pill. */
export function Add({ className, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...p} className={cx("inline-flex h-[30px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[8px] border border-line2 px-3.5 text-[14px] outline-none hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 max-md:h-[34px] max-md:px-4", className)} />;
}

/** A round glass button (the circle from the tokens), with a label for screen readers. */
export function Circle({ label, children, className, wrap, ...p }: { label: string; children: ReactNode; wrap?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const b = (
    <button type="button" aria-label={label} title={label} {...p} className={cx("circle", className)}>
      {children}
    </button>
  );
  // the circle sets its own display, so showing and hiding by screen size is done on a wrapper
  return wrap ? <span className={wrap}>{b}</span> : b;
}

export const fieldCls = "h-[50px] w-full rounded-2xl border border-control-line bg-control px-4 text-base text-ink outline-none placeholder:text-faint focus:ring-3 focus:ring-ring/30";

export function TextBox({ className, wrapClassName, ...p }: InputHTMLAttributes<HTMLInputElement> & { wrapClassName?: string }) {
  if (p.type === "password") return <PasswordInput {...p} wrapClassName={wrapClassName} className={cx(fieldCls, className)} />;
  return <input {...p} className={cx(fieldCls, className)} />;
}

export function AreaBox({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx("w-full rounded-2xl border border-control-line bg-control px-4 py-3.5 text-base leading-snug text-ink outline-none placeholder:text-faint focus:ring-3 focus:ring-ring/30", className)} />;
}

/** A label above a field. */
export function Labeled({ label, hint, children, className }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cx("space-y-1.5", className)}>
      <label htmlFor={id} className="block px-1 text-[13px] tracking-wide text-faint">
        {label}
      </label>
      {children(id)}
      {hint && <p className="px-1 text-[13px] text-faint">{hint}</p>}
    </div>
  );
}

/** A search field shaped like the chat's composer: a magnifier and the words. Its placeholder is its name. */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-[20px] border border-transparent bg-[var(--bubble-them)] px-4 text-muted focus-within:border-line2">
      <Search size={16} aria-hidden className="shrink-0" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-muted md:text-[14px]" />
    </label>
  );
}

/** A chip that filters or picks. */
export function Chip({ on, onClick, children, count }: { on?: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cx("inline-flex h-[34px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] border px-3.5 text-sm font-medium transition-colors", on ? "border-accent bg-accent text-accent-ink" : "border-control-line bg-control text-ink/80 hover:text-ink")}>
      {children}
      {!!count && <span className={cx("tabular-nums", on ? "opacity-70" : "text-faint")}>{count}</span>}
    </button>
  );
}

/**
 * A dialog (a sheet on phones): a title with an optional line under it and a round close button,
 * then the body and the buttons. The focus trap, Escape and backdrop come from Modal.
 */
export function Dlg({ title, sub, onClose, children, wide, footer }: { title: string; sub?: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  return (
    <Modal title={title} headerless onClose={onClose} wide={wide} className="!rounded-t-[16px] sm:!rounded-xl" contentClassName="!p-0">
      <div className="flex items-start gap-3 px-5 pb-3 pt-5 sm:px-6 sm:pt-6">
        <div className="min-w-0 flex-1">
          <h2 className="t-title truncate">{title}</h2>
          {sub && <p className="mt-0.5 text-sm text-faint">{sub}</p>}
        </div>
        <Circle label="Close" onClick={onClose}>
          <X size={18} />
        </Circle>
      </div>
      <div className="space-y-4 px-5 pb-5 sm:px-6 sm:pb-6">{children}</div>
      {footer && <div className="flex flex-wrap justify-end gap-2 px-5 pb-5 sm:px-6 sm:pb-6">{footer}</div>}
    </Modal>
  );
}

/** A native picker styled as a capsule (a model, a provider, an account). */
export function Pick({ value, onChange, children, label, disabled, className }: { value: string; onChange: (v: string) => void; children: ReactNode; label: string; disabled?: boolean; className?: string }) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cx("h-10 max-w-[14rem] rounded-[8px] border border-control-line bg-control px-3.5 text-sm text-ink outline-none focus:ring-3 focus:ring-ring/30 disabled:opacity-60", className)}>
      {children}
    </select>
  );
}

/** A card of information that isn't a list (an explanation, a callout). */
export function Note({ children, tone }: { children: ReactNode; tone?: "warn" | "bad" }) {
  return <div className={cx("rounded-3xl bg-card px-4 py-3.5 text-body leading-snug text-ink/90 md:border md:border-line", tone === "warn" && "text-warn", tone === "bad" && "text-bad")}>{children}</div>;
}

// --- Add: one page of rows, and an item's page -----------------------------------------------------

/** The first few words of a line, for the muted words on a row: "Issues, pull requests, code search and repos." gives "Issues, pull requests, code". */
export function fewWords(text: string | null | undefined, max = 4): string {
  const words = (text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(0, max).join(" ").replace(/[\s,;:.!?-]+$/, "");
}

/** The sections of the Add page, top to bottom. */
export const ADD_SECTIONS = ["added", "found", "apps", "skills", "mods"] as const;
export type AddSection = (typeof ADD_SECTIONS)[number];

const SECTION_WORDS: Record<string, AddSection> = { app: "apps", apps: "apps", skill: "skills", skills: "skills", mod: "mods", mods: "mods", added: "added", installed: "added", found: "found", computers: "found", devices: "found" };

/** What was typed, when it names a whole section ("skills", "mods", "added"): that section shows alone, in full. */
export function sectionWord(q: string): AddSection | null {
  return SECTION_WORDS[q.trim().toLowerCase()] ?? null;
}

/** What was typed, as lowercase words. */
export const queryWords = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** Every typed word is somewhere in what a row says (its name, what it is for, its shelf, who made it). */
export function matchWords(words: string[], fields: (string | null | undefined)[]): boolean {
  return words.every((w) => fields.some((f) => f?.toLowerCase().includes(w)));
}

/** How many rows a section shows: a few until "Show all", more while searching. */
export function rowsShown(total: number, open: boolean, searching: boolean): number {
  return open ? total : Math.min(total, searching ? 12 : 5);
}

/** A section's tiny muted header; text buttons (Look again) sit at its right. */
export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-0.5 pb-1 pt-3 text-[12px] leading-4 text-muted">
      <h2 className="min-w-0 flex-1 truncate font-semibold">{title}</h2>
      {children}
    </div>
  );
}

/** A plain muted text button, for a header's right or under a list ("Look again", "Show all"). */
export function TextBtn({ className, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...p} className={cx("shrink-0 rounded-md text-muted outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-60", className)} />;
}

/**
 * One thing on the Add page: a 36 px tile, its name in bold, at most four muted words, and one
 * thing at the right. The name opens its page. `status` (a check, "Sign in again") is part of what
 * opens the page; `action` (Add, Bring in) is its own button.
 */
export function AddRow({ tile, name, mark, words, status, action, onOpen }: { tile: ReactNode; name: string; mark?: string; words?: string; status?: ReactNode; action?: ReactNode; onOpen?: () => void }) {
  const main = (
    <>
      {tile}
      <span className={cx("min-w-0 truncate text-[14px] font-semibold leading-[22px] sm:max-w-[64%]", !mark && "max-sm:flex-1")}>{name}</span>
      {mark && <span className="shrink-0 rounded-[5px] px-1.5 py-px text-[11px] font-semibold leading-4 text-wisp shadow-[inset_0_0_0_1px_currentColor] max-sm:mr-auto">{mark}</span>}
      {words && <span className="min-w-0 truncate text-[13px] leading-[18px] text-muted max-sm:hidden">{words}</span>}
      <span className="flex-1 max-sm:hidden" />
      {status}
    </>
  );
  return (
    <div className="-mx-1.5 flex h-[52px] items-center gap-3 rounded-[10px] px-1.5 hover:bg-hover max-sm:h-14">
      {onOpen ? (
        <button type="button" onClick={onOpen} className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-[10px] text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
          {main}
        </button>
      ) : (
        <div className="flex h-full min-w-0 flex-1 items-center gap-3">{main}</div>
      )}
      {action}
    </div>
  );
}

/** The amber dot beside something that needs the person (a sign-in that lapsed). */
export function NeedDot() {
  return <span aria-hidden className="size-2 shrink-0 rounded-full bg-st-needs" />;
}

/** The top of an item's page: a 56 px tile, the name, one muted line, and the one action. */
export function ItemHead({ tile, name, line, children }: { tile: ReactNode; name: string; line?: ReactNode; children?: ReactNode }) {
  return (
    // on a narrow phone the action drops under the name instead of squeezing it
    <header className="flex flex-wrap items-center gap-x-4 gap-y-3 py-1">
      {tile}
      <div className="min-w-[9rem] flex-1">
        <h1 className="truncate text-[24px] font-[650] leading-[30px] tracking-[-0.01em]">{name}</h1>
        {line && <p className="truncate text-[14px] leading-[22px] text-muted">{line}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  );
}

/** A card of rows on an item's page. */
export function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-line overflow-hidden rounded-[12px] bg-card">{children}</div>;
}

/**
 * One row of a card: what it is on the left, its value in muted text on the right. With `onClick`
 * (or `href`) it opens something and shows a chevron; `open` turns the chevron for a row that unfolds.
 */
export function FactRow({ label, value, onClick, href, need, open, wrap }: { label: string; value?: ReactNode; onClick?: () => void; href?: string; need?: boolean; open?: boolean; wrap?: boolean }) {
  const cls = "flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] leading-[22px]";
  const inner = (
    <>
      <span className="shrink-0 font-medium">{label}</span>
      <span className={cx("flex min-w-0 flex-1 items-center justify-end gap-2 text-muted", !wrap && "whitespace-nowrap")}>
        {need && <NeedDot />}
        <span className={cx("min-w-0 text-right", wrap ? "break-words" : "truncate")}>{value}</span>
      </span>
      {(onClick || href) && <ChevronRight size={15} aria-hidden className={cx("shrink-0 text-faint", open && "rotate-90")} />}
    </>
  );
  if (href)
    return (
      <a href={href} className={cx(cls, "hover:bg-hover")}>
        {inner}
      </a>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} aria-expanded={open} className={cx(cls, "hover:bg-hover")}>
        {inner}
      </button>
    );
  return <div className={cls}>{inner}</div>;
}

/** "Remove", set apart at the bottom of an item's page. */
export function RemoveBtn({ className, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...p} className={cx("inline-flex h-9 items-center rounded-[8px] px-3.5 text-[14px] text-bad outline-none hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50", className)} />;
}
