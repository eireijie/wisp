import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import { canApproveJoin, displayJoinCode, loadMcpClients, unavailable, updateJoinRequests, type JoinRequest } from "./join.ts";
vi.mock("./api.ts", () => ({ api: vi.fn() }));
beforeEach(() => {
  vi.mocked(api).mockReset();
});
const request: JoinRequest = { id: "join-1", name: "My Mac", kind: "computer", platform: "darwin", code: "482913", createdAt: "2026-10-24" };

describe("device approval", () => {
  it("restricts the owner dialog to owners and admins", () => {
    expect(canApproveJoin("owner")).toBe(true);
    expect(canApproveJoin("admin")).toBe(true);
    for (const role of [undefined, "member", "guest"]) expect(canApproveJoin(role)).toBe(false);
  });
  it("formats six digits without losing leading zeros", () => {
    expect(displayJoinCode("482913")).toBe("482 913");
    expect(displayJoinCode("001002")).toBe("001 002");
  });
  it("queues requests, deduplicates replays, and removes a request decided in another window", () => {
    let queue = updateJoinRequests([], { type: "join_request", request });
    queue = updateJoinRequests(queue, { type: "join_request", request });
    expect(queue).toEqual([request]);
    expect(updateJoinRequests(queue, { type: "message" })).toBe(queue);
    expect(updateJoinRequests(queue, { type: "join_request", request: { ...request, code: "bad" } })).toBe(queue);
    expect(updateJoinRequests(queue, { type: "join_request_done", id: request.id })).toEqual([]);
  });
  it("gives an actionable 404 fallback", () => {
    expect(unavailable({ status: 404 }, "Invite links")).toContain("update Wisp");
    expect(unavailable(new Error("Offline"), "Invite links")).toBe("Offline");
  });
});
describe("connected apps compatibility", () => {
  it("hides the list when a Wisp doesn't support it yet", async () => {
    vi.mocked(api).mockRejectedValue({ status: 404 });
    await expect(loadMcpClients()).resolves.toBeNull();
    expect(api).toHaveBeenCalledWith("GET", "/api/mcp/clients");
  });
  it("accepts a client list and a wrapped client list", async () => {
    const clients = [{ id: "grok", name: "Grok" }];
    vi.mocked(api).mockResolvedValueOnce(clients).mockResolvedValueOnce({ clients });
    expect(await loadMcpClients()).toEqual(clients);
    expect(await loadMcpClients()).toEqual(clients);
  });
  it("surfaces failures other than an unsupported endpoint", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Offline"));
    await expect(loadMcpClients()).rejects.toThrow("Offline");
  });
});
