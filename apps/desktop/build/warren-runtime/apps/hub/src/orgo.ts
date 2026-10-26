import { AGENT_SCREEN, parseKeys, toScreen, x11Combo, type ComputerAction, type OrgoConfig, type Screenshot } from "@warren/core";

/**
 * Orgo (orgo.ai) cloud computers, driven from the hub with the workspace's API key. The key
 * never leaves the hub: people watch through the hub, which relays Orgo's VNC.
 * API: https://docs.orgo.ai/api-reference/introduction
 */

export const ORGO_API = "https://www.orgo.ai/api";
const ORGO_WS = "wss://www.orgo.ai";

export class OrgoError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface OrgoComputer {
  id: string;
  name: string;
  status: string;
  instanceId: string | null;
}

type Fetch = typeof fetch;

export class OrgoClient {
  constructor(
    private apiKey: string,
    private fetchImpl: Fetch = fetch,
    private base = ORGO_API,
    private ws = ORGO_WS,
  ) {}

  async request<T = any>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 300) };
    }
    if (!res.ok) throw new OrgoError(`Orgo: ${typeof data?.error === "string" ? data.error : (data?.error?.message ?? res.statusText)}`, res.status);
    return data as T;
  }

  /** Warren keeps its computers in one Orgo workspace, made on first use. */
  async workspaceId(name = "Warren"): Promise<string> {
    const list = await this.request<{ workspaces?: { id: string; name: string }[] }>("GET", "/workspaces");
    const found = list.workspaces?.find((w) => w.name === name);
    if (found) return found.id;
    const created = await this.request<{ id: string }>("POST", "/workspaces", { name });
    return created.id;
  }

  async create(o: { name: string; ram?: number; cpu?: number; resolution?: string }): Promise<OrgoComputer> {
    const workspace_id = await this.workspaceId();
    const c = await this.request<any>("POST", "/computers", { workspace_id, name: o.name, os: "linux", ram: o.ram ?? 4, cpu: o.cpu ?? 2, resolution: o.resolution ?? "1280x800x24" }, 180_000);
    return { id: c.id, name: c.name, status: c.status, instanceId: c.instance_id ?? c.fly_instance_id ?? null };
  }

  async get(computerId: string): Promise<OrgoComputer> {
    const c = await this.request<any>("GET", `/computers/${computerId}`);
    return { id: c.id, name: c.name, status: c.status, instanceId: c.fly_instance_id ?? c.instance_id ?? null };
  }

  async vncPassword(computerId: string): Promise<string> {
    return (await this.request<{ password: string }>("GET", `/computers/${computerId}/vnc-password`)).password;
  }

  /**
   * Where the hub reaches the computer's screen over VNC (websockify), and the password for it.
   * The password is root on the computer, so it never leaves the hub: browsers watch through the
   * hub's relay, which signs in for them (see vnc-relay.ts).
   */
  async vncTarget(cfg: OrgoConfig): Promise<{ url: string; password: string }> {
    const instanceId = cfg.instanceId ?? (await this.get(cfg.computerId)).instanceId;
    if (!instanceId) throw new OrgoError("Orgo hasn't placed this computer yet; try again in a moment");
    const password = await this.vncPassword(cfg.computerId);
    return { url: `${this.ws}/desktops/${instanceId}/ws/websockify?token=${encodeURIComponent(password)}`, password };
  }

  /** Do one Warren computer action on an Orgo computer. */
  async act(cfg: OrgoConfig & { resolution?: string }, a: ComputerAction): Promise<unknown> {
    const id = cfg.computerId;
    const screen = parseResolution(cfg.resolution);
    const at = (x: number, y: number, space?: { width: number; height: number }) => toScreen(x, y, space, screen);
    switch (a.action) {
      case "screenshot": {
        const scale = Math.min(1, AGENT_SCREEN.width / screen.width, AGENT_SCREEN.height / screen.height);
        const r = await this.request<{ image: string; width?: number; height?: number }>("GET", `/computers/${id}/screenshot?response_format=base64&format=jpeg&quality=70${scale < 1 ? `&scale=${scale.toFixed(3)}` : ""}`);
        return { image: r.image, mime: "image/jpeg", width: r.width ?? Math.round(screen.width * scale), height: r.height ?? Math.round(screen.height * scale) } satisfies Screenshot;
      }
      case "click": {
        const p = at(a.x, a.y, a.space);
        await this.request("POST", `/computers/${id}/click`, { x: p.x, y: p.y, button: a.button ?? "left", double: !!a.double });
        return { ok: true };
      }
      case "move": {
        const p = at(a.x, a.y, a.space);
        await this.request("POST", `/computers/${id}/mouse-move`, { x: p.x, y: p.y });
        return { ok: true };
      }
      case "mouse": {
        // Orgo has no separate press/release; a release where it was pressed is a click
        const p = at(a.x, a.y, a.space);
        if (!a.down) await this.request("POST", `/computers/${id}/click`, { x: p.x, y: p.y, button: a.button ?? "left" });
        return { ok: true };
      }
      case "drag": {
        const [p, q] = [at(a.x, a.y, a.space), at(a.toX, a.toY, a.space)];
        await this.request("POST", `/computers/${id}/drag`, { start_x: p.x, start_y: p.y, end_x: q.x, end_y: q.y });
        return { ok: true };
      }
      case "scroll": {
        const p = at(a.x, a.y, a.space);
        if (a.direction === "left" || a.direction === "right") {
          await this.request("POST", `/computers/${id}/bash`, { command: `xdotool mousemove ${p.x} ${p.y} click --repeat ${a.amount ?? 3} ${a.direction === "left" ? 6 : 7}` });
        } else await this.request("POST", `/computers/${id}/scroll`, { x: p.x, y: p.y, direction: a.direction, amount: a.amount ?? 3 });
        return { ok: true };
      }
      case "type":
        await this.request("POST", `/computers/${id}/type`, { text: a.text }, 120_000);
        return { ok: true };
      case "key":
        await this.request("POST", `/computers/${id}/key`, { key: x11Combo(parseKeys(a.keys)) });
        return { ok: true };
      case "run": {
        const r = await this.request<{ output: string; exit_code: number }>("POST", `/computers/${id}/bash`, { command: a.command, timeout: Math.min(a.timeout ?? 120, 300) }, (Math.min(a.timeout ?? 120, 300) + 30) * 1000);
        return { exitCode: r.exit_code, output: r.output };
      }
      case "open":
        await this.request("POST", `/computers/${id}/bash`, { command: `nohup xdg-open ${shellQuote(a.target)} >/dev/null 2>&1 &` });
        return { ok: true };
      case "start":
        await this.request("POST", `/computers/${id}/start`, {}, 300_000);
        return { status: "ready", detail: "Running" };
      case "stop":
        await this.request("POST", `/computers/${id}/stop`, {}, 300_000);
        return { ok: true };
      case "destroy":
        await this.request("DELETE", `/computers/${id}`).catch((e) => {
          if ((e as OrgoError).status !== 404) throw e;
        });
        return { ok: true };
      case "status": {
        const c = await this.get(id);
        const ready = c.status === "running" || c.status === "suspended";
        return { status: ready ? "ready" : c.status === "creating" || c.status === "restarting" ? "starting" : c.status === "error" ? "error" : "stopped", detail: c.status };
      }
    }
  }
}

export function parseResolution(r: string | undefined): { width: number; height: number } {
  const m = r?.match(/^(\d+)x(\d+)/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 800 };
}

function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
