import { describe, expect, it } from "vitest";
import { isStepDeleteKey } from "./flow.ts";

const key = (k: string, target: object | null = { tagName: "DIV" }, extra = {}) => ({ key: k, target: target as EventTarget | null, ...extra });

describe("isStepDeleteKey", () => {
  it("deletes the picked step on Delete and Backspace", () => {
    expect(isStepDeleteKey(key("Delete"), "a")).toBe(true);
    expect(isStepDeleteKey(key("Backspace"), "a")).toBe(true);
  });
  it("does nothing with no step picked or other keys", () => {
    expect(isStepDeleteKey(key("Delete"), null)).toBe(false);
    expect(isStepDeleteKey(key("a"), "a")).toBe(false);
  });
  it("leaves typing alone", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(isStepDeleteKey(key("Backspace", { tagName }), "a")).toBe(false);
    expect(isStepDeleteKey(key("Backspace", { tagName: "DIV", isContentEditable: true }), "a")).toBe(false);
  });
  it("ignores modified keys, handled keys and open dialogs", () => {
    expect(isStepDeleteKey(key("Backspace", { tagName: "DIV" }, { metaKey: true }), "a")).toBe(false);
    expect(isStepDeleteKey(key("Delete", { tagName: "DIV" }, { defaultPrevented: true }), "a")).toBe(false);
    expect(isStepDeleteKey(key("Delete"), "a", true)).toBe(false);
  });
});
