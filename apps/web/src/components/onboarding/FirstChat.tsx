import { useState } from "react";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { Bell, ChevronRight } from "lucide-react";
import type { Agent } from "@wisp/core";
import { enableNotifications, permission } from "../../notifications.ts";
import { enablePush, pushSupported } from "../../push.ts";
import { go } from "../../router.ts";

/**
 * The extras in a new agent's first chat (onboarding page 6): a card that explains notifications
 * before the system asks, and a pill to "Here's your Wisp" (page 7). Both only while the setup the
 * hello started is fresh, and only in that chat.
 */

/** What you can answer its hello with in one tap. */
const QUICK = ["Sounds good, start there", "Something else first", "What can you do?"];

const ASKED_KEY = (workspaceId: string) => `wisp.notifyAsked.${workspaceId}`;
export const hereSeenKey = (agentId: string) => `wisp.hereSeen.${agentId}`;
const FRESH_MS = 7 * 86_400_000;

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string) => {
  try {
    localStorage.setItem(k, "1");
  } catch {}
};

/** Is this the chat the agent's hello started, and has the hello been said? */
export function isFirstChat(agent: Pick<Agent, "settings"> | undefined, channelId: string): boolean {
  const s = agent?.settings.setup;
  return !!s && s.channelId === channelId && !!s.greetingId && Date.now() - Date.parse(s.startedAt) < FRESH_MS;
}

export function FirstChatExtras({ agent, channelId, workspaceId }: { agent: Agent | undefined; channelId: string; workspaceId: string }) {
  const [asked, setAsked] = useState(() => !!read(ASKED_KEY(workspaceId)) || permission() !== "default");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  // quick replies, until you've said something yourself
  const youSpoke = useStore((s) => (s.messages[channelId] ?? []).some((m) => m.author.kind === "user"));
  if (!agent || !isFirstChat(agent, channelId)) return null;
  const quick = !sent && !youSpoke ? QUICK : [];
  const reply = (text: string) => {
    setSent(true);
    void api("POST", `/api/channels/${channelId}/messages`, { body: text }).catch(() => setSent(false));
  };
  const seen = !!read(hereSeenKey(agent.id));
  const close = () => {
    write(ASKED_KEY(workspaceId));
    setAsked(true);
  };
  const turnOn = async () => {
    setBusy(true);
    try {
      const p = await enableNotifications();
      if (p === "granted" && pushSupported()) await enablePush().catch(() => undefined);
    } finally {
      setBusy(false);
      close();
    }
  };
  if (asked && seen && !quick.length) return null;
  return (
    <div className="shrink-0 w-full max-w-3xl mx-auto px-3 md:px-5 flex flex-col gap-2 pb-2">
      {!!quick.length && (
        <div className="flex flex-wrap gap-1.5 justify-end" role="group" aria-label="Quick replies">
          {quick.map((q, i) => (
            <button key={q} type="button" onClick={() => reply(q)} className="first-chat-pop h-8 rounded-full border border-line2 bg-panel px-3.5 text-[13px] text-ink hover:bg-hover transition-transform active:scale-[.97]" style={{ animationDelay: `${600 + i * 60}ms` }}>
              {q}
            </button>
          ))}
        </div>
      )}
      {!asked && (
        <section style={{ animationDelay: "900ms" }} className="first-chat-pop flex items-start gap-3 rounded-[18px] border border-line bg-card px-3.5 py-3" aria-label="Notifications">
          <Bell size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink">Want a ping when I'm done?</div>
            <div className="mt-0.5 text-[13px] leading-5 text-muted">
              I'll only message you when something's finished or I need a yes. {window.wispDesktop ? "Your Mac will ask next." : "Your browser will ask next."}
            </div>
            <div className="mt-2.5 flex gap-2">
              <button type="button" disabled={busy} onClick={turnOn} className="h-8 rounded-full bg-ink px-3.5 text-[13px] text-panel transition-transform active:scale-[.97] disabled:opacity-60">
                Turn on
              </button>
              <button type="button" onClick={close} className="h-8 rounded-full border border-line2 px-3.5 text-[13px] text-ink hover:bg-hover transition-transform active:scale-[.97]">
                Not now
              </button>
            </div>
          </div>
        </section>
      )}
      {!seen && (
        <button
          type="button"
          onClick={() => go({ view: "here", agentId: agent.id })}
          className="first-chat-pop self-center inline-flex h-8 items-center gap-1 rounded-full border border-line bg-panel px-3.5 text-[13px] text-ink shadow-[var(--shadow)] hover:bg-hover transition-transform active:scale-[.97]"
        >
          See what I set up for you
          <ChevronRight size={14} strokeWidth={1.8} aria-hidden />
        </button>
      )}
      <style>{`@keyframes first-chat-pop{0%{opacity:0;transform:translateY(16px)}100%{opacity:1;transform:none}}.first-chat-pop{animation:first-chat-pop .45s cubic-bezier(.22,1,.36,1) both}@media (prefers-reduced-motion: reduce){.first-chat-pop{animation:none}}`}</style>
    </div>
  );
}
