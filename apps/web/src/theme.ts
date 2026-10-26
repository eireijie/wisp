import { useSyncExternalStore } from "react";

/**
 * Appearance, all remembered on this device:
 * - mode: light or dark, following the OS unless the person picks one
 * - theme: the color theme; Mono (black and white) unless the person picks another
 * - text size: small, default or large (scales everything sized in rem)
 * - motion: "reduce" stills animations (ghosts, spinners stay), on top of the OS setting
 * index.html sets these before first paint; this keeps them in sync.
 */
export type TextSize = "small" | "default" | "large";
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

const MODE_KEY = "wisp.mode";
const THEME_KEY = "wisp.theme";
const TEXT_KEY = "wisp.textSize";
const MOTION_KEY = "wisp.motion";
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
  // wisp.theme used to hold the light/dark choice; carry it over once
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
let textSize: TextSize = ((v) => (v === "small" || v === "large" ? v : "default"))(read(TEXT_KEY));
let reduceMotion = read(MOTION_KEY) === "reduce";
const resolved = (): "light" | "dark" => (mode === "system" ? (media.matches ? "dark" : "light") : mode);

function apply() {
  const root = document.documentElement;
  root.dataset.mode = resolved();
  root.dataset.theme = theme;
  root.dataset.text = textSize;
  if (reduceMotion) root.dataset.motion = "reduce";
  else delete root.dataset.motion;
  // the browser bar matches the content surface
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved() === "dark" ? "#111113" : "#ffffff");
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
export function setTextSize(next: TextSize) {
  textSize = next;
  write(TEXT_KEY, next === "default" ? null : next);
  apply();
}

export function setReduceMotion(on: boolean) {
  reduceMotion = on;
  write(MOTION_KEY, on ? "reduce" : null);
  apply();
}

const motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
motionMedia.addEventListener("change", () => listeners.forEach((l) => l()));
// Also honor the root attribute when changed outside the settings page.
new MutationObserver(() => listeners.forEach((l) => l())).observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });

/** Animations should stay still: the person asked here, or their OS asks for less motion. */
export function motionReduced(): boolean {
  return reduceMotion || motionMedia.matches || document.documentElement.dataset.motion === "reduce";
}

export function useMotionReduced() {
  return useSyncExternalStore(subscribe, motionReduced, () => true);
}

const snapshot = () => `${mode}:${resolved()}:${theme}:${textSize}:${reduceMotion ? 1 : 0}`;

export function useAppearance() {
  const [m, resolvedMode, t, size, motion] = useSyncExternalStore(subscribe, snapshot).split(":") as [ModeChoice, "light" | "dark", ThemeId, TextSize, string];
  return {
    mode: m,
    resolvedMode,
    theme: t,
    textSize: size,
    reduceMotion: motion === "1",
    setMode,
    setTheme,
    setTextSize,
    setReduceMotion,
    toggleMode: () => setMode(resolvedMode === "dark" ? "light" : "dark"),
  };
}
