import { describe, expect, it, vi } from "vitest";
import { defaultLanguage, filterVoices, languageLabel, recommendVoices, type VoiceInfo } from "../src/voice/VoicePicker.tsx";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));

const v = (name: string, lang: string, extra: Partial<VoiceInfo> = {}): VoiceInfo => ({ name, lang, voiceURI: `${name}-${lang}`, ...extra });
const list = [
  v("Zarvox", "en-US", { localService: true }),
  v("Albert (English (US))", "en-US", { localService: true }),
  v("Thomas", "fr-FR", { localService: true }),
  v("Daniel", "en-GB", { localService: true }),
  v("Samantha", "en-US", { localService: true, default: true }),
  v("Google US English", "en-US"),
  v("Ava (Premium)", "en-US", { localService: true }),
  v("Tessa (Compact)", "en-ZA", { localService: true }),
];

describe("recommendVoices", () => {
  it("keeps the person's language and region first and drops novelty voices", () => {
    const names = recommendVoices(list, "en-US").map((x) => x.name);
    expect(names[0]).toBe("Ava (Premium)");
    expect(names).toContain("Samantha");
    expect(names).not.toContain("Zarvox");
    expect(names).not.toContain("Albert (English (US))");
    expect(names).not.toContain("Thomas");
    expect(names.length).toBeLessThanOrEqual(4);
  });
  it("puts same-language other regions after the exact region and compact voices last", () => {
    const names = recommendVoices(list, "en-GB", 10).map((x) => x.name);
    expect(names[0]).toBe("Daniel");
    expect(names[names.length - 1]).toBe("Tessa (Compact)");
  });
  it("falls back to any non-novelty voice when nothing speaks the language", () => {
    expect(recommendVoices(list, "ja-JP", 2).map((x) => x.name)).not.toContain("Zarvox");
    expect(recommendVoices(list, "ja-JP", 2)).toHaveLength(2);
  });
  it("accepts a bare language and respects count", () => {
    expect(recommendVoices(list, "fr", 3).map((x) => x.name)).toEqual(["Thomas"].concat(recommendVoices(list, "fr", 3).slice(1).map((x) => x.name)).slice(0, 3));
    expect(recommendVoices(list, "en", 2)).toHaveLength(2);
  });
});

describe("filterVoices", () => {
  it("filters by language and name, and all languages when empty", () => {
    expect(filterVoices(list, { query: "", lang: "fr-FR" }).map((x) => x.name)).toEqual(["Thomas"]);
    expect(filterVoices(list, { query: "SAM", lang: "" }).map((x) => x.name)).toEqual(["Samantha"]);
    expect(filterVoices(list, { query: "", lang: "" })).toHaveLength(list.length);
    expect(filterVoices(list, { query: "Samantha", lang: "fr-FR" })).toEqual([]);
  });
  it("treats underscores in tags like dashes", () => {
    expect(filterVoices([v("Eva", "de_DE")], { query: "", lang: "de-DE" })).toHaveLength(1);
  });
});

describe("languageLabel", () => {
  it("names the language in full", () => {
    expect(languageLabel("en-US", "en")).toMatch(/English/);
    expect(languageLabel("en-US", "en")).not.toBe("en-US");
  });
  it("falls back to the tag when Intl.DisplayNames is missing", () => {
    const original = Intl.DisplayNames;
    (Intl as unknown as { DisplayNames?: unknown }).DisplayNames = undefined;
    try { expect(languageLabel("en-US")).toBe("en-US"); } finally { (Intl as unknown as { DisplayNames?: unknown }).DisplayNames = original; }
  });
  it("falls back when the tag is invalid", () => { expect(languageLabel("not a tag!!")).toBe("not a tag!!"); });
});

describe("defaultLanguage", () => {
  it("prefers the exact tag, then the same language, then everything", () => {
    expect(defaultLanguage(list, "en-GB")).toBe("en-GB");
    expect(defaultLanguage(list, "fr-CA")).toBe("fr-FR");
    expect(defaultLanguage(list, "ja-JP")).toBe("");
  });
});
