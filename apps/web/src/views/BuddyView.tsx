import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Phone } from "lucide-react";
import { defaultAppearance } from "@wisp/core/src/appearance.ts";
import { api, connectEvents, getToken } from "../api.ts";
import { buddyNoticeWithRoot, completedTasks, unlessMuted, type BuddyNotice, type BuddyTask } from "../buddy.ts";
import type { BuddySettings } from "../desktop.ts";
import { agentMood } from "../ghostMood.ts";
import { href } from "../router.ts";
import { useStore } from "../store.ts";
import { setMode, setTheme, setTextSize, setReduceMotion, THEMES, useMotionReduced } from "../theme.ts";
import { Ghost } from "../components/Ghost.tsx";
import { agentVar } from "../components/ui.tsx";
import "./buddy.css";

const desktop = window.wispDesktop?.buddy;

export function BuddyView() {
  const agents = useStore((s) => s.agents);
  const connected = useStore((s) => s.connected);
  const approvals = useStore((s) => s.approvals);
  const computers = useStore((s) => s.computers);
  const [settings, setSettings] = useState<BuddySettings>({ agentId: null });
  const [notice, setNotice] = useState<BuddyNotice | null>(null);
  const [hovered, setHovered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [controlsHovered, setControlsHovered] = useState(false);
  const [session, setSession] = useState(getToken);
  const reduced = useMotionReduced();
  const agent = agents.find((a) => a.id === settings.agentId) ?? agents[0];
  const selected = useRef(agent?.id);
  selected.current = agent?.id;
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const ignoring = useRef(true);

  useEffect(() => {
    document.documentElement.classList.add("desk-buddy");
    let active = true;
    const update = (s: BuddySettings) => { if (active) setSettings(s); };
    const unsubscribe = desktop?.onSettings(update);
    void desktop?.settings().then(update);
    const storage = (e: StorageEvent) => {
      if (e.key === "wisp.token" || e.key === null) setSession(getToken());
      // Setters update this renderer's theme state and notify reduced-motion subscribers.
      if (e.key === "wisp.mode" || e.key === null) {
        const v = localStorage.getItem("wisp.mode");
        setMode(v === "light" || v === "dark" ? v : "system");
      }
      if (e.key === "wisp.theme" || e.key === null) {
        const v = localStorage.getItem("wisp.theme");
        setTheme(THEMES.find((t) => t.id === v)?.id ?? "mono");
      }
      if (e.key === "wisp.textSize" || e.key === null) {
        const v = localStorage.getItem("wisp.textSize");
        setTextSize(v === "small" || v === "large" ? v : "default");
      }
      if (e.key === "wisp.motion" || e.key === null) setReduceMotion(localStorage.getItem("wisp.motion") === "reduce");
    };
    window.addEventListener("storage", storage);
    return () => {
      active = false;
      unsubscribe?.();
      window.removeEventListener("storage", storage);
      document.documentElement.classList.remove("desk-buddy");
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let disconnect: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const seen = new Set<string>();
    const tasks = new Map<string, string>();
    let fetchingTasks = false;
    let tasksDirty = false;
    const show = (n: BuddyNotice) => {
      if (stopped || seen.has(n.id)) return;
      seen.add(n.id);
      if (seen.size > 200) seen.delete(seen.values().next().value!);
      setLeaving(false);
      setNotice(n);
    };
    const refreshTasks = async () => {
      tasksDirty = true;
      if (fetchingTasks) return;
      fetchingTasks = true;
      try {
        while (tasksDirty && !stopped) {
          tasksDirty = false;
          const list = await api<BuddyTask[]>("GET", "/api/tasks");
          if (!stopped) completedTasks(list, tasks, useStore.getState().me?.user.id ?? "").forEach(show);
        }
      } catch {} finally { fetchingTasks = false; }
    };
    const start = async () => {
      if (!session || stopped) return;
      try {
        await useStore.getState().load();
        if (stopped) return;
        await refreshTasks();
        if (stopped) return;
        disconnect = connectEvents((e) => {
          if (stopped) return;
          const state = useStore.getState();
          const channels = async () => { await useStore.getState().refreshChannels(); return useStore.getState().channels; };
          void buddyNoticeWithRoot(e, state, selected.current, { ignoreMute: true }).then((next) => unlessMuted(next, e, channels)).then((next) => { if (next) show(next); });
          state.handle(e, false); // the main window owns system notifications and sounds
          // A proactive DM can be the first event for a newly-created channel.
          const channelId = e.type === "message" ? e.message.channelId : e.type === "approval" ? e.approval.channelId : null;
          if (channelId && !state.channels.some((c) => c.id === channelId)) {
            void state.refreshChannels().then(async () => {
              const found = await buddyNoticeWithRoot(e, { ...state, channels: useStore.getState().channels }, selected.current);
              if (found) show(found);
            }, () => {});
          }
          if (e.type === "tasks_changed") void refreshTasks();
        }, (online) => {
          if (stopped) return;
          useStore.getState().setConnected(online);
          if (online) {
            void useStore.getState().load().catch(() => useStore.setState({ connected: false }));
            void refreshTasks();
          }
        });
      } catch {
        if (!stopped) retry = setTimeout(start, 10_000);
      }
    };
    useStore.setState({ connected: false });
    setNotice(null);
    void start();
    return () => { stopped = true; clearTimeout(retry); disconnect?.(); };
  }, [session]);

  useEffect(() => {
    if (!notice || hovered) { setLeaving(false); return; }
    const timer = setTimeout(() => setLeaving(true), 8000);
    return () => clearTimeout(timer);
  }, [notice, hovered]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => { setNotice(null); setLeaving(false); }, reduced ? 0 : 200);
    return () => clearTimeout(timer);
  }, [leaving, notice, reduced]);
  const expanded = !!notice && connected;
  useEffect(() => {
    desktop?.expand(expanded);
    if (!expanded) setHovered(false);
  }, [expanded]);

  // Electron forwards mousemove while ignoring clicks. SVG painted areas alone are targets;
  // the transparent padding around the ghost remains usable by windows underneath.
  useEffect(() => {
    let hideControls: ReturnType<typeof setTimeout> | undefined;
    const ignore = (value: boolean) => {
      if (ignoring.current === value) return;
      ignoring.current = value;
      desktop?.ignoreMouse(value);
    };
    const hit = (target: Element | null) => {
      ignore(!target?.closest("[data-buddy-hit]"));
      setHovered(!!target?.closest(".buddy-bubble") || !!document.activeElement?.closest(".buddy-bubble"));
      if (target?.closest("[data-buddy-hit]")) {
        clearTimeout(hideControls); hideControls = undefined;
        setControlsHovered(true);
      } else if (!hideControls) {
        hideControls = setTimeout(() => { setControlsHovered(false); hideControls = undefined; }, 180);
      }
    };
    const move = (e: MouseEvent) => {
      if (drag.current) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      hit(target);
    };
    const leave = () => { if (!drag.current) hit(null); };
    const unsubscribe = desktop?.onPointer((p) => {
      if (drag.current) return;
      const target = p ? document.elementFromPoint(p.x, p.y) : null;
      hit(target);
    });
    window.addEventListener("mousemove", move, { passive: true });
    document.documentElement.addEventListener("mouseleave", leave);
    return () => {
      clearTimeout(hideControls);
      window.removeEventListener("mousemove", move);
      document.documentElement.removeEventListener("mouseleave", leave);
      unsubscribe?.();
      desktop?.ignoreMouse(true);
      desktop?.drag("end");
    };
  }, []);

  const startDrag = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    dragged.current = false;
    drag.current = { x: e.screenX, y: e.screenY, moved: false };
    (e.target as Element).setPointerCapture(e.pointerId);
    desktop?.drag("start");
  };
  const moveDrag = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    if (Math.hypot(e.screenX - d.x, e.screenY - d.y) > 5) d.moved = true;
    if (d.moved) desktop?.drag("move");
  };
  const endDrag = () => {
    dragged.current = !!drag.current?.moved;
    drag.current = null;
    desktop?.drag("end");
  };
  const open = async () => {
    const dm = useStore.getState().channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agent?.id}`));
    let route = notice?.route ?? (dm ? href({ view: "chat", channelId: dm.id, threadId: null }) : href({ view: "agents", agentId: agent?.id ?? null }));
    if (!notice && !dm && agent && connected) {
      try {
        const channel = await api<{ id: string }>("POST", `/api/dm/${agent.id}`);
        route = href({ view: "chat", channelId: channel.id, threadId: null });
      } catch {} // still open the agent when its hub is unavailable
    }
    desktop?.open(route);
    setLeaving(true);
  };
  const startCall = async () => {
    if (!agent || !connected) return;
    try {
      const channel = await api<{ id: string }>("POST", `/api/dm/${agent.id}`);
      desktop?.open(href({ view: "chat", channelId: channel.id, threadId: null, call: true }));
    } catch { setLeaving(false); setNotice({ id: "call-error", agentId: agent.id, text: "Couldn't start a call. Open our chat to try again.", mood: "waiting", route: href({ view: "agents", agentId: agent.id }) }); }
  };
  const mood = !connected ? "asleep" : notice?.mood ?? agentMood(agent, approvals, computers);
  const author = agents.find((a) => a.id === notice?.agentId);

  return (
    <div className="buddy-stage" data-raised={expanded && !reduced ? "true" : undefined} data-controls={controlsHovered ? "true" : undefined}>
      {expanded && (
        <div key={notice.id} data-buddy-hit role="group" aria-label={`${author?.name ?? "An agent"} says`} className="buddy-bubble" data-leaving={leaving ? "true" : undefined} style={agentVar(author)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setHovered(true)} onBlur={() => setHovered(false)}>
          <span className="buddy-bubble-heading"><span className="buddy-author agent-ink">{author?.name ?? "An agent"}</span></span>
          <span className="buddy-message" role="status">{notice.text}</span>
          <span className="buddy-chips">
            <button type="button" className={notice.mood === "waiting" ? "buddy-chip" : "buddy-chip on"} onClick={open}>Open chat</button>
            {author && <button type="button" className="buddy-chip" onClick={startCall}><Phone size={13} /> Call</button>}
            {notice.mood === "waiting" && <button type="button" className="buddy-chip on" onClick={open}>Review</button>}
          </span>
        </div>
      )}
      {agent && connected && <button data-buddy-hit className="buddy-call" aria-label={`Call ${agent.name}`} title={`Call ${agent.name}`} onClick={startCall}><Phone size={16} /></button>}
      <button
        data-buddy-hit
        className="buddy-ghost"
        aria-label={`Open ${agent?.name ?? "Wisp"}${connected ? "" : " (hub offline)"}`}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={() => { endDrag(); dragged.current = true; }}
        onLostPointerCapture={() => { if (drag.current) endDrag(); }}
        onClickCapture={(e) => { if (dragged.current) { e.preventDefault(); e.stopPropagation(); dragged.current = false; } }}
        onClick={open}
      >
        <Ghost look={agent?.settings.appearance ?? defaultAppearance(agent?.handle ?? "buddy")} size={116} mood={mood} interactive ambient={connected && (mood === "working" || expanded || hovered)} label={agent?.name ?? "Desk buddy"} />
      </button>
    </div>
  );
}
