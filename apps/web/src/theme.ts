import { useSyncExternalStore } from "react";

/**
 * Appearance has two parts, both remembered on this device:
 * - mode: light or dark, following the OS unless the person picks one
 * - theme: the color theme; Mono (black and white) unless the person picks another
 * index.html sets data-mode and data-theme before first paint; this keeps them in sync.
 */
export type ModeChoice = "system" | "light" | "dark";
export type ThemeId = (typeof THEMES)[number]["id"];

/** The themes a person can pick. Swatches are [light-mode accent, dark-mode accent]. */
export const THEMES = [
  { id: "mono", name: "Mono", blurb: "Black and white. Color only for status and agents.", swatch: ["#171717", "#f5f5f5"] },
  { id: "mint", name: "Ghost mint", blurb: "Fresh mint with cool grays.", swatch: ["#1aa577", "#43d19c"] },
  { id: "iris", name: "Iris", blurb: "Calm periwinkle with cool grays.", swatch: ["#5b5fe0", "#8b8ef8"] },
  { id: "lilac", name: "Lilac", blurb: "Soft and a little playful.", swatch: ["#8455e0", "#b593ff"] },
  { id: "sky", name: "Sky", blurb: "Clear blue, bright and simple.", swatch: ["#1aa3e8", "#38bdf8"] },
] as const;

const MODE_KEY = "warren.mode";
const THEME_KEY = "warren.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function storedMode(): ModeChoice {
  // warren.theme used to hold the light/dark choice; carry it over once
  const legacy = read(THEME_KEY);
  if (legacy === "light" || legacy === "dark") {
    write(MODE_KEY, legacy);
    write(THEME_KEY, null);
  }
  const v = read(MODE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}
function storedTheme(): ThemeId {
  const v = read(THEME_KEY);
  return THEMES.some((t) => t.id === v) ? (v as ThemeId) : "mono";
}

let mode = storedMode();
let theme = storedTheme();
const resolved = (): "light" | "dark" => (mode === "system" ? (media.matches ? "dark" : "light") : mode);

function apply() {
  const root = document.documentElement;
  root.dataset.mode = resolved();
  root.dataset.theme = theme;
  // the browser bar matches the content surface
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved() === "dark" ? "#0d0d0d" : "#ffffff");
  listeners.forEach((l) => l());
}

media.addEventListener("change", () => {
  if (mode === "system") apply();
});
apply();

export function setMode(next: ModeChoice) {
  mode = next;
  write(MODE_KEY, next === "system" ? null : next);
  apply();
}

export function setTheme(next: ThemeId) {
  theme = next;
  write(THEME_KEY, next === "mono" ? null : next);
  apply();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => `${mode}:${resolved()}:${theme}`;

export function useAppearance() {
  const [m, resolvedMode, t] = useSyncExternalStore(subscribe, snapshot).split(":") as [ModeChoice, "light" | "dark", ThemeId];
  return { mode: m, resolvedMode, theme: t, setMode, setTheme, toggleMode: () => setMode(resolvedMode === "dark" ? "light" : "dark") };
}
