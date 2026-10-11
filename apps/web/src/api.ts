import type { ClientEvent } from "@warren/core";

const TOKEN_KEY = "warren.token";

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
  if (res.status === 401 && token) {
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

/** Files are fetched with the auth header, then shown via object URLs. */
export async function fileUrl(id: string): Promise<string> {
  const res = await fetch(`/api/files/${id}`, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError("file unavailable", res.status);
  return URL.createObjectURL(await res.blob());
}

/** Realtime events with automatic reconnect. Returns a disposer. */
export function connectEvents(onEvent: (e: ClientEvent) => void, onStatus: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 500;
  const open = () => {
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
      } else onEvent(e);
    };
    ws.onclose = () => {
      onStatus(false);
      if (stopped) return;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };
  open();
  return () => {
    stopped = true;
    ws?.close();
  };
}
