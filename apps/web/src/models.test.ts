import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import { useStore } from "./store.ts";
import { connectionModels, forgetConnectionModels, harnessSwitch } from "./models.ts";

vi.mock("./api.ts", () => ({ api: vi.fn() }));
vi.mock("./notifications.ts", () => ({ notifyOn: vi.fn() }));
vi.mock("./components/ui.tsx", () => ({ agentColor: () => "" }));
vi.mock("./orgs.ts", () => ({ listOrgs: async () => [] }));

const opus = { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "medium", "high", "max"] };
const agent = (model: string | null, effort: string | null, connectionId: string | null = "mc1") => ({ model, settings: { effort, connectionId } });

describe("harnessSwitch", () => {
  it("keeps model and effort when the new harness runs them on the connection", () => {
    expect(harnessSwitch("hermes", agent(opus.id, "high"), true, { models: [opus], efforts: ["low", "high"] })).toEqual({ harness: "hermes" });
  });

  it("drops a model the new harness doesn't list for the connection, and an effort it lacks", () => {
    expect(harnessSwitch("hermes", agent("gpt-6", "xhigh"), true, { models: [opus], efforts: ["low", "high"] })).toEqual({ harness: "hermes", model: null, settings: { effort: null } });
  });

  it("drops an effort the kept model doesn't offer (Codex's xhigh into Claude Code)", () => {
    expect(harnessSwitch("claude-code", agent(opus.id, "xhigh"), true, { models: [opus], efforts: ["xhigh"] })).toEqual({ harness: "claude-code", settings: { effort: null } });
  });

  it("checks the default model's effort against the harness's levels", () => {
    expect(harnessSwitch("claude-code", agent(null, "xhigh"), true, { models: [opus], efforts: ["low", "high"] })).toEqual({ harness: "claude-code", settings: { effort: null } });
    expect(harnessSwitch("claude-code", agent(null, "high"), true, { models: [opus], efforts: ["low", "high"] })).toEqual({ harness: "claude-code" });
  });

  it("goes back to the computer's own sign-in when the harness can't use the connection", () => {
    expect(harnessSwitch("codex", agent(opus.id, "high"), false, null)).toEqual({ harness: "codex", model: null, settings: { effort: null, connectionId: null } });
    expect(harnessSwitch("codex", agent("sonnet", "high", null), false, null)).toEqual({ harness: "codex", model: null, settings: { effort: null } });
  });
});

describe("connectionModels", () => {
  beforeEach(() => {
    forgetConnectionModels();
    vi.mocked(api).mockReset();
  });

  it("caches a list", async () => {
    vi.mocked(api).mockResolvedValue({ models: [opus], efforts: [] });
    await connectionModels("mc1", "hermes");
    await connectionModels("mc1", "hermes");
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("doesn't keep an empty list", async () => {
    vi.mocked(api).mockResolvedValueOnce({ models: [] }).mockResolvedValueOnce({ models: [opus] });
    expect(await connectionModels("mc1", "hermes")).toEqual([]);
    expect(await connectionModels("mc1", "hermes")).toEqual([opus]);
  });

  it("asks again when connections change", async () => {
    vi.mocked(api).mockResolvedValue({ models: [opus] });
    await connectionModels("mc1", "hermes");
    useStore.setState((s) => ({ modelsVersion: s.modelsVersion + 1 }));
    await connectionModels("mc1", "hermes");
    expect(api).toHaveBeenCalledTimes(2);
  });
});
