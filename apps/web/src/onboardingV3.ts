import { api } from "./api.ts";

/**
 * Onboarding v3's answers: what the person wants help with (page 2) and what Wisp will turn on for
 * it. Saved per workspace in this browser so later pages (the agent's role, its first task, and
 * "Here's your Wisp", which creates the routines and turns on the mods) can read them, and as an
 * "About me" memory so every agent already knows.
 */

/** Something Wisp sets up for a goal on the last page. `label` is what the person sees. */
export type TurnOn = { label: string } & (
  | { kind: "routine"; title: string; time: string; every: "day" | "week" }
  | { kind: "mod"; id: "code" | "apple" }
  | { kind: "computer" }
  | { kind: "connector"; name: string }
  | { kind: "feature"; id: "memory" | "calls" | "password-manager" }
);

export interface Goal {
  id: GoalId;
  label: string;
  /** a 24×24 line-icon path (stroke, no fill) */
  icon: string;
  /** when the sample message arrives in "A day with me" */
  when: string;
  /** what the wisp would send */
  text: string;
  turnOn: TurnOn[];
}

export type GoalId = "email" | "cal" | "code" | "research" | "writing" | "money" | "errands" | "biz" | "home" | "learn";

const routine = (title: string, time: string, every: "day" | "week", label: string): TurnOn => ({ kind: "routine", title, time, every, label });
const computer: TurnOn = { kind: "computer", label: "Shared computer" };
const memory: TurnOn = { kind: "feature", id: "memory", label: "Memory notes" };

export const GOALS: Goal[] = [
  { id: "email", label: "Email", icon: "M4 6h16v12H4zM4 7l8 6 8-6", when: "8:02", text: "Morning. 3 emails need you. I drafted replies to two, want to look?", turnOn: [{ kind: "connector", name: "email", label: "Gmail or Outlook" }, routine("Inbox check", "08:00", "day", "Inbox check, 8:00 daily")] },
  { id: "cal", label: "Calendar", icon: "M5 5h14v15H5zM5 10h14M9 3v4M15 3v4", when: "8:40", text: "Your 2pm moved to Thursday. I found a slot that works for both of you.", turnOn: [{ kind: "connector", name: "calendar", label: "Calendar" }, routine("Day plan", "07:30", "day", "Day plan, 7:30 daily")] },
  { id: "code", label: "Code", icon: "m8 8-4 4 4 4M16 8l4 4-4 4M13 6l-2 12", when: "10:15", text: "Fixed the login bug on my computer. PR is open, tests pass.", turnOn: [computer, { kind: "connector", name: "github", label: "GitHub" }, { kind: "mod", id: "code", label: "Code mod" }] },
  { id: "research", label: "Research", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4", when: "11:30", text: "I read 14 reviews of those three laptops. Short version in your notes.", turnOn: [computer, memory] },
  { id: "writing", label: "Writing", icon: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4", when: "13:05", text: "First draft of the newsletter is ready. I kept it under 400 words.", turnOn: [{ kind: "connector", name: "docs", label: "Docs" }] },
  { id: "money", label: "Money and bills", icon: "M4 7h16v10H4zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", when: "15:20", text: "Your phone bill went up $12. Want me to find out why? I won’t pay anything.", turnOn: [routine("Bill watch", "09:00", "week", "Bill watch, weekly")] },
  { id: "errands", label: "Errands and shopping", icon: "M6 7h12l-1 13H7zM9 7a3 3 0 0 1 6 0", when: "16:45", text: "Found the filter you need for $18. Should I put it in your cart?", turnOn: [{ kind: "feature", id: "password-manager", label: "Password manager logins" }] },
  { id: "biz", label: "My business", icon: "M4 8h16v11H4zM9 8V5h6v3", when: "17:30", text: "Two new orders today. I updated the sheet and replied to the customer.", turnOn: [{ kind: "connector", name: "business apps", label: "Your business apps" }, routine("Evening summary", "18:00", "day", "Evening summary, 18:00")] },
  { id: "home", label: "Home and family", icon: "M4 11 12 4l8 7v9H4z", when: "18:10", text: "Reminder: soccer pickup moved to 5:30. I can call you at 5:15.", turnOn: [{ kind: "feature", id: "calls", label: "Calls" }, { kind: "mod", id: "apple", label: "Apple mod: reminders" }] },
  { id: "learn", label: "Learning", icon: "M3 8l9-4 9 4-9 4zM7 10v5c3 2 7 2 10 0v-5", when: "20:00", text: "Ready for 10 minutes of Spanish? I picked up where we stopped.", turnOn: [memory, routine("Lesson", "20:00", "day", "Lesson, 20:00 daily")] },
];

export const goalById = (id: string) => GOALS.find((g) => g.id === id);

/** The picked goals, in catalogue order. */
export const pickedGoals = (ids: readonly string[]) => GOALS.filter((g) => ids.includes(g.id));

/** Everything the picks turn on, each once (by label), in pick order. */
export function turnOnFor(ids: readonly string[]): TurnOn[] {
  const seen = new Set<string>();
  const out: TurnOn[] = [];
  for (const g of pickedGoals(ids)) for (const t of g.turnOn) if (!seen.has(t.label)) (seen.add(t.label), out.push(t));
  return out;
}

export interface OnboardingAnswers {
  goals: GoalId[];
  /** "Something else? Say it in your words" */
  other: string;
  turnOn: TurnOn[];
  /** page 2 was answered (Continue) or passed (Skip for now) */
  goalsDone: boolean;
  skipped?: boolean;
  /** page 3: what Wisp knows about the person (kept chips), and that the page was passed */
  facts?: Fact[];
  knowDone?: boolean;
  /** page 4: the agent it made */
  agentId?: string;
  /** page 4: the agent the person shaped; page 5 creates it once its AI is chosen */
  agentDraft?: AgentDraft;
  /** page 5's Continue switched on calls, routines and the morning plan (onboardingSetup) */
  setupDone?: boolean;
  savedAt?: number;
}

const EMPTY: OnboardingAnswers = { goals: [], other: "", turnOn: [], goalsDone: false };
const key = (workspaceId: string) => `wisp.onboardingV3.${workspaceId}`;

export function loadAnswers(workspaceId: string): OnboardingAnswers {
  try {
    const raw = JSON.parse(localStorage.getItem(key(workspaceId)) ?? "null");
    return raw && typeof raw === "object" ? { ...EMPTY, ...raw } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

export function saveAnswers(workspaceId: string, patch: Partial<OnboardingAnswers>): OnboardingAnswers {
  const next = { ...loadAnswers(workspaceId), ...patch, savedAt: Date.now() };
  try {
    localStorage.setItem(key(workspaceId), JSON.stringify(next));
  } catch {}
  return next;
}

/** Page 2's answers: the picks, what they turn on, and the free text. */
export function saveGoals(workspaceId: string, goals: readonly string[], other: string): OnboardingAnswers {
  const ids = pickedGoals(goals).map((g) => g.id);
  return saveAnswers(workspaceId, { goals: ids, other: other.trim(), turnOn: turnOnFor(ids), goalsDone: true, skipped: false });
}

export const skipGoals = (workspaceId: string) => saveAnswers(workspaceId, { goals: [], other: "", turnOn: [], goalsDone: true, skipped: true });

/** "Sam wants help with: email, code. Also: …" (null when there's nothing to say). */
export function aboutMeLine(name: string, goals: readonly string[], other: string): string | null {
  const picks = pickedGoals(goals).map((g) => g.label.toLowerCase());
  const extra = other.trim();
  if (!picks.length && !extra) return null;
  const who = name.trim().split(/\s+/)[0] || "They";
  const parts = [picks.length ? `${who} wants help with: ${picks.join(", ")}.` : `${who} wants help with: ${extra}`];
  if (picks.length && extra) parts.push(`In their words: ${extra}`);
  return parts.join(" ");
}

const ABOUT_MARK = " wants help with: ";

/**
 * Saves the line to the person's "About me" memory (what every agent reads before it works),
 * replacing the one an earlier run of this page wrote. Never throws.
 */
export async function rememberGoals(name: string, goals: readonly string[], other: string): Promise<boolean> {
  const text = aboutMeLine(name, goals, other);
  if (!text) return false;
  try {
    const profile = await api<{ items: { path: string; text: string }[] }>("GET", "/api/memory/profile?user=me").catch(() => null);
    const old = profile?.items.find((i) => i.text.includes(ABOUT_MARK));
    const r = await api<{ saved: boolean }>("POST", "/api/memory/remember", { about: "me", kind: "preference", text, pinned: true, force: true, ...(old ? { replaces: old.path } : {}) });
    return !!r.saved;
  } catch {
    return false;
  }
}

// --- page 3: let me get to know you -------------------------------------------------------------

export type FactGroup = "You" | "Work" | "Tools" | "Likes";
export const FACT_GROUPS: FactGroup[] = ["You", "Work", "Tools", "Likes"];
/** The memory note each group is saved under, in the person's About me. */
export const NOTE_OF_GROUP: Record<FactGroup, string> = { You: "About me", Work: "Projects", Tools: "Tools and accounts", Likes: "Preferences and rules" };

export interface Fact {
  id: string;
  group: FactGroup;
  text: string;
  /** shown on the chip: "git", "CLAUDE.md", "ChatGPT", "you" */
  src: string;
}

export type ScanPart = "git" | "harnesses" | "notes" | "projects";
export const SCAN_PARTS: { id: ScanPart; label: string }[] = [
  { id: "git", label: "Who you are in git" },
  { id: "harnesses", label: "AI apps you're signed in to" },
  { id: "notes", label: "Your notes for them" },
  { id: "projects", label: "Projects you opened lately" },
];

/** What the agent is told about the notes, word for word from the design. */
export const notesInstruction = (name: string) =>
  `These notes are what you know about ${name}. Use them without asking again. In your first message, show you know them: mention one or two specifics from the notes, never a list.`;

/** Where each heading of a memory-import answer goes; "People" stays out (nothing private about others). */
const GROUP_OF_HEADING: Record<string, FactGroup | null> = {
  "About me": "You",
  Projects: "Work",
  "In progress": "Work",
  Decisions: "Work",
  "Preferences and rules": "Likes",
  Routines: "Likes",
  "Tools and accounts": "Tools",
  People: null,
  Other: "You",
};

export function factsFromAnswer(lines: { heading: string; text: string; unsure: boolean }[], src: string): Omit<Fact, "id">[] {
  return lines.flatMap((l) => {
    const group = GROUP_OF_HEADING[l.heading];
    return group && !l.unsure ? [{ group, text: l.text.replace(/\s*\((?:memory|chat[^)]*|CLAUDE\.md|AGENTS\.md)\)\s*$/i, "").slice(0, 200), src }] : [];
  });
}

// --- page 4: your agent ------------------------------------------------------------------------

/** Page 4's agent, saved on Continue; page 5 creates the real agent from it. */
export interface AgentDraft {
  name: string;
  handle?: string;
  /** "What I do", one line */
  role: string;
  /** one of FAMILY_COLORS; the ghost shades it into its gradient */
  color: string;
  /** the shape the app stores (GhostAppearance.shape) */
  shape: "classic" | "round" | "tall" | "sheet" | "wisp";
  /** the start of its instructions */
  instructions: string;
}

/** "You are Juno, Sam's agent in Wisp. Your job: … Ask before connecting an account, spending money or sending anything as them." */
export function agentInstructions(agent: string, person: string, role: string, goals: readonly string[], other = ""): string {
  const who = person.trim().split(/\s+/)[0] || "the person";
  const picks = pickedGoals(goals).map((g) => g.label.toLowerCase());
  const want = picks.length ? picks.join(", ") : other.trim();
  const job = role.trim().replace(/[.\s]+$/, "");
  return [
    `You are ${agent.trim()}, ${who}'s agent in Wisp.`,
    job ? `Your job: ${job}.` : "",
    want ? `${who} wants help with: ${want.replace(/[.\s]+$/, "")}.` : "",
    "What you know about them is in your notes; use it without asking again.",
    "Ask before connecting an account, spending money or sending anything as them.",
  ]
    .filter(Boolean)
    .join(" ");
}

export const saveAgentDraft = (workspaceId: string, agentDraft: AgentDraft) => saveAnswers(workspaceId, { agentDraft });

/** What each pick reads like in "What I do" and in the preview message. */
export const PHRASE: Record<GoalId, string> = {
  email: "your inbox",
  cal: "your calendar",
  code: "your code",
  research: "research",
  writing: "your writing",
  money: "your bills",
  errands: "errands",
  biz: "your business",
  home: "home and family",
  learn: "your learning",
};

export const listOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Helps with your inbox, your calendar and research, so you have more time." Every pick reads after "Helps with". */
export function roleLine(goals: readonly string[], other: string, facts: readonly { group: string; text: string }[]): string {
  const picks = pickedGoals(goals).map((g) => PHRASE[g.id]);
  if (picks.length) return `Helps with ${listOf(picks.slice(0, 3))}, so you have more time.`;
  const extra = other.trim().replace(/[.\s]+$/, "");
  if (extra) return `${cap(extra)}, and whatever else you need.`;
  const work = facts.find((f) => f.group === "Work");
  if (work) return `Help with ${work.text.replace(/[.\s]+$/, "").replace(/^./, (c) => c.toLowerCase())}, and whatever else you need.`;
  return "Helps with whatever you need, so you have more time.";
}
