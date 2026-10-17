import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Approval, Computer } from "@warren/core";
import { defaultAppearance } from "@warren/core/src/appearance.ts";
import { Ghost } from "../src/components/Ghost.tsx";
import { agentMood } from "../src/ghostMood.ts";
import { activitySnapshot, subscribeActivity } from "../src/ghostActivity.ts";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("../src/theme.ts", () => ({ useMotionReduced: () => motion.reduced }));
afterEach(() => { motion.reduced = false; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("work moods", () => {
  const agent = { id: "agent", computerId: "computer", status: "busy" as const };
  const computer = { id: "computer", status: "error" } as Computer;
  const pending = { id: "approval", agentId: agent.id, status: "pending" } as Approval;

  it("shows the current work, request, or computer failure and clears resolved signals", () => {
    expect(agentMood(agent, {}, [])).toBe("working");
    expect(agentMood(agent, {}, [computer])).toBe("error");
    expect(agentMood(agent, { approval: pending }, [computer])).toBe("waiting");
    expect(agentMood(agent, { approval: { ...pending, status: "approved" } }, [{ ...computer, status: "ready" }])).toBe("working");
    expect(agentMood({ ...agent, status: "online" }, {}, [])).toBe("awake");
  });

  it("keeps offline and paused agents asleep and ignores other agents' signals", () => {
    expect(agentMood({ ...agent, status: "offline" }, { approval: pending }, [computer])).toBe("asleep");
    expect(agentMood(agent, { approval: pending }, [{ ...computer, paused: true }])).toBe("asleep");
    expect(agentMood({ ...agent, id: "other", computerId: null }, { approval: pending }, [computer])).toBe("working");
  });
});

describe("shared page activity", () => {
  it("dozes after three minutes, wakes on input, and cleans up after the last ghost", () => {
    vi.useFakeTimers();
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const first = vi.fn(), second = vi.fn();
    const stopFirst = subscribeActivity(first), stopSecond = subscribeActivity(second);
    try {
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(170_000);
      page.dispatchEvent(new Event("pointermove"));
      expect(first).not.toHaveBeenCalled();
      vi.advanceTimersByTime(179_999);
      expect(activitySnapshot()).toBe("active");
      vi.advanceTimersByTime(1);
      expect(activitySnapshot()).toBe("idle");
      expect(first).toHaveBeenCalledTimes(1);
      stopFirst();
      page.dispatchEvent(new Event("keydown"));
      expect(activitySnapshot()).toBe("waking");
      vi.advanceTimersByTime(600);
      expect(activitySnapshot()).toBe("active");
      expect(second).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(179_400);
      expect(activitySnapshot()).toBe("idle");
      page.dispatchEvent(new Event("pointerdown"));
      expect(activitySnapshot()).toBe("waking");
    } finally {
      stopFirst();
      stopSecond();
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(activitySnapshot()).toBe("active");
  });
});

describe("still ghosts", () => {
  const look = { ...defaultAppearance("ghost"), glow: true, hat: "propeller" as const };
  it.each([false, true])("disables SVG and CSS motion with reduced motion=%s", (reduced) => {
    motion.reduced = reduced;
    const html = renderToStaticMarkup(createElement(Ghost, { look, size: 80, mood: "working", interactive: true, animate: reduced }));
    expect(html).toContain('data-animate="false"');
    expect(html).not.toContain("<animate");
    expect(html).not.toMatch(/ghost-(float|bounce|spin|type|key|interactive)\b/);
  });
});

describe("soft ghost details", () => {
  const look = { ...defaultAppearance("ghost"), eyes: "dots" as const, cheeks: false, hat: "none" as const };
  const render = (size: number, mood: Parameters<typeof Ghost>[0]["mood"] = "awake") => renderToStaticMarkup(createElement(Ghost, { look, size, mood }));
  it("gives dots glossy round eyes without cluttering tiny avatars", () => {
    expect(render(40)).toContain('rx="3.9" ry="4.9"');
    expect(render(40).match(/data-ghost-shine/g)).toHaveLength(2);
    expect(render(22)).not.toContain("data-ghost-shine");
    expect(render(40)).toContain('opacity="0.18"');
    expect(render(22)).not.toContain('opacity="0.18"');
    expect(render(40, "asleep")).not.toContain('opacity="0.18"');
  });
  it("grows one-piece arms that pose with its mood, and none at tiny sizes", () => {
    expect(render(40)).toContain("ga-arm ga-awake ga-r");
    expect(render(40, "working")).toContain("ga-arm ga-working ga-l");
    expect(render(40, "working")).toContain("ga-key");
    expect(render(40, "waiting")).toContain("ga-arm ga-waiting ga-r");
    const done = render(40, "done");
    expect(done).toContain("ga-arm ga-done ga-l");
    expect(done).toContain("ga-arm ga-done ga-r");
    expect(render(22)).not.toContain("ga-arm");
  });
});
