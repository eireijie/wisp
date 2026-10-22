import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { useStore } from "../store.ts";
import { askAgent } from "../openDm.ts";
import { AgentAvatar, cx } from "./ui.tsx";

/**
 * "Ask an agent to change anything": a message box that sends to one of your agents in your DM
 * with it. Agents change settings and mods with settings_change, and you see what changed there.
 */
export function AskAgent({ placeholder, className }: { placeholder: string; className?: string }) {
  const agents = useStore((s) => s.agents);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const agent = agents.find((a) => a.id === agentId) ?? agents.find((a) => a.status !== "offline") ?? agents[0];
  if (!agent) return null;
  const send = async () => {
    if (!text.trim()) return;
    setError(null);
    try {
      await askAgent(agent.id, text.trim());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className={className}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex items-center gap-2 min-h-14 rounded-full border border-line bg-panel pl-2 pr-1.5 py-1.5 shadow-[var(--shadow)]"
      >
        {agents.length > 1 ? (
          <label className="relative shrink-0 size-10 grid place-items-center rounded-full hover:bg-hover cursor-pointer" title={`Ask ${agent.name}`}>
            <AgentAvatar agent={agent} size={26} badge={false} />
            <select aria-label="Which agent" className="absolute inset-0 opacity-0 cursor-pointer" value={agent.id} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="shrink-0 size-10 grid place-items-center">
            <AgentAvatar agent={agent} size={26} badge={false} />
          </span>
        )}
        <input aria-label={`Ask ${agent.name}`} className="flex-1 min-w-0 bg-transparent outline-none text-[15px] placeholder:text-muted" placeholder={placeholder.replace("{name}", agent.name)} value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" aria-label="Send" disabled={!text.trim()} className={cx("shrink-0 size-10 rounded-full grid place-items-center bg-accent text-accent-ink disabled:opacity-40")}>
          <ArrowUp size={18} />
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </div>
  );
}
