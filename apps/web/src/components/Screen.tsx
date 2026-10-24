import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { KeyRound, Loader2, MonitorOff, RefreshCw, Sparkle } from "lucide-react";
import type { ComputerAction, RecordedStep } from "@wisp/core";
import { ApiError, api, getToken } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { cx } from "./ui.tsx";
import { CodePrompt, screenCode } from "./ScreenCode.tsx";

/** The screen as a still image that refreshes while it's on screen (cards, chat, lists). */
export function ScreenThumb({ computer, refreshMs = 4000, className }: { computer: ComputerInfo; refreshMs?: number; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setUrl(null);
    setFailed(false);
    if (!computer.online) return;
    let alive = true;
    let current: string | null = null;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    if (box.current) io.observe(box.current);
    const load = async () => {
      if (!visible || document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/computers/${computer.id}/screen?maxAge=${refreshMs}`, { headers: { authorization: `Bearer ${getToken()}` } });
        if (!res.ok) throw new Error(String(res.status));
        const next = URL.createObjectURL(await res.blob());
        if (!alive) return URL.revokeObjectURL(next);
        if (current) URL.revokeObjectURL(current);
        current = next;
        setUrl(next);
        setFailed(false);
      } catch {
        if (alive) {
          if (current) URL.revokeObjectURL(current);
          current = null;
          setUrl(null);
          setFailed(true);
        }
      }
    };
    load();
    const t = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(t);
      io.disconnect();
      if (current) URL.revokeObjectURL(current);
    };
  }, [computer.id, computer.online, refreshMs]);

  return (
    <div ref={box} className={cx("relative aspect-[16/10] overflow-hidden rounded-xl bg-[#1f1d1b] grid place-items-center", className)}>
      {url && computer.online && !computer.paused ? (
        <img src={url} alt={`${computer.name}'s screen`} className="absolute inset-0 size-full object-cover object-top" />
      ) : (
        <span className="text-xs text-white/50 flex items-center gap-1.5">
          {!computer.online ? (
            <>
              <MonitorOff size={14} /> Offline
            </>
          ) : computer.paused ? (
            <>
              <MonitorOff size={14} /> Paused at the device
            </>
          ) : failed ? (
            computer.code ? (
              <>
                <KeyRound size={14} /> Opens with its {computer.code === "pin" ? "PIN" : "password"}
              </>
            ) : (
              "Screen unavailable"
            )
          ) : (
            <Loader2 size={14} className="animate-spin" />
          )}
        </span>
      )}
    </div>
  );
}

/** What a person did on the screen, in screen pixels, while teaching. */
export type ScreenInput = Omit<RecordedStep, "at" | "imageFileId">;

export interface LiveScreenHandle {
  /** the screen right now as a JPEG data URL (at most 1280 wide), for recordings */
  snapshot(): string | null;
}

interface Props {
  computer: ComputerInfo;
  /** you have control: mouse and keyboard go to the computer */
  control: boolean;
  /** called for each thing you do while in control (teaching a task) */
  onInput?: (i: ScreenInput) => void;
  /** a small preview (the chat side panel): no minimum height or rounded frame of its own */
  compact?: boolean;
  /** clicking the screen while you don't have control asks for it */
  onTakeControl?: () => void;
  /** you did something while in control (so the hub knows you're still using it) */
  onActivity?: () => void;
}

/**
 * The computer's screen, live. VMs and cloud computers stream over VNC (noVNC); a device's own
 * screen streams frames through the hub. Input only goes through while you have control.
 */
export const LiveScreen = forwardRef<LiveScreenHandle, Props>(function LiveScreen({ computer, control, onInput, compact, onTakeControl, onActivity }, ref) {
  const [state, setState] = useState<"connecting" | "live" | "closed" | "error" | "code">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const holder = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const rfb = useRef<any>(null);
  const ws = useRef<WebSocket | null>(null);
  const frameSize = useRef({ width: 0, height: 0 });
  const controlRef = useRef(control);
  const inputRef = useRef(onInput);
  const activityRef = useRef(onActivity);
  controlRef.current = control;
  inputRef.current = onInput;
  activityRef.current = onActivity;
  const transport = computer.transport;

  useImperativeHandle(ref, () => ({
    snapshot() {
      const src: HTMLCanvasElement | HTMLImageElement | null = transport === "vnc" ? (holder.current?.querySelector("canvas") ?? null) : img.current;
      if (!src) return null;
      const w = src instanceof HTMLCanvasElement ? src.width : src.naturalWidth;
      const h = src instanceof HTMLCanvasElement ? src.height : src.naturalHeight;
      if (!w || !h) return null;
      const s = Math.min(1, 1280 / w);
      const c = document.createElement("canvas");
      c.width = Math.round(w * s);
      c.height = Math.round(h * s);
      c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.7);
    },
  }));

  // connect
  useEffect(() => {
    if (!computer.online || computer.paused) {
      setState("closed");
      return;
    }
    let disposed = false;
    // a screen with a code: ask for it first (once per tab), and the device checks it
    const code = computer.code ? screenCode.get(computer.id) : undefined;
    if (computer.code && !code) {
      setState("code");
      return;
    }
    setState("connecting");
    setError(null);
    (async () => {
      let view: { transport: "vnc" | "frames"; url: string; direct: boolean };
      try {
        view = await api("POST", `/api/computers/${computer.id}/view`, code ? { code } : {});
      } catch (e) {
        if (disposed) return;
        if (code && (e as ApiError).status === 403) {
          // wrong (or locked out): ask again, with what the device said
          screenCode.forget(computer.id);
          setState("code");
        } else setState("error");
        setError((e as ApiError).message);
        return;
      }
      if (disposed) return;
      const wsUrl = view.direct ? view.url : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${view.url}`;
      if (view.transport === "vnc") {
        const { default: RFB } = await import("@novnc/novnc");
        if (disposed || !holder.current) return;
        // no password here: the hub's relay signs in to the screen for us (a cloud computer's password stays on the hub)
        const r = new RFB(holder.current, wsUrl, { wsProtocols: [] });
        r.scaleViewport = true;
        r.resizeSession = false;
        r.viewOnly = !controlRef.current;
        r.qualityLevel = 6;
        r.compressionLevel = 2;
        r.background = "#1f1d1b";
        r.focusOnClick = true;
        r.addEventListener("connect", () => !disposed && setState("live"));
        r.addEventListener("disconnect", (e: any) => {
          if (disposed) return;
          setState(e.detail?.clean ? "closed" : "error");
          if (!e.detail?.clean) setError("The connection to the screen dropped.");
        });
        r.addEventListener("credentialsrequired", () => !disposed && (setState("error"), setError("The screen asked for a password Warren doesn't have.")));
        r.addEventListener("securityfailure", (e: any) => !disposed && (setState("error"), setError(`The screen refused the connection: ${e.detail?.reason ?? "security failure"}`)));
        rfb.current = r;
      } else {
        const sock = new WebSocket(wsUrl);
        ws.current = sock;
        sock.onmessage = (m) => {
          let msg: any;
          try {
            msg = JSON.parse(m.data);
          } catch {
            return;
          }
          if (msg.type === "frame" && img.current) {
            img.current.src = `data:image/jpeg;base64,${msg.image}`;
            frameSize.current = { width: msg.width, height: msg.height };
            setState("live");
          } else if (msg.type === "computer") {
            useStore.setState((s) => ({ computers: s.computers.map((c) => (c.id === msg.computer.id ? msg.computer : c)) }));
          } else if (msg.type === "error") setError(msg.message);
        };
        sock.onclose = (e) => !disposed && (setState(e.code === 1000 ? "closed" : "error"), e.code !== 1000 && setError(e.reason || "The connection to the screen dropped."));
      }
    })().catch((e) => {
      if (!disposed) (setState("error"), setError((e as ApiError).message));
    });
    return () => {
      disposed = true;
      try {
        rfb.current?.disconnect();
      } catch {}
      rfb.current = null;
      ws.current?.close();
      ws.current = null;
    };
  }, [computer.id, computer.online, computer.paused, computer.code, transport, attempt]);

  // control toggles input
  useEffect(() => {
    if (rfb.current) {
      rfb.current.viewOnly = !control;
      if (control) rfb.current.focus();
    }
    if (control && transport === "frames") img.current?.parentElement?.focus();
  }, [control, transport]);

  // what you do: sent to the computer (frames), and reported for teaching (both)
  useEffect(() => {
    const el = transport === "vnc" ? holder.current : img.current?.parentElement;
    if (!el) return;
    const frames = transport === "frames";
    /** a pointer position in the remote screen's pixels, and as a 0..1 fraction */
    const where = (e: MouseEvent) => {
      const target = frames ? img.current! : (el.querySelector("canvas") as HTMLCanvasElement | null);
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
      const w = frames ? frameSize.current.width : (target as HTMLCanvasElement).width;
      const h = frames ? frameSize.current.height : (target as HTMLCanvasElement).height;
      return { fx, fy, x: Math.round(fx * w), y: Math.round(fy * h) };
    };
    const send = (action: ComputerAction) => ws.current?.readyState === 1 && ws.current.send(JSON.stringify({ type: "input", action }));
    const unit = { width: 1, height: 1 };
    let down: { x: number; y: number; fx: number; fy: number; button: number } | null = null;
    let lastClick = 0;
    let typed = "";
    let typedTimer: ReturnType<typeof setTimeout> | null = null;
    const flushTyped = () => {
      if (!typed) return;
      if (frames) send({ action: "type", text: typed });
      inputRef.current?.({ kind: "type", text: typed });
      typed = "";
    };

    const onDown = (e: PointerEvent) => {
      if (!controlRef.current) return;
      activityRef.current?.();
      const p = where(e);
      if (p) down = { ...p, button: e.button };
      if (frames) e.preventDefault();
    };
    const onUp = (e: PointerEvent) => {
      if (!controlRef.current || !down) return;
      const p = where(e) ?? down;
      const start = down;
      down = null;
      flushTyped();
      const moved = Math.hypot(p.x - start.x, p.y - start.y) > 6;
      if (moved && start.button === 0) {
        if (frames) send({ action: "drag", x: start.fx, y: start.fy, toX: p.fx, toY: p.fy, space: unit });
        inputRef.current?.({ kind: "drag", x: start.x, y: start.y, toX: p.x, toY: p.y });
        return;
      }
      const button = start.button === 2 ? "right" : start.button === 1 ? "middle" : "left";
      const double = button === "left" && Date.now() - lastClick < 350;
      lastClick = double ? 0 : Date.now();
      if (frames) send({ action: "click", x: start.fx, y: start.fy, button, double, space: unit });
      inputRef.current?.({ kind: button === "right" ? "right_click" : double ? "double_click" : "click", x: start.x, y: start.y });
    };
    let wheelAt = 0;
    const onWheel = (e: WheelEvent) => {
      if (!controlRef.current) return;
      activityRef.current?.();
      if (frames) e.preventDefault();
      if (Date.now() - wheelAt < 120) return;
      wheelAt = Date.now();
      const p = where(e);
      if (!p) return;
      const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      const direction = vertical ? (e.deltaY > 0 ? "down" : "up") : e.deltaX > 0 ? "right" : "left";
      if (frames) send({ action: "scroll", x: p.fx, y: p.fy, direction, amount: 2, space: unit });
      inputRef.current?.({ kind: "scroll", x: p.x, y: p.y, direction });
    };
    const onKey = (e: KeyboardEvent) => {
      if (!controlRef.current) return;
      activityRef.current?.();
      if (frames) e.preventDefault();
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const combo = e.ctrlKey || e.metaKey || (e.altKey && e.key.length > 1);
      if (e.key.length === 1 && !combo) {
        typed += e.key;
        if (typedTimer) clearTimeout(typedTimer);
        typedTimer = setTimeout(flushTyped, frames ? 120 : 1500);
        return;
      }
      flushTyped();
      const name = e.key === " " ? "Space" : e.key.replace(/^Arrow/, "");
      const keys = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && name.length > 1 && "shift", e.metaKey && "cmd", name].filter(Boolean).join("+");
      if (frames) send({ action: "key", keys });
      inputRef.current?.({ kind: "key", keys });
    };
    const onMenu = (e: Event) => controlRef.current && e.preventDefault();
    el.addEventListener("pointerdown", onDown, true);
    // noVNC captures the mouse with an overlay while a button is down, so the release lands outside el
    window.addEventListener("pointerup", onUp, true);
    el.addEventListener("wheel", onWheel, { capture: true, passive: !frames });
    el.addEventListener("keydown", onKey, true);
    el.addEventListener("contextmenu", onMenu, true);
    return () => {
      flushTyped();
      if (typedTimer) clearTimeout(typedTimer);
      el.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      el.removeEventListener("wheel", onWheel, true);
      el.removeEventListener("keydown", onKey, true);
      el.removeEventListener("contextmenu", onMenu, true);
    };
  }, [transport, state]);

  return (
    <div
      className={cx("relative size-full overflow-hidden bg-[#1f1d1b] transition-shadow", !compact && "min-h-64 rounded-2xl", control && "ring-[3px] ring-info shadow-[0_0_28px_-4px_var(--info)]", !control && onTakeControl && state === "live" && "cursor-pointer")}
      onPointerDownCapture={(e) => {
        // clicking a live screen you don't control takes control; that click doesn't reach the computer
        if (control || !onTakeControl || state !== "live" || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onTakeControl();
      }}
    >
      {transport === "vnc" ? (
        <div ref={holder} className="absolute inset-0" />
      ) : (
        <div tabIndex={0} className={cx("absolute inset-0 grid place-items-center outline-none", control ? "cursor-default" : onTakeControl ? "cursor-pointer" : "cursor-not-allowed")}>
          <img ref={img} alt={`${computer.name}'s screen`} className={cx("max-w-full max-h-full select-none", state !== "live" && "invisible")} draggable={false} />
        </div>
      )}
      {state !== "live" && (
        <div className="absolute inset-0 grid place-items-center text-sm text-white/70 p-6 text-center">
          {state === "code" ? (
            <CodePrompt
              computer={computer}
              error={error}
              onSubmit={(c) => {
                screenCode.set(computer.id, c);
                setAttempt((n) => n + 1);
              }}
            />
          ) : state === "connecting" ? (
            <span className="flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" /> Connecting to {computer.name}…
            </span>
          ) : (
            <div className="space-y-3">
              <MonitorOff size={22} className="mx-auto opacity-70" />
              <p>{!computer.online ? `${computer.name} is offline.` : computer.paused ? `${computer.name} is paused at its device. Someone there can run warren node resume.` : (error ?? "Disconnected.")}</p>
              {computer.online && !computer.paused && (
                <button onClick={() => setAttempt((n) => n + 1)} className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 h-8 hover:bg-white/10">
                  <RefreshCw size={14} /> Reconnect
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {state === "live" && error && transport === "frames" && <div className="absolute bottom-3 left-3 right-3 rounded-lg bg-black/70 text-white text-xs px-3 py-2">{error}</div>}
    </div>
  );
});

/** "Working" with a sparkle, like a teammate's status. */
export function WorkingBadge({ text = "Working" }: { text?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warn/12 text-warn px-2 h-6 text-xs font-medium">
      <Sparkle size={12} className="animate-spin [animation-duration:3s]" /> {text}
    </span>
  );
}
