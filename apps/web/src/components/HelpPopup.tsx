import { useState } from "react";
import { useStore, useWaitingOnYou } from "../store.ts";
import { ComputerFullscreen } from "./AgentPanel.tsx";

const KEY = "wisp.helpSeen";

function seen(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

/**
 * An agent asked you to do something on its computer (sign in, type a code): its screen opens
 * right away, ready to click into, instead of only a line in the chat. Closing it means "later";
 * the request stays in the chat and on Computers until it's handled.
 */
export function HelpPopup() {
  const { help } = useWaitingOnYou();
  const agents = useStore((s) => s.agents);
  const [closed, setClosed] = useState(seen);
  const c = help.find((x) => !closed.includes(`${x.id}:${x.help!.at}`));
  const agent = c && agents.find((a) => a.id === c.help!.agentId);
  if (!c || !agent) return null;
  const close = () => {
    const next = [...closed, `${c.id}:${c.help!.at}`].slice(-50);
    setClosed(next);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {}
  };
  return <ComputerFullscreen key={c.id} agent={agent} computer={c} onClose={close} />;
}
