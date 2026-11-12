import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Actor, Message } from "@wisp/core";
import { api } from "../api.ts";
import { agentColor } from "../components/ui.tsx";
import { messageTaps, useStore } from "../store.ts";
import { useNameOf } from "./useTerminal.ts";

/**
 * Between agents: who sent what to whom in a team, live. Clicking a line opens the agent it's
 * about. The line at the bottom messages the team (or one agent, with an @).
 */
export function Between({ channelId, onJump }: { channelId: string; onJump: (agentId: string) => void }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [reload, setReload] = useState(0);
  const nameOf = useNameOf();
  const agents = useStore((s) => s.agents);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let gone = false;
    api<{ messages: Message[] }>("GET", `/api/channels/${channelId}/between?limit=80`).then((r) => !gone && setMessages(r.messages), () => !gone && setMessages([]));
    return () => {
      gone = true;
    };
  }, [channelId, reload]);

  useEffect(() => {
    const tap = (m: Message) => {
      if (m.channelId !== channelId) return;
      setMessages((list) => (list && !list.some((x) => x.id === m.id) ? [...list, m] : list));
    };
    messageTaps.add(tap);
    // a reconnect may have missed some
    const t = setInterval(() => setReload((n) => n + 1), 60_000);
    return () => {
      messageTaps.delete(tap);
      clearInterval(t);
    };
  }, [channelId]);

  const lines = useMemo(
    () =>
      (messages ?? [])
        .filter((m) => !m.deletedAt && m.to?.length && m.author.id !== "system" && m.body.trim())
        .map((m) => {
          const text = m.body
            .replace(/\*\*|__|`/g, "")
            .replace(/^(@[\w-]+\s*)+/, "")
            .replace(/^New task\s+/, "")
            .split("\n")
            .find((l) => l.trim()) ?? "";
          // the agent this line is about: the one who sent it, or for your message, the one it went to
          const about = m.author.kind === "agent" ? m.author.id : m.to!.find((t) => t.kind === "agent")?.id;
          return { id: m.id, from: m.author, to: m.to!, text, at: m.createdAt, about };
        })
        .slice(-60),
    [messages],
  );

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const color = (a: Actor) => (a.kind === "agent" ? agentColor(agents.find((x) => x.id === a.id)) : "#f2f2f4");
  const name = (a: Actor) => {
    const n = nameOf(a);
    return n === "you" ? "You" : n;
  };

  return (
    <aside aria-label="Between agents" className="flex w-[300px] shrink-0 flex-col border-l border-white/[.06] bg-[#0f0f11] max-lg:hidden">
      <div className="flex h-[38px] shrink-0 items-center border-b border-white/[.06] px-3.5">
        <span className="flex-1 text-[12px] font-semibold text-[#8e8e96]">Between agents</span>
        <span className="text-[11px] text-[#71717a]">live</span>
      </div>
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 py-2">
        <div className="flex-1" />
        {messages && lines.length === 0 && <div className="px-2 py-1 text-[12.5px] text-[#71717a]">Nothing yet.</div>}
        {lines.map((l) => (
          <button key={l.id} type="button" onClick={() => l.about && onJump(l.about)} className="m-code-wire flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[.045]">
            <span className="flex w-full items-center gap-1.5 text-[11.5px]">
              <span className="font-semibold" style={{ color: color(l.from) }}>
                {name(l.from)}
              </span>
              <span className="text-[#55555c]">→</span>
              <span className="min-w-0 truncate font-semibold">
                {l.to.map((t, i) => (
                  <span key={`${t.kind}:${t.id}`} style={{ color: color(t) }}>
                    {i ? ", " : ""}
                    {name(t)}
                  </span>
                ))}
              </span>
              <span className="flex-1" />
              <span className="shrink-0 text-[#71717a]">{clock(l.at)}</span>
            </span>
            <span className="line-clamp-2 text-[12.5px] leading-[1.4] text-[#d4d4d8]">{l.text}</span>
          </button>
        ))}
      </div>
      <TeamLine channelId={channelId} />
    </aside>
  );
}

function clock(at: string) {
  const d = new Date(at);
  if (Date.now() - d.getTime() < 60_000) return "now";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "");
}

function TeamLine({ channelId }: { channelId: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/channels/${channelId}/messages`, { body });
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={send} className="shrink-0 border-t border-white/[.07] px-2.5 py-2">
      <input
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        placeholder="Message the team, or @one agent"
        aria-label="Message the team"
        className="h-8 w-full rounded-[7px] border border-white/[.1] bg-transparent px-2.5 text-[12.5px] text-[#f2f2f4] outline-none transition-colors placeholder:text-[#71717a] focus:border-white/25"
      />
      {error && <div className="mt-1 text-[11.5px] text-[#ff6b6b]">{error}</div>}
    </form>
  );
}
