import { describe, expect, it, vi } from "vitest";
import { CONNECTOR_CATALOG, type MarketplaceEntry, type MarketplaceInstall } from "@warren/core";
import { connectSummary } from "../src/views/ConnectorsView.tsx";

vi.mock("../src/api.ts", () => ({ api: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

const install: MarketplaceInstall = { kind: "mcp-http", label: "Remote", url: "https://mcp.example.com", fields: [] } as unknown as MarketplaceInstall;
const entry = (o: Partial<MarketplaceEntry>): MarketplaceEntry => ({ id: "com.zapier/mcp", name: "Zapier", description: "", publisher: "com.zapier", brand: "zapier", domain: "zapier.com", verified: true, version: "1", website: null, repository: null, icon: null, installs: [install], ...o });

describe("connectSummary", () => {
  it("names the maker for an official server", () => {
    const s = connectSummary({ entry: entry({}), install });
    expect(s.runBy).toBe("Made and run by Zapier (zapier.com), not by Warren.");
    expect(s.can).toContain("use Zapier through this connection");
    expect(s.caution).toBeNull();
  });
  it("says a verified third party is not the app's maker", () => {
    const s = connectSummary({ entry: entry({ id: "com.acme/gmail", name: "Gmail helper", publisher: "com.acme", brand: "acme", domain: "acme.com" }), install });
    expect(s.runBy).toContain("Run by com.acme (acme.com), not by Warren");
    expect(s.runBy).toContain("doesn't mean Gmail helper's own maker endorses it");
  });
  it("warns plainly for an unverified server", () => {
    const s = connectSummary({ entry: entry({ id: "io.github.bob/gmail", name: "Gmail", publisher: "bob", brand: "bob", domain: null, verified: false }), install });
    expect(s.runBy).toBe("Run by bob, not by the app's maker or Warren.");
    expect(s.caution).toContain("Only connect if you trust them");
  });
  it("describes keys honestly", () => {
    const s = connectSummary({ entry: entry({}), install: { ...install, fields: [{ key: "K", label: "K", secret: true }] } as MarketplaceInstall });
    expect(s.can).toContain("get the key you enter");
  });
  it("covers built-in catalog entries", () => {
    const http = CONNECTOR_CATALOG.find((c) => c.kind === "mcp-http")!;
    const stdio = CONNECTOR_CATALOG.find((c) => c.kind === "mcp-stdio")!;
    const secret = CONNECTOR_CATALOG.find((c) => c.kind === "secret")!;
    expect(connectSummary({ builtIn: http }).runBy).toContain(new URL(http.url!).host);
    expect(connectSummary({ builtIn: stdio }).runBy).toContain("own computer");
    expect(connectSummary({ builtIn: secret }).can).toContain("key");
    expect(connectSummary({ builtIn: http }).caution).toBeNull();
  });
});
