import { MAX_PINS, type Section, type SidebarLayout } from "@bubble-ai/core";

/**
 * The sidebar's pins and sections (2026-11-25 "Bubble AI, bubbles", board 7). Kept per person in the
 * hub (UserPrefs.sidebar) so a phone shows the same list. Until someone changes anything, the
 * layout is read from what Bubble AI kept before: starred chats are the pins, the workspace's sections
 * and each chat's section are the sections. Every change here returns a new layout to save.
 */

export interface LayoutChat {
  key: string;
  name: string;
  pinned: boolean;
  sectionId: string | null;
  unread: number;
  /** an agent's chat or a team's */
  kind?: "dm" | "team";
  /** last activity (ms) */
  at?: number;
}

/** Where a chat shows: a pin, or a section ("none" is No section). */
export interface PlacedSection {
  id: string;
  name: string;
  folded: boolean;
  keys: string[];
  /** "No section" */
  none?: boolean;
}

export const NONE = "none";

/**
 * The layout as saved, or the one read from before (starred = pinned, the workspace's sections).
 * Nothing is pinned for someone who never pinned anything (round 16, board 16c): the hub pins the
 * person's first agent when it's made, and every other pin is theirs.
 */
export function baseLayout(saved: SidebarLayout | undefined, chats: readonly LayoutChat[], sections: readonly Section[], folded: Record<string, boolean> = {}): SidebarLayout {
  if (saved) return saved;
  return {
    pins: chats.filter((c) => c.pinned).slice(0, MAX_PINS).map((c) => c.key),
    sections: sections.map((s) => ({ id: s.id, name: s.name, folded: !!folded[s.id] || undefined, items: chats.filter((c) => c.sectionId === s.id).map((c) => c.key) })),
  };
}

/**
 * Lay the chats out: the pins (in pin order, only chats that still exist), then each section and
 * "No section" last, each in the chats' own order (newest first). A hidden chat stays out until a
 * new message arrives in it.
 */
export function placeChats(layout: SidebarLayout, chats: readonly LayoutChat[]): { pins: string[]; sections: PlacedSection[] } {
  const exists = new Set(chats.map((c) => c.key));
  const hidden = new Set(layout.hidden ?? []);
  const shown = (k: string) => exists.has(k) && !(hidden.has(k) && !(chats.find((c) => c.key === k)?.unread ?? 0));
  const pins = layout.pins.filter((k) => shown(k)).slice(0, MAX_PINS);
  const pinned = new Set(pins);
  const owner = new Map<string, string>();
  for (const s of layout.sections) for (const k of s.items) if (!owner.has(k)) owner.set(k, s.id);
  const sections: PlacedSection[] = layout.sections.map((s) => ({ id: s.id, name: s.name, folded: !!s.folded, keys: chats.filter((c) => owner.get(c.key) === s.id && !pinned.has(c.key) && shown(c.key)).map((c) => c.key) }));
  sections.push({ id: NONE, name: "No section", folded: !!layout.noneFolded, none: true, keys: chats.filter((c) => !owner.has(c.key) && !pinned.has(c.key) && shown(c.key)).map((c) => c.key) });
  return { pins, sections };
}

const without = (xs: readonly string[] | undefined, k: string) => (xs ?? []).filter((x) => x !== k);

/** Pin a chat (it leaves its section's list while pinned, and comes back there when unpinned). Full: null. */
export function pin(l: SidebarLayout, key: string): SidebarLayout | null {
  if (l.pins.includes(key)) return l;
  if (l.pins.length >= MAX_PINS) return null;
  return { ...l, pins: [...l.pins, key], hidden: without(l.hidden, key) };
}

export const unpin = (l: SidebarLayout, key: string): SidebarLayout => ({ ...l, pins: without(l.pins, key) });

/** Move a pin to another place among the pins. */
export function movePin(l: SidebarLayout, key: string, to: number): SidebarLayout {
  const rest = without(l.pins, key);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, key);
  return { ...l, pins: rest };
}

/** Put a chat in a section (or No section), unpinning it if it was pinned. */
export function moveTo(l: SidebarLayout, key: string, sectionId: string): SidebarLayout {
  return {
    ...l,
    pins: without(l.pins, key),
    hidden: without(l.hidden, key),
    sections: l.sections.map((s) => ({ ...s, items: s.id === sectionId ? [...without(s.items, key), key] : without(s.items, key) })),
  };
}

/** A new section, before "No section"; `key` moves into it. */
export function addSection(l: SidebarLayout, name: string, id: string, key?: string): SidebarLayout {
  const next = { ...l, sections: [...l.sections, { id, name, items: [] as string[] }] };
  return key ? moveTo(next, key, id) : next;
}

export const renameSection = (l: SidebarLayout, id: string, name: string): SidebarLayout => ({ ...l, sections: l.sections.map((s) => (s.id === id ? { ...s, name: name.trim().slice(0, 40) || s.name } : s)) });

/** Deleting a section keeps its chats: they go to No section. */
export const deleteSection = (l: SidebarLayout, id: string): SidebarLayout => ({ ...l, sections: l.sections.filter((s) => s.id !== id) });

export function foldSection(l: SidebarLayout, id: string, folded: boolean): SidebarLayout {
  if (id === NONE) return { ...l, noneFolded: folded || undefined };
  return { ...l, sections: l.sections.map((s) => (s.id === id ? { ...s, folded: folded || undefined } : s)) };
}

export const hide = (l: SidebarLayout, key: string): SidebarLayout => ({ ...l, pins: without(l.pins, key), hidden: [...without(l.hidden, key), key] });

export const markUnread = (l: SidebarLayout, key: string): SidebarLayout => ({ ...l, unread: [...without(l.unread, key), key] });

export const clearUnread = (l: SidebarLayout, key: string): SidebarLayout => ({ ...l, unread: without(l.unread, key) });

/** A chat that was deleted leaves every list. */
export const forget = (l: SidebarLayout, key: string): SidebarLayout => ({ ...l, pins: without(l.pins, key), hidden: without(l.hidden, key), unread: without(l.unread, key), sections: l.sections.map((s) => ({ ...s, items: without(s.items, key) })) });

/** A name for a new folder that isn't taken: "New folder", "New folder 2"… */
export function newSectionName(l: SidebarLayout): string {
  const taken = new Set(l.sections.map((s) => s.name));
  for (let n = 1; ; n++) {
    const name = n === 1 ? "New folder" : `New folder ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** What a 10th pin says. */
export const pinsFullNotice = (name: string) => `${MAX_PINS} pinned is the most. Unpin one to pin ${name}.`;

/**
 * The home (round 11's boards 8 and 9, round 16's board 16c): the tile row is only the pins, in pin
 * order; every other agent and team is a chat in its folder ("Unsorted" last), newest first, whether
 * or not it has messages yet. A pinned chat leaves the folders while pinned and comes back when
 * unpinned. Hidden chats leave both until something new arrives in them.
 */
export function placeHome(layout: SidebarLayout, chats: readonly LayoutChat[]): { tiles: string[]; folders: PlacedSection[] } {
  const placed = placeChats(layout, chats);
  return { tiles: placed.pins, folders: placed.sections.map((s) => (s.none ? { ...s, name: "Unsorted" } : s)) };
}
