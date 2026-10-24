import type { ClientEvent, Message } from "@warren/core";

const computerTool = (name: string) => /(?:^|[_./:-])(?:computer|browser)(?:_|$)/.test(name);

/** Guests keep the conversation, without computer cards or screen-bearing tool payloads. */
export function guestMessage<T extends Message>(message: T): T {
  return { ...message, parts: message.parts.filter((p) => p.type !== "computer" && !(p.type === "tool_call" && computerTool(p.name))) };
}

export function guestEvent(event: ClientEvent): ClientEvent | null {
  if (event.type === "computer" || event.type === "computer_removed") return null;
  if (event.type === "message" || event.type === "message_updated") return { ...event, message: guestMessage(event.message) };
  if (event.type === "run_event" && (event.event.type === "tool_call" || event.event.type === "tool_result") && computerTool(event.event.name)) return null;
  return event;
}
