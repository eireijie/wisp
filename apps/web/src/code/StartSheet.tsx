import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { harnessLabel } from "@wisp/core";
import { api } from "../api.ts";
import { cx } from "../components/ui.tsx";
import type { ShellTarget } from "../components/TerminalPane.tsx";
import { useStore, useTeams } from "../store.ts";
import { Mini, TeamFaces } from "./parts.tsx";
import { repoName } from "./data.ts";

/**
 * ⌘T: start something. One of your agents or a team (what you type goes to it as a message, or
 * for a team that codes in a repo, as a task on its own branch), a plain Claude Code or Codex
 * CLI, or a shell, on one of your computers.
 */

export type Started = { kind: "agent"; id: string } | { kind: "team"; id: string } | { kind: "shell"; computerId: string; launch?: string };

type Who = { kind: "agent"; id: string } | { kind: "team"; id: string } | { kind: "cli"; harness: string } | { kind: "shell" };
const key = (w: Who) => (w.kind === "cli" ? `cli:${w.harness}` : w.kind === "shell" ? "shell" : `${w.kind}:${w.id}`);

export function StartSheet({ targets, initial, onClose, onStarted }: { targets: ShellTarget[] | null; initial?: Started | null; onClose: () => void; onStarted: (s: Started) => void }) {
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const teams = useTeams();
  const [who, setWho] = useState<Who>(() => (initial?.kind === "agent" || initial?.kind === "team" ? initial : agents[0] ? { kind: "agent", id: agents[0].id } : { kind: "shell" }));
  const online = (targets ?? []).filter((t) => t.online);
  const [where, setWhere] = useState<string | null>(null);
  const [what, setWhat] = useState("");
  const [branch, setBranch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const agent = who.kind === "agent" ? agents.find((a) => a.id === who.id) : undefined;
  const team = who.kind === "team" ? teams.find((t) => t.id === who.id) : undefined;
  const plain = who.kind === "cli" || who.kind === "shell";
  const target = online.find((t) => t.id === where) ?? online.find((t) => /^this (mac|computer|pc)$/i.test(t.name)) ?? online[0];
  const coding = !!team?.repo;
  const computerName = (id: string | null) => (id ? computers.find((c) => c.id === id)?.name : undefined);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);

  const summary = useMemo(() => {
    if (agent) return `${agent.name}, ${harnessLabel(agent.harness)}${computerName(agent.computerId) ? ` on ${computerName(agent.computerId)}` : ""}. Opens its terminal.`;
    if (team) return `${team.name}${coding ? `, in ${repoName(team.repo)}` : ""}. Opens the team.`;
    if (!target) return "None of your computers is online.";
    return `${who.kind === "cli" ? harnessLabel(who.harness) : "A shell"} on ${target.name}. Opens in Shells.`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, team, coding, target, who, computers]);

  const start = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const text = what.trim();
    setBusy(true);
    setError(null);
    try {
      if (agent) {
        if (text) {
          const dm = await api<{ id: string }>("POST", `/api/dm/${agent.id}`);
          await api("POST", `/api/channels/${dm.id}/messages`, { body: text });
        }
        return onStarted({ kind: "agent", id: agent.id });
      }
      if (team) {
        if (text && coding && branch) {
          const first = text.split("\n")[0].replace(/[.!]+$/, "");
          await api("POST", "/api/tasks", { to: `team:${team.name}`, title: first.length > 80 ? `${first.slice(0, 77)}…` : first, brief: text });
        } else if (text) await api("POST", `/api/channels/${team.channelId}/messages`, { body: text });
        return onStarted({ kind: "team", id: team.id });
      }
      if (!target) return setBusy(false);
      onStarted({ kind: "shell", computerId: target.id, ...(who.kind === "cli" ? { launch: who.harness } : {}) });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const options: { who: Who; label: string; sub?: string; mark: ReactNode }[] = [
    ...agents.map((a) => ({ who: { kind: "agent" as const, id: a.id }, label: a.name, sub: harnessLabel(a.harness), mark: <Mini agent={a} size={18} /> })),
    ...teams.map((t) => ({ who: { kind: "team" as const, id: t.id }, label: t.name, sub: `${t.members.length} agents`, mark: <TeamFaces agents={t.members.map((m) => agents.find((a) => a.id === m.agentId))} size={16} ring="#16161a" /> })),
    { who: { kind: "cli", harness: "claude-code" }, label: "Plain Claude Code", mark: <Glyph color="#e8895e">✳</Glyph> },
    { who: { kind: "cli", harness: "codex" }, label: "Plain Codex", mark: <Glyph color="#a8b4ff">{">_"}</Glyph> },
    { who: { kind: "shell" }, label: "Shell", mark: <Glyph color="#a1a1aa">$</Glyph> },
  ];

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <div className="m-scrim absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="pointer-events-none absolute inset-x-4 top-[110px] flex justify-center">
      <form
        role="dialog"
        aria-label="Start an agent"
        onSubmit={start}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), void start())}
        className="m-code-sheet pointer-events-auto flex max-h-[calc(100vh-140px)] w-[600px] max-w-full flex-col gap-[18px] overflow-y-auto rounded-xl border border-white/[.1] bg-[#121215] p-5 text-[#f2f2f4] shadow-[0_30px_80px_rgba(0,0,0,.55)]"
      >
        <div className="flex items-center">
          <span className="flex-1 text-[15px] font-semibold">Start an agent</span>
          <span className="font-mono text-[11px] text-[#8e8e96]">⌘T</span>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-semibold text-[#8e8e96]">Who</span>
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => {
              const on = key(o.who) === key(who);
              return (
                <button key={key(o.who)} type="button" onClick={() => setWho(o.who)} aria-pressed={on} className={cx("flex h-[38px] items-center gap-[9px] rounded-lg border px-3 text-left transition-[background-color,border-color,transform] active:scale-[.98]", on ? "border-white/40 bg-[#1f1f24]" : "border-white/[.08] bg-[#16161a] hover:bg-[#1c1c21]")}>
                  {o.mark}
                  <span className="text-[13px]">{o.label}</span>
                  {o.sub && <span className="text-[11.5px] text-[#8e8e96]">{o.sub}</span>}
                </button>
              );
            })}
          </div>
        </div>

        {plain && (
          <div className="flex flex-col gap-2">
            <span className="text-[12px] font-semibold text-[#8e8e96]">Where</span>
            {online.length === 0 ? (
              <span className="text-[13px] text-[#a1a1aa]">None of your computers is online.</span>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {online.map((t) => {
                  const on = t.id === target?.id;
                  return (
                    <button key={t.id} type="button" onClick={() => setWhere(t.id)} aria-pressed={on} className={cx("flex h-[38px] items-center gap-[9px] rounded-lg border px-3 text-left text-[13px] transition-[background-color,border-color,transform] active:scale-[.98]", on ? "border-white/40 bg-[#1f1f24]" : "border-white/[.08] bg-[#16161a] hover:bg-[#1c1c21]")}>
                      <Glyph color="#a1a1aa">$</Glyph>
                      <span className="truncate font-medium">{t.name}</span>
                      <span className="text-[11.5px] text-[#8e8e96]">{t.kind === "device" ? "device" : "computer"}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {!plain && (
          <div className="flex flex-col gap-2">
            <label htmlFor="code-what" className="text-[12px] font-semibold text-[#8e8e96]">
              What
            </label>
            <textarea
              id="code-what"
              ref={box}
              autoFocus
              value={what}
              onChange={(e) => setWhat(e.target.value)}
              className="h-[84px] resize-none rounded-lg border border-white/[.12] bg-[#0c0c0e] px-3 py-2.5 font-mono text-[12.5px] leading-[1.55] text-[#f2f2f4] outline-none transition-colors focus:border-white/30"
            />
          </div>
        )}

        {coding && (
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
            <button type="button" onClick={() => setBranch((b) => !b)} aria-pressed={branch} aria-label="Work on its own branch" className={cx("relative h-5 w-[34px] shrink-0 rounded-[10px] transition-colors duration-200", branch ? "bg-[#3fb950]" : "bg-[#3a3a40]")}>
              <span className="absolute top-[2px] h-4 w-4 rounded-full bg-white transition-[left] duration-200" style={{ left: branch ? 16 : 2 }} />
            </button>
            <span className="flex-1">Its own branch</span>
            <span className="font-mono text-[11.5px] text-[#8e8e96]">{branch ? "new branch" : (team?.baseBranch ?? "main")}</span>
          </label>
        )}

        <div className="flex items-center gap-2 border-t border-white/[.06] pt-3.5">
          <span className="min-w-0 flex-1 truncate text-[12px] text-[#8e8e96]">{error ? <span className="text-[#ff6b6b]">{error}</span> : summary}</span>
          <button type="button" onClick={onClose} className="inline-flex h-8 items-center rounded-[7px] border border-white/[.09] bg-[#1d1d21] px-3 text-[13px] transition-[background-color,transform] hover:bg-[#26262b] active:scale-[.96]">
            Cancel
          </button>
          <button type="submit" disabled={busy || (plain && !target)} className="inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-[#f2f2f4] bg-[#f2f2f4] px-3 text-[13px] font-semibold text-[#0c0c0e] transition-[background-color,transform] hover:bg-white active:scale-[.96] disabled:opacity-40">
            Start <span className="font-mono text-[11px] opacity-60">⌘↵</span>
          </button>
        </div>
      </form>
      </div>
    </div>
  );
}

function Glyph({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-[5px] bg-white/[.06] font-mono text-[10.5px] font-bold" style={{ color }}>
      {children}
    </span>
  );
}
