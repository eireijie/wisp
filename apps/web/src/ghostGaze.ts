import { motionReduced } from "./theme.ts";

type Point = { x: number; y: number };
type Gaze = { root: HTMLElement; face: SVGGElement; body: SVGGElement; strong?: boolean };
/** sunglasses follow the eyes behind them; hats and neckwear are fixed to the body, so they need nothing here */
type Worn = { lens: SVGElement[] };
type Registered = Gaze & Worn & { pupils: SVGElement[]; shine: SVGElement[]; value: number[] };
const ghosts = new Set<Registered>();
let users = 0;
let frame = 0;
let tapTimer: ReturnType<typeof setTimeout> | undefined;
const pointer = { x: 0, y: 0, vx: 0, vy: 0, at: 0, stillSince: 0, active: false, touch: false };
let anchor: Point = { x: 0, y: 0 };
/** Where every watching ghost looks instead of the pointer: a point (the field being typed in), or away (a password). */
let focus: Point | "away" | null = null;
/** Ghosts inside [data-ghost-glance] look around on their own (small glances every 0.5–2 s) when nothing else draws their eye. */
const glances = new WeakMap<object, { target: number[]; next: number }>();
let glanceTimer: ReturnType<typeof setTimeout> | undefined;
let glanceDue = Infinity;

/** The next small glance: a little to the side, a little up or down, sometimes straight ahead. */
function nextGlance(size: number): number[] {
  if (Math.random() < 0.25) return [0, 0, 0, 0, 0];
  const dx = (Math.random() * 2 - 1) * size * 1.6;
  const dy = (Math.random() * 2 - 1) * size * 0.5;
  // a glance moves the eyes, not the whole body
  const [x, y, px, py] = gazeTarget(dx, dy, size);
  return [x * 0.6, y * 0.6, px, py, 0];
}

const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));

/** Face, pupils and a small nearby greeting, in SVG viewBox units. */
export function gazeTarget(dx: number, dy: number, size: number, strong = false) {
  const reach = strong ? 65 : 90;
  return [clamp(dx / reach, 4.5), clamp(dy / (reach * 1.4), 3), clamp(dx / (reach * 0.7), 2.2), clamp(dy / (reach * 0.7), 2.2),
    Math.hypot(dx, dy) < size * 1.5 ? clamp(dx / Math.max(size, 1) * 5, 6) : 0];
}

function paint(ghost: Registered) {
  const [x, y, px, py, tilt] = ghost.value;
  ghost.face.setAttribute("transform", `translate(${x} ${y})`);
  ghost.body.setAttribute("transform", `rotate(${tilt} 60 85)`);
  ghost.pupils.forEach((el) => el.setAttribute("transform", `translate(${px} ${py})`));
  ghost.shine.forEach((el) => el.setAttribute("transform", `translate(${-px * 0.3} ${-py * 0.3})`));
  // sunglasses cover the pupils, so they carry the pupils' movement or the eyes would look frozen
  ghost.lens.forEach((el) => el.setAttribute("transform", `translate(${px * 0.8} ${py * 0.8})`));
}

function tick() {
  frame = 0;
  const still = motionReduced() || document.hidden;
  let unsettled = false;
  for (const ghost of ghosts) {
    const box = ghost.root.getBoundingClientRect();
    const visible = box.width > 0 && box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth;
    if (!visible) {
      if (ghost.value.some((n) => n !== 0)) { ghost.value.fill(0); paint(ghost); }
      continue;
    }
    const facing = ghost.root.closest<HTMLElement>("[data-pet-facing]")?.dataset.petFacing === "-1" ? -1 : 1;
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const target = still
      ? [0, 0, 0, 0, 0]
      : focus === "away"
        ? gazeTarget(-box.width * 4 * facing, -box.height * 0.6, box.width, true)
        : focus
          ? gazeTarget((focus.x - cx) * facing, focus.y - cy, box.width, ghost.strong)
          : ghost.root.closest("[data-ghost-glance]")
            ? glanceAt(ghost, box.width)
            : pointer.active
              ? gazeTarget((pointer.x - cx) * facing, pointer.y - cy, box.width, ghost.strong)
              : [0, 0, 0, 0, 0];
    ghost.value = ghost.value.map((n, i) => {
      if (still || Math.abs(target[i] - n) < 0.015) return target[i];
      unsettled = true;
      return n + (target[i] - n) * 0.18;
    });
    paint(ghost);
  }
  if (unsettled && !still) refreshGhostGaze();
}

function glanceAt(ghost: Registered, size: number): number[] {
  const now = performance.now();
  let g = glances.get(ghost);
  if (!g || now >= g.next) {
    g = { target: nextGlance(size), next: now + 500 + Math.random() * 1500 };
    glances.set(ghost, g);
  }
  // wake up for the soonest next glance; one timer serves every glancing ghost
  // (a due time already past means its timer is gone: schedule afresh)
  if (g.next < glanceDue || glanceDue <= now) {
    clearTimeout(glanceTimer);
    glanceDue = g.next;
    glanceTimer = setTimeout(() => ((glanceDue = Infinity), refreshGhostGaze()), Math.max(16, g.next - now));
  }
  return g.target;
}

/** Roaming ghosts also invalidate gaze when their position changes. */
export function refreshGhostGaze() {
  if (!frame && ghosts.size && !document.hidden) frame = requestAnimationFrame(tick);
}

function reset() {
  clearTimeout(tapTimer);
  pointer.active = false;
  pointer.vx = pointer.vy = 0;
  refreshGhostGaze();
}

function leave(event: PointerEvent) {
  // Touch release emits pointerleave too; let its glance finish on the timer.
  if (event.pointerType !== "touch") reset();
}

function move(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  clearTimeout(tapTimer);
  const now = performance.now();
  const dt = Math.max(16, now - pointer.at) / 1000;
  pointer.vx = pointer.active ? (event.clientX - pointer.x) / dt : 0;
  pointer.vy = pointer.active ? (event.clientY - pointer.y) / dt : 0;
  if (!pointer.active || Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) > 6) {
    pointer.stillSince = now;
    anchor = { x: event.clientX, y: event.clientY };
  }
  Object.assign(pointer, { x: event.clientX, y: event.clientY, at: now, active: true, touch: false });
  refreshGhostGaze();
}

function tap(event: PointerEvent) {
  if (event.pointerType !== "touch") return;
  clearTimeout(tapTimer);
  Object.assign(pointer, { x: event.clientX, y: event.clientY, vx: 0, vy: 0, at: performance.now(), stillSince: performance.now(), active: true, touch: true });
  refreshGhostGaze();
  tapTimer = setTimeout(reset, 1200);
}

function visibility() {
  reset();
  if (document.hidden) {
    cancelAnimationFrame(frame);
    frame = 0;
    ghosts.forEach((ghost) => { ghost.value.fill(0); paint(ghost); });
  }
}

export const ghostPointer = () => pointer;

/** Make every watching ghost look at a point (the field being typed in) or away (while a password is typed); null gives the pointer back. */
export function setGazeFocus(next: Point | "away" | null) {
  focus = next;
  refreshGhostGaze();
}

/** One shared pointer source, retained by both gazing and roaming pets. */
export function retainGhostPointer() {
  if (++users === 1) {
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", tap, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", visibility);
  }
  return () => {
    if (--users) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerdown", tap);
    document.documentElement.removeEventListener("pointerleave", leave);
    window.removeEventListener("blur", reset);
    document.removeEventListener("visibilitychange", visibility);
    reset();
    cancelAnimationFrame(frame);
    frame = 0;
  };
}

export function registerGhost(gaze: Gaze) {
  const all = (sel: string) => Array.from(gaze.body.querySelectorAll<SVGElement>(sel));
  const ghost: Registered = {
    ...gaze,
    pupils: Array.from(gaze.face.querySelectorAll("[data-ghost-pupil]")),
    shine: Array.from(gaze.face.querySelectorAll("[data-ghost-shine]")),
    lens: all("[data-ghost-lens]"),
    value: [0, 0, 0, 0, 0],
  };
  ghosts.add(ghost);
  const release = retainGhostPointer();
  refreshGhostGaze();
  return () => {
    ghosts.delete(ghost);
    ghost.value.fill(0);
    paint(ghost);
    release();
  };
}
