import { describe, expect, it } from "vitest";
import { MAX_PINS, type SidebarLayout } from "@bubble-ai/core";
import { addSection, baseLayout, clearUnread, deleteSection, forget, hide, markUnread, movePin, moveTo, newSectionName, NONE, pin, pinsFullNotice, placeChats, placeHome, renameSection, unpin, type LayoutChat } from "./sidebarLayout.ts";

const chat = (key: string, o: Partial<LayoutChat> = {}): LayoutChat => ({ key, name: key, pinned: false, sectionId: null, unread: 0, ...o });
const empty: SidebarLayout = { pins: [], sections: [] };

describe("sidebar layout", () => {
  it("starts from what was kept before: starred chats are pins, the workspace's sections hold their chats", () => {
    const chats = [chat("a:1", { pinned: true }), chat("c:2", { sectionId: "s1" }), chat("a:3")];
    const l = baseLayout(undefined, chats, [{ id: "s1", name: "Work" } as never]);
    expect(l.pins).toEqual(["a:1"]);
    expect(l.sections).toEqual([{ id: "s1", name: "Work", folded: undefined, items: ["c:2"] }]);
    // once saved, the saved one wins
    expect(baseLayout(empty, chats, [])).toBe(empty);
  });

  it("pins nothing for someone who never pinned (round 16: the hub pins their first agent); their own choice wins after", () => {
    const chats = [chat("a:old", { kind: "dm", at: 1 }), chat("c:team", { kind: "team", at: 9 }), chat("a:new", { kind: "dm", at: 8 })];
    expect(baseLayout(undefined, chats, []).pins).toEqual([]);
    // unpinning everything is a choice too
    expect(baseLayout(empty, chats, []).pins).toEqual([]);
    // chats starred before still count as pins
    expect(baseLayout(undefined, [...chats, chat("c:star", { kind: "team", pinned: true })], []).pins).toEqual(["c:star"]);
  });

  it("places pins first, then each section, then No section last", () => {
    const chats = [chat("a"), chat("b"), chat("c"), chat("d")];
    const l: SidebarLayout = { pins: ["b"], sections: [{ id: "s", name: "Work", items: ["c"] }] };
    const p = placeChats(l, chats);
    expect(p.pins).toEqual(["b"]);
    expect(p.sections.map((s) => [s.id, s.keys])).toEqual([
      ["s", ["c"]],
      [NONE, ["a", "d"]],
    ]);
  });

  it("round 16 home: the tile row is only pins; every other chat sits in its folder, messages or not", () => {
    const chats = [chat("a", { at: 5 }), chat("b", { at: 0 }), chat("c", { at: 3 }), chat("d", { at: 2, unread: 1 }), chat("e", { at: 1 })];
    const l: SidebarLayout = { pins: ["c"], sections: [{ id: "s", name: "Work", items: ["c", "e"] }], hidden: ["e", "d"] };
    const h = placeHome(l, chats);
    expect(h.tiles).toEqual(["c"]);
    // e is hidden; d is hidden but has something new, so it's back; b has no messages yet and still shows
    expect(h.folders.map((f) => [f.id, f.name, f.keys])).toEqual([
      ["s", "Work", []],
      [NONE, "Unsorted", ["a", "b", "d"]],
    ]);
    // unpinned, it's back in its folder and off the tile row
    const u = placeHome(unpin(l, "c"), chats);
    expect(u.tiles).toEqual([]);
    expect(u.folders[0].keys).toEqual(["c"]);
    // nothing pinned: no tiles at all
    expect(placeHome({ pins: [], sections: [] }, chats).tiles).toEqual([]);
  });

  it(`keeps at most ${MAX_PINS} pins; the next one is refused with a plain notice`, () => {
    let l = empty;
    for (let i = 0; i < MAX_PINS; i++) l = pin(l, `a:${i}`)!;
    expect(l.pins).toHaveLength(MAX_PINS);
    expect(pin(l, "a:x")).toBeNull();
    expect(pinsFullNotice("Sage")).toBe("9 pinned is the most. Unpin one to pin Sage.");
    expect(unpin(l, "a:0").pins).toHaveLength(MAX_PINS - 1);
  });

  it("reorders pins", () => {
    expect(movePin({ pins: ["a", "b", "c"], sections: [] }, "c", 0).pins).toEqual(["c", "a", "b"]);
  });

  it("moving to a section unpins and leaves every other section", () => {
    let l: SidebarLayout = { pins: ["a"], sections: [{ id: "s1", name: "One", items: [] }, { id: "s2", name: "Two", items: ["a"] }] };
    l = moveTo(l, "a", "s1");
    expect(l.pins).toEqual([]);
    expect(l.sections.map((s) => s.items)).toEqual([["a"], []]);
    // No section: in none of them
    expect(moveTo(l, "a", "__none__").sections.every((s) => !s.items.includes("a"))).toBe(true);
  });

  it("new sections get a free name, rename keeps a name, delete keeps the chats", () => {
    let l = addSection(empty, newSectionName(empty), "s1", "a");
    expect(l.sections[0]).toMatchObject({ name: "New folder", items: ["a"] });
    expect(newSectionName(l)).toBe("New folder 2");
    expect(renameSection(l, "s1", "   ").sections[0].name).toBe("New folder");
    l = renameSection(l, "s1", "Clients");
    expect(l.sections[0].name).toBe("Clients");
    l = deleteSection(l, "s1");
    expect(placeChats(l, [chat("a")]).sections.find((s) => s.none)?.keys).toEqual(["a"]);
  });

  it("a hidden chat comes back when something new arrives in it", () => {
    const l = hide({ pins: ["a"], sections: [] }, "a");
    expect(l.pins).toEqual([]);
    expect(placeChats(l, [chat("a")]).sections[0].keys).toEqual([]);
    expect(placeChats(l, [chat("a", { unread: 1 })]).sections[0].keys).toEqual(["a"]);
  });

  it("marks and clears unread, and forgets a deleted chat everywhere", () => {
    let l = markUnread(empty, "a");
    expect(l.unread).toEqual(["a"]);
    expect(clearUnread(l, "a").unread).toEqual([]);
    l = { pins: ["a"], sections: [{ id: "s", name: "S", items: ["a"] }], hidden: ["a"], unread: ["a"] };
    expect(forget(l, "a")).toEqual({ pins: [], sections: [{ id: "s", name: "S", items: [] }], hidden: [], unread: [] });
  });
});
