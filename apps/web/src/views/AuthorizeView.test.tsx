import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthorizeView } from "./AuthorizeView.tsx";

vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: vi.fn(), useEffect: vi.fn() }));
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));

beforeEach(() => vi.mocked(useState).mockReset());

describe("app authorization copy", () => {
  it.each([null, { client: "Grok", returnsTo: "grok.com" }])("uses Wisp branding and plain language (%j)", (info) => {
    const states = [info, [], "new", "Grok", null, false, false];
    let index = 0;
    vi.mocked(useState).mockImplementation((): [any, any] => [states[index++], vi.fn()]);
    const html = renderToStaticMarkup(AuthorizeView({ requestId: "request" }));
    expect(html).toContain("Wisp");
    expect(html).not.toMatch(/Warren|\b(hub|node|token)\b/i);
    if (info) {
      expect(html).toContain("Let Grok act as an agent?");
    }
  });

  it("says the request expired when the hub no longer has it", () => {
    const states = [null, [], "new", "", null, false, true];
    let index = 0;
    vi.mocked(useState).mockImplementation((): [any, any] => [states[index++], vi.fn()]);
    const html = renderToStaticMarkup(AuthorizeView({ requestId: "request" }));
    expect(html).toContain("This request expired");
    expect(html).toContain("Go back to the app and try connecting again.");
  });
});
