import { useState } from "react";
import { Monitor } from "lucide-react";
import { useStore } from "../store.ts";
import { ComputerFullscreen } from "./AgentPanel.tsx";
import { ScreenThumb } from "./Screen.tsx";
import { AgentAvatar, timeAgo } from "./ui.tsx";
import { CardButton, dismissHelp, helpKey, useHelpSeen } from "./InboxParts.tsx";
import { useWaitingOnYou } from "../store.ts";

/**
 * An agent asked you to do something on its computer (sign in, type a code): a card says who
 * and what, with a look at its screen. "Open computer" opens the screen full size, ready to
 * click into; "Not now" means later: the request stays in the chat, on Computers and in the Inbox.
 */
export function HelpPopup() {
  const { help } = useWaitingOnYou();
  const agents = useStore((s) => s.agents);
  const seen = useHelpSeen();
  const [opened, setOpened] = useState<string | null>(null);
  const c = help.find((x) => !seen.includes(helpKey(x)) || helpKey(x) === opened);
  const agent = c && agents.find((a) => a.id === c.help!.agentId);
  if (!c || !agent) return null;
  if (opened === helpKey(c)) {
    return (
      <ComputerFullscreen
        key={c.id}
        agent={agent}
        computer={c}
        onClose={() => {
          setOpened(null);
          dismissHelp(c);
        }}
      />
    );
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start md:items-center justify-center px-3.5 pt-[150px] md:pt-0" role="presentation">
      <div role="dialog" aria-modal="true" aria-label={`${agent.name} needs your help`} className="w-full max-w-[460px] rounded-xl bg-card border border-control-line shadow-panel p-5 flex flex-col gap-3.5">
        <div className="flex items-center gap-3">
          <AgentAvatar agent={agent} size={44} live />
          <div className="min-w-0 flex-1">
            <h2 className="t-title">{agent.name} needs your help</h2>
            <p className="text-sm text-faint">
              On {c.name} · {timeAgo(c.help!.at)}
            </p>
          </div>
        </div>
        {c.help!.request && <p className="rounded-xl bg-panel p-3.5 text-[15px] leading-snug">“{c.help!.request}”</p>}
        <div className="rounded-xl overflow-hidden border border-line bg-black/40 h-[120px] grid place-items-center text-sm text-faint">
          {c.online ? (
            <ScreenThumb computer={c} refreshMs={4000} className="w-full h-full object-cover" />
          ) : (
            <span className="inline-flex items-center gap-2">
              <Monitor size={20} strokeWidth={1.8} /> {c.name} screen
            </span>
          )}
        </div>
        <CardButton tone="primary" className="h-[50px] md:h-11" onClick={() => setOpened(helpKey(c))}>
          Open computer
        </CardButton>
        <CardButton tone="ghost" onClick={() => dismissHelp(c)}>
          Not now
        </CardButton>
      </div>
    </div>
  );
}
