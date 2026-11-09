import type { ClientEvent } from "@wisp/core";

const TOKEN_KEY = "wisp.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown, init: { headers?: Record<string, string>; raw?: BodyInit } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  // only sign out when this token is still the one in use: switching organizations revokes the old one while requests may be in flight
  if (res.status === 401 && token && getToken() === token) {
    setToken(null);
    location.reload();
  }
  if (!res.ok) throw new ApiError(data?.error ?? res.statusText, res.status);
  return data as T;
}

export async function uploadFile(file: File, channelId?: string) {
  return api<{ id: string; name: string; size: number; mime: string }>("POST", "/api/files", undefined, {
    raw: file,
    headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(file.name), "x-mime-type": file.type || "application/octet-stream", ...(channelId ? { "x-channel-id": channelId } : {}) },
  });
}

const INLINE_TYPE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|text\/(plain|csv|markdown)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm|aac|flac|x-m4a)|application\/pdf)$/;

/** Files are fetched with the auth header, then shown via object URLs. */
/** A chat file's bytes, as the hub sent them. */
export async function fileBlob(id: string): Promise<Blob> {
  const res = await fetch(`/api/files/${id}`, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError("file unavailable", res.status);
  return res.blob();
}

export async function fileUrl(id: string): Promise<string> {
  const res = await fetch(`/api/files/${id}`, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError("file unavailable", res.status);
  // An object URL opens on Wisp's own origin, so only plain media keeps its type; anything else
  // (an uploaded HTML, SVG or XML file) becomes plain bytes that can't run as Wisp.
  const blob = await res.blob();
  return URL.createObjectURL(INLINE_TYPE.test(blob.type) ? blob : new Blob([blob], { type: "application/octet-stream" }));
}

const eventListeners = new Set<(event: ClientEvent) => void>();
/** Observe the existing live connection; calls never open a second socket. */
export function observeEvents(listener: (event: ClientEvent) => void): () => void {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}

/** Realtime events with automatic reconnect. Returns a disposer. */
/** Try the live connection again now instead of waiting for the next automatic retry (the offline banner's Retry). */
export function reconnectNow() {
  reconnect?.();
}
let reconnect: (() => void) | null = null;

export function connectEvents(onEvent: (e: ClientEvent) => void, onStatus: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 500;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // The token goes in the first frame, not the URL, so it never lands in access logs.
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => ws!.send(JSON.stringify({ type: "auth", token: getToken() }));
    ws.onmessage = (m) => {
      let e: any;
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      if (e.type === "ready") {
        delay = 500;
        onStatus(true);
      } else {
        onEvent(e);
        eventListeners.forEach((listener) => listener(e));
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (stopped) return;
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };
  reconnect = () => {
    clearTimeout(retry);
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      delay = 500;
      open();
    }
  };
  open();
  return () => {
    stopped = true;
    reconnect = null;
    clearTimeout(retry);
    ws?.close();
  };
}
