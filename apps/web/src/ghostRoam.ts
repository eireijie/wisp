import type { Agent, Message } from "@warren/core";
import type { ChannelInfo } from "./store.ts";

export type PetPoint = { x: number; y: number };
export type PetBounds = { minX: number; maxX: number; minY: number; maxY: number };

/** Leave room for the SVG's float, decorations and the container's scrollbar. */
export function petBounds(width: number, height: number, size: number): PetBounds {
  const minX = Math.min(12, Math.max(0, (width - size) / 2));
  const minY = Math.min(8, Math.max(0, (height - size) / 2));
  return { minX, minY, maxX: Math.max(minX, width - size - 16), maxY: Math.max(minY, height - size - 8) };
}

export function boundPet(point: PetPoint, bounds: PetBounds): PetPoint {
  return { x: Math.max(bounds.minX, Math.min(bounds.maxX, point.x)), y: Math.max(bounds.minY, Math.min(bounds.maxY, point.y)) };
}

export function petTarget(bounds: PetBounds, random = Math.random): PetPoint {
  return { x: bounds.minX + random() * (bounds.maxX - bounds.minX), y: bounds.minY + random() * (bounds.maxY - bounds.minY) };
}

/** Enter a small circle, complete it, then return without clipping at the edges. */
export function petLoop(start: PetPoint, bounds: PetBounds, progress: number): PetPoint {
  const radius = Math.min(16, (bounds.maxX - bounds.minX) / 2, (bounds.maxY - bounds.minY) / 2);
  const center = {
    x: Math.max(bounds.minX + radius, Math.min(bounds.maxX - radius, start.x - radius)),
    y: Math.max(bounds.minY + radius, Math.min(bounds.maxY - radius, start.y - radius)),
  };
  const entry = { x: center.x + radius, y: center.y };
  if (progress < 0.15 || progress > 0.85) {
    const t = Math.max(0, Math.min(1, progress < 0.15 ? progress / 0.15 : (1 - progress) / 0.15));
    const eased = t * t * (3 - 2 * t);
    return boundPet({ x: start.x + (entry.x - start.x) * eased, y: start.y + (entry.y - start.y) * eased }, bounds);
  }
  const angle = (progress - 0.15) / 0.7 * Math.PI * 2;
  return boundPet({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }, bounds);
}

export function sidebarPet(agents: Agent[], channels: ChannelInfo[], active: string | null) {
  const dms = channels.filter((c) => c.kind === "dm" && (c.lastReadAt || c.id === active))
    .sort((a, b) => Number(b.id === active) - Number(a.id === active) || (b.lastReadAt ?? "").localeCompare(a.lastReadAt ?? ""));
  for (const dm of dms) {
    const agent = agents.find((a) => dm.name.endsWith(`:${a.id}`));
    if (agent) return agent;
  }
  return agents.find((a) => a.status === "online") ?? agents[0];
}

export function chatPet(agents: Agent[], channel: Pick<ChannelInfo, "kind" | "name">, messages: Message[] = []) {
  if (channel.kind === "dm") return agents.find((a) => channel.name.endsWith(`:${a.id}`));
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.author.kind !== "agent") continue;
    const agent = agents.find((a) => a.id === message.author.id);
    if (agent) return agent;
  }
}
