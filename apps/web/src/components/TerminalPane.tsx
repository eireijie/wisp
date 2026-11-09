import { useEffect, useRef, useState, type FormEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { RotateCw, X } from "lucide-react";
import { api } from "../api.ts";
import { cx } from "./ui.tsx";

/**
 * One shell, drawn with xterm.js and streamed through the hub from the computer it runs on. Leaving
 * the page keeps the shell running there (it comes back with its recent screen); closing the pane
 * ends it.
 */

export interface ShellTarget {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  /** a device's own screen asks for its code before a shell opens */
  code: "pin" | "password" | null;
}

type Status = { state: "connecting" } | { state: "live" } | { state: "code"; error?: string } | { state: "ended"; text: string } | { state: "lost"; text: string; retry: boolean };

const THEME = {
  background: "#0c0c0e",
  foreground: "#e6e6ea",
  cursor: "#f2f2f4",
  cursorAccent: "#0c0c0e",
  selectionBackground: "#3a3a44",
  black: "#1d1d21",
  brightBlack: "#6b6b75",
  red: "#ff6b6b",
  green: "#3fb950",
  yellow: "#ffb340",
  blue: "#6aa2ff",
  magenta: "#c08cff",
  cyan: "#56d4dd",
  white: "#d4d4d8",
  brightWhite: "#f2f2f4",
};

const enc = new TextEncoder();

export function TerminalPane({ target, session, onClose, focused, onFocus }: { target: ShellTarget; session: string; onClose: () => void; focused: boolean; onFocus: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const sock = useRef<WebSocket | null>(null);
  const code = useRef<string | undefined>(undefined);
  /** a shell has shown here before, so a fresh one gets a line saying so */
  const opened = useRef(false);
  const [status, setStatus] = useState<Status>({ state: "connecting" });
  const [attempt, setAttempt] = useState(0);

  // the terminal itself lives as long as the pane
  useEffect(() => {
    const t = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(holder.current!);
    term.current = t;
    const send = (data: string) => {
      const ws = sock.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(data));
    };
    const typed = t.onData(send);
    const bin = t.onBinary((data) => {
      const ws = sock.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(Uint8Array.from(data, (c) => c.charCodeAt(0)));
    });
    const sized = t.onResize(({ cols, rows }) => {
      const ws = sock.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    // text that arrives without key presses (dictation, phone keyboards, automation) carries its line
    // breaks as "insertLineBreak", which xterm drops: send them as Enter, like a pressed Return
    const area = holder.current!.querySelector("textarea");
    const lineBreaks = (e: InputEvent) => {
      const text = e.inputType === "insertLineBreak" || e.inputType === "insertParagraph" ? "\n" : e.inputType === "insertText" ? e.data ?? "" : "";
      if (!/[\r\n]/.test(text)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      t.input(text.replace(/\r?\n/g, "\r"));
    };
    area?.addEventListener("beforeinput", lineBreaks, true);
    const refit = () => {
      try {
        fit.fit();
      } catch {}
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(holder.current!);
    return () => {
      ro.disconnect();
      area?.removeEventListener("beforeinput", lineBreaks, true);
      typed.dispose();
      bin.dispose();
      sized.dispose();
      t.dispose();
      term.current = null;
    };
  }, []);

  // the connection: opened again after a drop, with a growing wait
  useEffect(() => {
    let gone = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const connect = async () => {
      const t = term.current;
      if (!t || gone) return;
      setStatus({ state: "connecting" });
      let url: string;
      try {
        ({ url } = await api<{ url: string }>("POST", `/api/computers/${target.id}/terminal`, { session, code: code.current }));
      } catch (err) {
        if (gone) return;
        const text = (err as Error).message;
        if (/PIN|password|code/i.test(text) && target.code) return setStatus({ state: "code", error: code.current ? "That code didn't work." : undefined });
        // offline: keep trying quietly; refused: say why and stop
        const offline = /offline/i.test(text);
        setStatus({ state: "lost", text, retry: offline });
        if (offline) retry = setTimeout(connect, Math.min(30_000, 2000 * 2 ** tries++));
        return;
      }
      if (gone) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}${url}&cols=${t.cols}&rows=${t.rows}`);
      ws.binaryType = "arraybuffer";
      sock.current = ws;
      let exited = false;
      let ready = false;
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) return term.current?.write(new Uint8Array(e.data));
        try {
          const msg = JSON.parse(String(e.data));
          if (msg.type === "ready") {
            ready = true;
            tries = 0;
            // a shell that was already running sends its recent screen; start clean so it isn't drawn twice
            if (msg.resumed) term.current?.reset();
            else if (opened.current) term.current?.write("\r\n\x1b[2m[a new shell: the earlier one ended]\x1b[0m\r\n");
            opened.current = true;
            setStatus({ state: "live" });
            if (focused) term.current?.focus();
          } else if (msg.type === "closed") exited = !!msg.exited;
        } catch {}
      };
      ws.onclose = (e) => {
        if (sock.current === ws) sock.current = null;
        if (gone) return;
        if (exited) return setStatus({ state: "ended", text: e.reason && e.reason !== "closed" ? e.reason : "The shell ended." });
        if (e.code === 4403 || e.code === 4401 || e.code === 4400) return setStatus({ state: "lost", text: e.reason || "This terminal can't be opened.", retry: false });
        if (/code|PIN|password/i.test(e.reason) && target.code) {
          code.current = undefined;
          return setStatus({ state: "code", error: e.reason });
        }
        // dropped (the device or the hub went away): try again; the shell is still there
        if (!ready && e.code === 4502) return setStatus({ state: "lost", text: e.reason || "The terminal couldn't start.", retry: false });
        setStatus({ state: "lost", text: e.code === 4503 ? `${target.name} is offline. Reconnecting…` : "Reconnecting…", retry: true });
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** tries++));
      };
    };
    void connect();
    return () => {
      gone = true;
      clearTimeout(retry);
      // leaving the page: the shell keeps running on the computer
      sock.current?.close();
      sock.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id, session, attempt]);

  useEffect(() => {
    if (focused && status.state === "live") term.current?.focus();
  }, [focused, status.state]);

  const close = () => {
    const ws = sock.current;
    // closing the pane ends the shell too
    // (not connected: a shell left there stops on its own once nobody has looked at it for a while)
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "end" }));
    onClose();
  };

  const submitCode = (value: string) => {
    code.current = value;
    setAttempt((n) => n + 1);
  };

  const dot = status.state === "live" ? "var(--st-online)" : status.state === "connecting" || (status.state === "lost" && status.retry) ? "var(--st-needs)" : "#6b6b75";

  return (
    <section
      onMouseDown={onFocus}
      className={cx("m-pane relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border bg-[#0c0c0e]", focused ? "border-white/20" : "border-white/[.08]")}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[.06] px-3 text-[12.5px] text-[#a1a1aa]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full transition-colors" style={{ background: dot }} />
        <span className="truncate font-medium text-[#f2f2f4]">{target.name}</span>
        <span className="truncate font-mono text-[11.5px] text-[#6b6b75]">{session}</span>
        <span className="flex-1" />
        <button type="button" onClick={close} aria-label="Close terminal" title="Close (ends the shell)" className="-mr-1.5 grid h-7 w-7 place-items-center rounded-md text-[#8e8e96] transition-colors hover:bg-white/[.06] hover:text-[#f2f2f4]">
          <X size={14} strokeWidth={2} />
        </button>
      </header>
      <div className="relative min-h-0 flex-1 px-2 pt-1.5">
        <div ref={holder} className="h-full w-full" />
        {status.state !== "live" && <Overlay status={status} target={target} onCode={submitCode} onRetry={() => setAttempt((n) => n + 1)} />}
      </div>
    </section>
  );
}

function Overlay({ status, target, onCode, onRetry }: { status: Status; target: ShellTarget; onCode: (code: string) => void; onRetry: () => void }) {
  const [value, setValue] = useState("");
  if (status.state === "live") return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value) onCode(value);
    setValue("");
  };
  return (
    <div className="absolute inset-0 grid place-items-center bg-[#0c0c0e]/85 px-6 text-center text-[12.5px] text-[#a1a1aa] m-fade-in">
      {status.state === "connecting" ? (
        <span>Connecting…</span>
      ) : status.state === "code" ? (
        <form onSubmit={submit} className="flex w-full max-w-[260px] flex-col items-center gap-2.5">
          <span className="text-[#f2f2f4]">Enter {target.name}'s {target.code === "password" ? "password" : "PIN"}</span>
          <input
            autoFocus
            type="password"
            inputMode={target.code === "pin" ? "numeric" : undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 w-full rounded-md border border-white/[.12] bg-[#1d1d21] px-2.5 text-center font-mono text-[13px] text-[#f2f2f4] outline-none focus:border-white/30"
          />
          {status.error && <span className="text-[#ff6b6b]">{status.error}</span>}
        </form>
      ) : (
        <div className="flex flex-col items-center gap-2.5">
          <span>{status.text}</span>
          {!(status.state === "lost" && status.retry) && (
            <button type="button" onClick={onRetry} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-white/[.09] bg-[#1d1d21] px-2.5 text-[#f2f2f4] transition-colors hover:bg-[#26262b] active:scale-[.97]">
              <RotateCw size={13} strokeWidth={2} />
              {status.state === "ended" ? "Start a new shell" : "Try again"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
