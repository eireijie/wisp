import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Agent } from "@warren/core";
import { defaultAppearance } from "@warren/core/src/appearance.ts";
import { useStore } from "../store.ts";
import { motionReduced, useMotionReduced, useRoamingPets } from "../theme.ts";
import { useGhostActivity } from "../ghostActivity.ts";
import { agentMood } from "../ghostMood.ts";
import { ghostPointer, refreshGhostGaze, retainGhostPointer } from "../ghostGaze.ts";
import { boundPet, petBounds, petLoop, petTarget, type PetPoint } from "../ghostRoam.ts";
import { openDm } from "../openDm.ts";
import { Ghost, type GhostMood } from "./Ghost.tsx";
import { cx } from "./ui.tsx";

type PetState = "drift" | "rest" | "curious" | "shy" | "nap";

/** A pet lives inside its own bounded strip or message gutter. */
export function RoamingPet(props: { agent: Agent; size?: number; animate?: boolean; live?: boolean; className?: string }) {
  const enabled = useRoamingPets();
  return enabled ? <Pet key={props.agent.id} {...props} /> : null;
}

function Pet({ agent, size = 44, animate = true, live = true, className }: { agent: Agent; size?: number; animate?: boolean; live?: boolean; className?: string }) {
  const reduced = useMotionReduced();
  const animated = animate && !reduced;
  const activity = useGhostActivity(animated);
  const baseMood = useStore((s) => live ? agentMood(agent, s.approvals, s.computers) : "awake");
  const previous = useRef(agent.status);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const opening = useRef(false);
  const layer = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLButtonElement>(null);
  const position = useRef<PetPoint | null>(null);
  useEffect(() => {
    const finished = live && baseMood === "awake" && previous.current === "busy" && agent.status === "online";
    previous.current = agent.status;
    setDone(finished);
    if (!finished) return;
    const timer = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(timer);
  }, [agent.status, baseMood, live]);
  const mood: GhostMood = done && baseMood === "awake" ? "done" : baseMood;

  useLayoutEffect(() => {
    const area = layer.current, pet = wrapper.current;
    if (!area || !pet) return;
    let bounds = petBounds(area.clientWidth, area.clientHeight, size);
    let point = boundPet(position.current ?? { x: bounds.maxX, y: bounds.maxY }, bounds);
    let target = petTarget(bounds);
    let state: PetState = "rest";
    let restUntil = performance.now() + 2000 + Math.random() * 4000;
    let shyUntil = 0;
    let returnTo = point;
    let returning = false;
    let speed = 0;
    let facing = 1;
    let frame = 0;
    let last = 0;
    let cheerTime = 0;
    let painted = "";
    const cheerStart = point;
    const idle = activity === "idle";
    const parked = !animated || ["working", "asleep", "error", "thinking"].includes(mood);

    const paint = () => {
      position.current = point;
      const transform = `translate(${point.x}px, ${point.y}px) scaleX(${facing})`;
      if (transform === painted) return;
      painted = transform;
      pet.style.transform = transform;
      pet.dataset.petFacing = String(facing);
      refreshGhostGaze();
    };
    const park = () => {
      point = { x: bounds.maxX, y: bounds.maxY };
      facing = 1;
      paint();
    };
    const start = () => {
      if (!frame && !document.hidden && animated && !motionReduced()) frame = requestAnimationFrame(tick);
    };
    const tick = (now: number) => {
      frame = 0;
      if (document.hidden) return;
      if (motionReduced()) { park(); return; }
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      if (parked) return;
      if (mood === "done" && !idle && cheerTime < 1.4) {
        cheerTime += dt;
        point = petLoop(cheerStart, bounds, Math.min(1, cheerTime / 1.4));
        paint();
        start();
        return;
      }
      if (mood === "waiting") target = { x: bounds.maxX, y: bounds.minY };
      else if (idle) { state = "nap"; target = { x: bounds.maxX, y: bounds.maxY }; }
      else {
        const pointer = ghostPointer();
        const box = area.getBoundingClientRect();
        const px = pointer.x - box.left, py = pointer.y - box.top;
        const dx = point.x + size / 2 - px, dy = point.y + size / 2 - py;
        const distance = Math.hypot(dx, dy);
        const velocity = Math.hypot(pointer.vx, pointer.vy);
        const approaching = (pointer.vx * dx + pointer.vy * dy) / Math.max(1, velocity * distance);
        if (pointer.active && !pointer.touch && now - pointer.at < 100 && now > shyUntil && distance < 160 && velocity > 550 && approaching > 0.85) {
          returnTo = point;
          state = "shy";
          shyUntil = now + 2500;
          target = boundPet({ x: point.x + dx / Math.max(1, distance) * 65, y: point.y + dy / Math.max(1, distance) * 65 }, bounds);
        } else if (state !== "shy" && !returning && pointer.active && !pointer.touch && distance < 140 && now - pointer.stillSince > 1000) {
          state = "curious";
          target = boundPet({ x: px - size / 2 + (distance ? dx / distance : 1) * 40, y: py - size / 2 + (distance ? dy / distance : 0) * 40 }, bounds);
        } else if (state === "curious") {
          state = "rest";
          restUntil = now + 2000;
        }
        if (state === "rest" && now >= restUntil) { state = "drift"; target = petTarget(bounds); }
      }
      if (state !== "rest" || idle || mood === "waiting") {
        const dx = target.x - point.x, dy = target.y - point.y;
        const distance = Math.hypot(dx, dy);
        speed += ((state === "shy" ? 130 : Math.min(34, distance * 2 + 4)) - speed) * Math.min(1, dt * 5);
        const step = Math.min(distance, speed * dt);
        if (Math.abs(dx) > 1) facing = dx < 0 ? -1 : 1;
        if (distance > 0) point = boundPet({ x: point.x + dx / distance * step, y: point.y + dy / distance * step }, bounds);
        if (distance < 0.5) {
          point = target;
          speed = 0;
          if (state === "nap" || mood === "waiting") {
            paint();
            return;
          }
          if (state === "shy") { state = "drift"; returning = true; target = boundPet(returnTo, bounds); }
          else if (state === "drift") { state = "rest"; returning = false; restUntil = now + 2000 + Math.random() * 4000; }
        }
      }
      paint();
      start();
    };
    const resize = () => {
      bounds = petBounds(area.clientWidth, area.clientHeight, size);
      point = boundPet(point, bounds);
      target = boundPet(target, bounds);
      if (parked) park();
      else { paint(); start(); }
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      if (!document.hidden && !parked) start();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(area);
    if (parked) park();
    else { paint(); start(); }
    const release = animated && !parked ? retainGhostPointer() : undefined;
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      release?.();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [agent.id, size, animated, mood, activity]);

  const open = async () => {
    if (opening.current) return;
    opening.current = true;
    setError("");
    try { await openDm(agent.id); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not open chat"); }
    finally { opening.current = false; }
  };
  return (
    <div ref={layer} className={cx("absolute inset-y-0 right-0 pointer-events-none overflow-hidden", className ?? "left-0")}>
      <button ref={wrapper} type="button" className="absolute left-0 top-0 grid place-items-center pointer-events-auto rounded-full focus-visible:outline-2 focus-visible:outline-accent" style={{ width: size, height: size }}
        aria-label={`${agent.name}'s pet. Double-click to open chat.`} title={error || `${agent.name} · Double-click to chat`}
        onDoubleClick={() => void open()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void open(); } }}>
        <Ghost look={agent.settings?.appearance ?? defaultAppearance(agent.handle ?? agent.name)} size={size} mood={mood} animate={animated} ambient={live} interactive label={agent.name} />
      </button>
      {error && <span role="status" className="absolute bottom-0 right-2 text-[10px] text-danger">{error}</span>}
    </div>
  );
}
