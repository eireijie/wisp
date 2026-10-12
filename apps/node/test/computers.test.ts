import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recipeTag, runArgs } from "../src/computers/docker.ts";
import { jpegSize } from "../src/computers/driver.ts";
import { xdo } from "../src/computers/x11.ts";
import { textPieces } from "../src/computers/macos.ts";
import { discoverAgents, frontmatter, hermesModel, readDiscovered } from "../src/discover.ts";

describe("VM containers", () => {
  it("keep their home in a volume, share files with the device, and expose no ports", () => {
    const args = runArgs({ id: "cmp_x", name: "Nova's Desk!", kind: "vm", config: { resolution: "1440x900", cpus: 2, memoryGb: 4 } }, { name: "warren-cmp_x", volume: "warren-cmp_x-home", files: "/n/files", image: "warren-computer:1" });
    expect(args.slice(0, 4)).toEqual(["run", "-d", "--name", "warren-cmp_x"]);
    expect(args).toEqual(expect.arrayContaining(["--hostname", "nova-s-desk", "--restart", "unless-stopped"]));
    expect(args).toEqual(expect.arrayContaining(["-e", "RESOLUTION=1440x900", "-v", "warren-cmp_x-home:/home/warren", "-v", "/n/files:/home/warren/files", "--cpus", "2", "--memory", "4g"]));
    expect(args.join(" ")).not.toMatch(/ -p /);
    expect(args.at(-1)).toBe("warren-computer:1");
    expect(runArgs({ id: "c", name: "x", kind: "vm", config: { resolution: "bad; rm -rf" } }, { name: "n", volume: "v", files: "f", image: "i" })).toContain("RESOLUTION=1280x800");
    // Apple's container has no hostname, restart policy or host alias options
    const apple = runArgs({ id: "c", name: "x", kind: "vm", config: { cpus: 1.5 } }, { name: "n", volume: "v", files: "f", image: "i", kind: "apple" });
    expect(apple).not.toContain("--hostname");
    expect(apple).not.toContain("--restart");
    expect(apple).not.toContain("--add-host");
    expect(apple).toEqual(expect.arrayContaining(["--cpus", "2"]));
  });

  it("name their image after a hash of its recipe, the same one CI publishes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warren-recipe-"));
    fs.writeFileSync(path.join(dir, "start.sh"), "b");
    fs.writeFileSync(path.join(dir, "Dockerfile"), "a");
    // sha256 of the files' contents in name order ("Dockerfile" before "start.sh"): sha256("ab")
    expect(recipeTag(dir)).toBe("fb8e20fc2e4c");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("X11 input", () => {
  it("builds xdotool commands", () => {
    expect(xdo.click(10, 20, "right", 2)).toEqual(["mousemove", "10", "20", "click", "--repeat", "2", "--delay", "80", "3"]);
    expect(xdo.scroll(5, 5, "down", 3)).toEqual(["mousemove", "5", "5", "click", "--repeat", "3", "--delay", "30", "5"]);
    expect(xdo.key({ mods: ["ctrl", "meta"], key: "Enter" })).toEqual(["key", "--clearmodifiers", "--", "ctrl+super+Return"]);
    // text after -- can't be read as an option
    expect(xdo.type("--help")).toEqual(["type", "--delay", "12", "--", "--help"]);
  });

  it("splits typed text into keystrokes and Return/Tab presses on a Mac", () => {
    expect(textPieces("a\r\nb\tc")).toEqual([{ text: "a" }, { code: 36 }, { text: "b" }, { code: 48 }, { text: "c" }]);
  });

  it("reads JPEG sizes", () => {
    const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
    expect(jpegSize(jpeg)).toEqual({ width: 1, height: 1 });
    expect(jpegSize(Buffer.from("not a jpeg"))).toBeNull();
  });
});

describe("discovering existing agents", () => {
  it("finds Hermes profiles, OpenClaw workspaces and subagents, and reads one in full on demand", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "warren-discover-"));
    const w = (p: string, t: string) => (fs.mkdirSync(path.dirname(path.join(home, p)), { recursive: true }), fs.writeFileSync(path.join(home, p), t));
    w(".hermes/SOUL.md", "# Desk Agent\nCalm.");
    w(".hermes/config.yaml", "model:\n  default: x\n");
    w(".hermes/profiles/work/SOUL.md", "Focused.");
    w(".hermes/profiles/work/memories/MEMORY.md", "- uses vim");
    w(".openclaw/workspace/SOUL.md", "Curious.");
    w(".openclaw/workspace/IDENTITY.md", "- **Name:** Clawd\n- Emoji: 🦞");
    w(".openclaw/workspace/AGENTS.md", "Check email every morning.");
    w(".openclaw/workspace/memory/2026-10-10.md", "Met Dana.");
    w(".config/opencode/agent/docs.md", "---\ndescription: Writes docs\n---\nWrite clear docs.");

    const found = discoverAgents(home);
    expect(found.map((a) => `${a.key}=${a.name}`).sort()).toEqual(["hermes:default=Desk Agent", "hermes:work=Hermes (work)", "openclaw:workspace=Clawd", "opencode:docs=docs"]);
    expect(found.find((a) => a.key === "hermes:work")).toMatchObject({ hasSoul: true, memoryCount: 1 });
    expect(found.every((a) => a.soul === undefined && a.memories === undefined)).toBe(true);

    const claw = readDiscovered("openclaw:workspace", home)!;
    expect(claw.soul).toContain("Curious.");
    expect(claw.instructions).toBe("Check email every morning.");
    expect(claw.memories).toEqual([{ name: "2026-10-10.md", content: "Met Dana." }]);
    expect(readDiscovered("nope", home)).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("finds the harness you already use, with its instructions and saved memories", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "warren-setup-"));
    const w = (p: string, t: string) => (fs.mkdirSync(path.dirname(path.join(home, p)), { recursive: true }), fs.writeFileSync(path.join(home, p), t));
    w(".claude/CLAUDE.md", "Always answer in British English.");
    w(".claude/settings.json", JSON.stringify({ model: "opus" }));
    w(".claude/projects/-Users-me-shop/memory/user-likes.md", "Likes short answers.");
    w(".codex/AGENTS.md", "Run the tests before saying it's done.");
    w(".codex/config.toml", 'model = "gpt-5.6"\n');
    const found = discoverAgents(home);
    expect(found.find((a) => a.key === "claude-code:main")).toMatchObject({ name: "Claude Code (your setup)", model: "opus", memoryCount: 1, description: "your CLAUDE.md and 1 saved memory" });
    expect(found.find((a) => a.key === "codex:main")).toMatchObject({ name: "Codex (your setup)", model: "gpt-5.6" });
    expect(readDiscovered("claude-code:main", home)).toMatchObject({ instructions: "Always answer in British English.", memories: [{ name: "Users-me-shop-user-likes.md", content: "Likes short answers." }] });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reads Hermes' model setting as its ACP model id", () => {
    expect(hermesModel("model:\n  default: gpt-5.6-luna\n  provider: openai-codex\n  base_url: ''\nother: 1\n")).toBe("openai-codex:gpt-5.6-luna");
    expect(hermesModel("model: 'claude-x'\n")).toBe("claude-x");
    expect(hermesModel("model:\n  default: m1\n")).toBe("m1");
    expect(hermesModel("nothing: here\n")).toBeUndefined();
  });

  it("reads frontmatter", () => {
    expect(frontmatter("---\nname: a\nmodel: 'opus'\n---\nbody")).toEqual({ meta: { name: "a", model: "opus" }, body: "body" });
    expect(frontmatter("no meta")).toEqual({ meta: {}, body: "no meta" });
  });
});
