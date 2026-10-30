// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// theme.ts reads matchMedia when it loads, so stub it before the components import
vi.hoisted(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
});
import { useStore } from "../store.ts";
import { UserAvatarButton } from "./Rail.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
beforeAll(() => {
  useStore.setState({ me: { user: { name: "Yug Patel" }, workspace: { id: "w1", name: "Home" }, role: "owner" } as never, orgs: [{ id: "w1", name: "Home", role: "owner", current: true, unread: false }] as never });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<UserAvatarButton desktop />));
}
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
const items = () => [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent);

describe("desktop avatar menu", () => {
  it("opens on click and lists Settings and Switch organization", () => {
    mount();
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    press(button);
    click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(items()).toEqual(["Settings", "Switch organization"]);
  });

  it("Switch organization opens the organization dialog with New organization and Join", () => {
    mount();
    const button = host.querySelector("button")!;
    press(button);
    click(button);
    click([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent === "Switch organization")!);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("New organization");
    expect(document.body.textContent).toContain("Join with an invite link");
    // pressing inside the dialog (typing into the invite field) doesn't close it
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Invite link or code"]')!;
    press(input);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
