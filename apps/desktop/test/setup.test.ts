import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function fixture() {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: true, value: "", textContent: "", focus: vi.fn(), replaceChildren: vi.fn(), append: vi.fn(), style: {} });
    return elements.get(id)!;
  };
  const server = { id: 42, name: "saved-server", ip: "203.0.113.7", type: "cx23", location: "fsn1" };
  const setup = { check: async () => ({}), onCloudStep: vi.fn(), cloudPlans: vi.fn(async () => ({ ok: true, plans: [], locations: [], currency: "EUR" })), cloudCreate: vi.fn(async () => ({ ok: true, url: "https://hub" })) };
  const html = readFileSync(new URL("../src/setup.html", import.meta.url), "utf8");
  const code = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  runInNewContext(code, {
    window: { warrenSetup: setup }, location: { search: `?state=${encodeURIComponent(JSON.stringify({ step: "cloud", server }))}` },
    URLSearchParams, URL, Intl, Option: class {},
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ append: vi.fn() }) },
  });
  return { element, setup };
}

describe("resuming cloud setup after relaunch", () => {
  it("shows Keep waiting and resumes the saved server after re-entering credentials, even without available plans", async () => {
    const f = fixture();
    await Promise.resolve();
    expect(f.element("cloud").hidden).toBe(false);
    expect(f.element("cloud-fail-actions").hidden).toBe(false);
    expect(f.element("cloud-fail-hint").textContent).toContain("saved-server");
    f.element("cloud-wait").onclick();
    expect(f.element("cloud-connect").hidden).toBe(false);
    f.element("cloud-token").value = "token";
    await f.element("cloud-token-form").onsubmit({ preventDefault() {} });
    expect(f.element("cloud-choose").hidden).toBe(false);
    expect(f.element("cloud-go").textContent).toBe("Keep waiting");
    f.element("cloud-name").value = "Ada";
    f.element("cloud-email").value = "ada@example.com";
    f.element("cloud-password").value = "password";
    f.element("cloud-form").onsubmit({ preventDefault() {} });
    await Promise.resolve();
    expect(f.setup.cloudCreate).toHaveBeenCalledWith("token", expect.objectContaining({ resume: 42, account: { name: "Ada", email: "ada@example.com", password: "password" } }));
  });
});
