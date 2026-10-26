import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import {
  AppWindow,
  BadgeCheck,
  BookOpen,
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
import type { AppCategory, TrustLabel } from "@wisp/core";
import { Modal, cx } from "./ui.tsx";

/*
 * The shapes the marketplace, harnesses and logins share, drawn from the approved market-*.dc.html
 * screens: neutral line-icon tiles (never brand logos), grouped rounded cards, little pills, iOS-style
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

/** A tile for an app: a line icon picked from its name, never its logo. */
export function AppTile({ name, category, icon, size = 40 }: { name: string; category?: AppCategory | null; icon?: ReactNode; size?: number }) {
  const I = appIcon(name, category);
  return <Tile size={size}>{icon ?? <I size={Math.round(size * 0.5)} strokeWidth={1.7} />}</Tile>;
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
    <span title={title} className={cx("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold", TONE[tone])}>
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
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={cx("relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors disabled:opacity-40", on ? "bg-[#0a84ff]" : "bg-ink/20")}>
      <span className={cx("absolute top-0.5 size-[27px] rounded-full bg-white shadow transition-[left]", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

/** A segmented control: one option on. */
export function Seg<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-full bg-control p-[3px]">
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled} onClick={() => onChange(v)} className={cx("h-[38px] flex-1 rounded-full px-3 text-sm font-medium whitespace-nowrap disabled:opacity-50", value === v ? "bg-ink/12 text-ink" : "text-muted hover:text-ink")}>
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
export function Item({ icon, title, sub, right, onClick, href, danger, disabled, children, label }: { icon?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; href?: string; danger?: boolean; disabled?: boolean; children?: ReactNode; label?: string }) {
  const body = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className={cx("truncate text-[17px] font-medium", danger && "text-bad")}>{title}</span>
        {sub && <span className="truncate text-sm text-faint">{sub}</span>}
        {children}
      </span>
    </>
  );
  const cls = "flex min-h-16 w-full min-w-0 items-center gap-3.5 px-4 py-2.5 text-left";
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
    <div className="flex min-w-0 items-center hover:bg-hover">
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
  return <button type="button" {...p} className={cx(btn, "h-[50px] rounded-full bg-accent px-6 text-base font-semibold text-accent-ink hover:bg-accent/90", className)} />;
}

/** A secondary capsule. */
export function Sec({ className, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...p} className={cx(btn, "h-11 rounded-full border border-control-line bg-control px-[18px] text-[15px] hover:bg-hover", className)} />;
}

/** "Add", "Install", "Bring in": the small button at the end of a row. */
export function Add({ className, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...p} className={cx(btn, "h-[38px] rounded-full bg-chip px-[18px] text-[15px] hover:bg-hover", className)} />;
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

export function TextBox({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
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

/** A search field: a capsule with a magnifier. */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="flex h-[46px] min-w-0 flex-1 items-center gap-2.5 rounded-full border border-control-line bg-control px-4 text-faint focus-within:ring-3 focus-within:ring-ring/30">
      <Search size={18} aria-hidden className="shrink-0" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-faint" />
    </label>
  );
}

/** A chip that filters or picks. */
export function Chip({ on, onClick, children, count }: { on?: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cx("inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-sm font-medium", on ? "border-accent bg-accent text-accent-ink" : "border-control-line bg-control text-ink/80 hover:text-ink")}>
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
    <Modal title={title} headerless onClose={onClose} wide={wide} className="!rounded-t-[38px] sm:!rounded-[28px]" contentClassName="!p-0">
      <div className="flex items-start gap-3 px-5 pb-3 pt-5 sm:px-6 sm:pt-6">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold">{title}</h2>
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
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cx("h-10 max-w-[14rem] rounded-full border border-control-line bg-control px-3.5 text-sm text-ink outline-none focus:ring-3 focus:ring-ring/30 disabled:opacity-60", className)}>
      {children}
    </select>
  );
}

/** A card of information that isn't a list (an explanation, a callout). */
export function Note({ children, tone }: { children: ReactNode; tone?: "warn" | "bad" }) {
  return <div className={cx("rounded-3xl bg-card px-4 py-3.5 text-[15px] leading-snug text-ink/90 md:border md:border-line", tone === "warn" && "text-warn", tone === "bad" && "text-bad")}>{children}</div>;
}
