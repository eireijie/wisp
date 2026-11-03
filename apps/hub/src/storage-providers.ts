import { baseName, parentPath, type StorageEntry } from "@wisp/core";

/**
 * The Storage mod's three ways of reaching files: WebDAV (Nextcloud, ownCloud, TrueNAS, Synology,
 * QNAP and anything else that speaks it), Google Drive and Dropbox. Each takes paths Wisp already
 * checked (see storagePath and the connection's folders) and only ever talks to its own service.
 */

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface StorageProvider {
  list(path: string): Promise<StorageEntry[]>;
  /** the file or folder, or null when there's nothing there */
  stat(path: string): Promise<StorageEntry | null>;
  read(path: string, maxBytes: number): Promise<{ data: Buffer; mime: string; name: string }>;
  /** create the file, or replace what's there */
  write(path: string, data: Buffer, mime: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** files and folders whose names hold `query`, under any of `under` */
  search(query: string, under: string[]): Promise<StorageEntry[]>;
}

type Fetch = typeof fetch;

/** Read a response body, refusing more than `max` bytes. */
async function limitedBody(res: Response, max: number): Promise<Buffer> {
  const len = Number(res.headers.get("content-length") ?? NaN);
  if (len > max) throw new StorageError(`That file is ${mb(len)}; Wisp moves at most ${mb(max)} at a time.`, 413);
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) throw new StorageError(`That file is over ${mb(max)}; Wisp moves at most ${mb(max)} at a time.`, 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const mb = (n: number) => `${Math.ceil(n / 1024 / 1024)} MB`;

const MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", xml: "application/xml",
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", mp3: "audio/mpeg", mp4: "video/mp4", mov: "video/quicktime",
};

export function mimeOf(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (ext && MIME[ext]) || "application/octet-stream";
}

/** Turn a service's error into one sentence people and agents can act on. */
async function failure(res: Response, what: string): Promise<StorageError> {
  if (res.status === 401) return new StorageError(`The server turned down Wisp's sign-in (401). Sign in again from Settings → Storage.`, 502);
  if (res.status === 403) return new StorageError(`The server says this account isn't allowed to ${what} (403).`, 403);
  if (res.status === 404) return new StorageError(`Nothing at that path.`, 404);
  if (res.status === 507) return new StorageError(`The storage is full.`, 507);
  const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
  return new StorageError(`Couldn't ${what}: the server answered ${res.status}${body ? ` (${body})` : ""}.`, 502);
}

// --- WebDAV ----------------------------------------------------------------------------------

export interface WebdavCredentials {
  username: string;
  password: string;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/><d:getcontenttype/></d:prop></d:propfind>`;

/** The <response> parts of a WebDAV multistatus, whatever prefix the server gave the DAV: namespace. */
export function parseMultistatus(xml: string): { href: string; folder: boolean; size: number | null; modified: string | null; mime: string | null; ok: boolean }[] {
  const tag = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, "i");
  const out = [];
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const body = m[1];
    const href = body.match(tag("href"))?.[1]?.trim();
    if (!href) continue;
    // a propstat whose status isn't 200 lists properties the server doesn't have
    const okStats = [...body.matchAll(/<(?:[\w-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/gi)].map((p) => p[1]).filter((p) => /\s200\s/.test(p.match(tag("status"))?.[1] ?? " 200 "));
    const props = okStats.join("");
    const text = (name: string) => decodeXml(props.match(tag(name))?.[1]?.trim() ?? "") || null;
    const type = props.match(tag("resourcetype"))?.[1] ?? "";
    const size = text("getcontentlength");
    const modified = text("getlastmodified");
    out.push({ href: decodeXml(href), folder: /<(?:[\w-]+:)?collection\b/i.test(type), size: size ? Number(size) : null, modified: modified ? new Date(modified).toISOString() : null, mime: text("getcontenttype"), ok: okStats.length > 0 });
  }
  return out;
}

const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

export class WebdavProvider implements StorageProvider {
  private base: URL;

  constructor(
    baseUrl: string,
    private creds: () => Promise<WebdavCredentials>,
    private fetchFn: Fetch,
  ) {
    this.base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  }

  /** The address of a checked path under the server's folder. */
  href(path: string): string {
    const rel = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return new URL(rel, this.base).toString();
  }

  /** The Wisp path of an href the server sent back, or null if it's outside the base. */
  private pathOf(href: string): string | null {
    let p: string;
    try {
      p = decodeURIComponent(new URL(href, this.base).pathname);
    } catch {
      return null;
    }
    const root = decodeURIComponent(this.base.pathname);
    if (!(p + "/").startsWith(root)) return null;
    const rest = p.slice(root.length).replace(/\/+$/, "");
    return `/${rest}`.replace(/\/+/g, "/");
  }

  private async call(method: string, path: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}): Promise<Response> {
    const { username, password } = await this.creds();
    const res = await this.fetchFn(this.href(path), {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, ...init.headers },
      body: init.body,
      // the credentials go only to the address that was set up, never to wherever a redirect points
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status >= 300 && res.status < 400) throw new StorageError(`The server sent Wisp somewhere else (${res.headers.get("location") ?? res.status}). Use that address in Settings → Storage.`, 502);
    return res;
  }

  private async propfind(path: string, depth: "0" | "1") {
    const res = await this.call("PROPFIND", path, { headers: { depth, "content-type": "application/xml; charset=utf-8" }, body: PROPFIND_BODY });
    if (res.status === 404) return null;
    if (res.status !== 207) throw await failure(res, "list that folder");
    return parseMultistatus(await res.text());
  }

  private entry(r: ReturnType<typeof parseMultistatus>[number]): StorageEntry | null {
    const path = this.pathOf(r.href);
    if (!path) return null;
    const name = path === "/" ? "" : baseName(path);
    return { name, path, type: r.folder ? "folder" : "file", size: r.folder ? null : r.size, modified: r.modified, mime: r.folder ? null : (r.mime ?? mimeOf(name)) };
  }

  async list(path: string): Promise<StorageEntry[]> {
    const rows = await this.propfind(path, "1");
    if (!rows) throw new StorageError(`There's no folder ${path}.`, 404);
    return rows
      .map((r) => this.entry(r))
      .filter((e): e is StorageEntry => !!e && e.path !== path && parentPath(e.path) === path);
  }

  async stat(path: string): Promise<StorageEntry | null> {
    const rows = await this.propfind(path, "0");
    const r = rows?.[0];
    return r ? this.entry(r) : null;
  }

  async read(path: string, maxBytes: number) {
    const res = await this.call("GET", path);
    if (!res.ok) throw await failure(res, "read that file");
    return { data: await limitedBody(res, maxBytes), mime: (res.headers.get("content-type") ?? mimeOf(path)).split(";")[0], name: baseName(path) };
  }

  async write(path: string, data: Buffer, mime: string) {
    const res = await this.call("PUT", path, { headers: { "content-type": mime }, body: new Uint8Array(data) });
    if (res.status === 409) throw new StorageError(`The folder ${parentPath(path)} doesn't exist; make it first.`, 409);
    if (!res.ok) throw await failure(res, "save that file");
  }

  async remove(path: string) {
    const res = await this.call("DELETE", path);
    if (!res.ok && res.status !== 404) throw await failure(res, "delete that");
  }

  async mkdir(path: string) {
    const res = await this.call("MKCOL", path);
    if (res.status === 405) throw new StorageError(`${path} is already there.`, 409);
    if (res.status === 409) throw new StorageError(`The folder ${parentPath(path)} doesn't exist; make it first.`, 409);
    if (!res.ok) throw await failure(res, "make that folder");
  }

  /** Plain WebDAV has no search, so walk the allowed folders a level at a time, up to a limit. */
  async search(query: string, under: string[]): Promise<StorageEntry[]> {
    const q = query.toLowerCase();
    const found: StorageEntry[] = [];
    const queue = [...under];
    let visited = 0;
    while (queue.length && visited < 200 && found.length < 50) {
      const dir = queue.shift()!;
      visited++;
      const entries = await this.list(dir).catch(() => []);
      for (const e of entries) {
        if (e.name.toLowerCase().includes(q)) found.push(e);
        if (e.type === "folder") queue.push(e.path);
      }
    }
    return found.slice(0, 50);
  }
}

// --- Google Drive ----------------------------------------------------------------------------

export interface GoogleEndpoints {
  auth: string;
  token: string;
  api: string;
  upload: string;
}

export const GOOGLE: GoogleEndpoints = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  api: "https://www.googleapis.com/drive/v3",
  upload: "https://www.googleapis.com/upload/drive/v3",
};

type DriveFile = { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; parents?: string[] };

const DRIVE_FOLDER = "application/vnd.google-apps.folder";
/** Google's own documents have no bytes of their own: agents get them as text, a table or a picture. */
const DRIVE_EXPORT: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "text/plain", ext: "txt" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: "csv" },
  "application/vnd.google-apps.presentation": { mime: "text/plain", ext: "txt" },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: "png" },
};
const DRIVE_FIELDS = "id,name,mimeType,size,modifiedTime,parents";

export class DriveProvider implements StorageProvider {
  private ids = new Map<string, DriveFile | null>([["/", { id: "root", name: "", mimeType: DRIVE_FOLDER }]]);

  constructor(
    private token: () => Promise<string>,
    private fetchFn: Fetch,
    private ep: GoogleEndpoints = GOOGLE,
  ) {}

  private async call(url: string, init: RequestInit = {}, what = "reach Google Drive"): Promise<Response> {
    const res = await this.fetchFn(url, { ...init, headers: { authorization: `Bearer ${await this.token()}`, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw await failure(res, what);
    return res;
  }

  private entry(f: DriveFile, path: string): StorageEntry {
    const folder = f.mimeType === DRIVE_FOLDER;
    return { name: f.name, path, type: folder ? "folder" : "file", size: folder || f.size === undefined ? null : Number(f.size), modified: f.modifiedTime ?? null, mime: folder ? null : (DRIVE_EXPORT[f.mimeType]?.mime ?? f.mimeType) };
  }

  /** The Drive file at a path, walking down from My Drive one name at a time. */
  private async find(path: string): Promise<DriveFile | null> {
    if (this.ids.has(path)) return this.ids.get(path)!;
    const parent = await this.find(parentPath(path));
    if (!parent || parent.mimeType !== DRIVE_FOLDER) return null;
    const name = baseName(path).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = `'${parent.id}' in parents and name = '${name}' and trashed = false`;
    const res = await this.call(`${this.ep.api}/files?${new URLSearchParams({ q, fields: `files(${DRIVE_FIELDS})`, pageSize: "10", supportsAllDrives: "true" })}`);
    const hit = ((await res.json()) as { files: DriveFile[] }).files[0] ?? null;
    this.ids.set(path, hit);
    return hit;
  }

  async list(path: string): Promise<StorageEntry[]> {
    const dir = await this.find(path);
    if (!dir || dir.mimeType !== DRIVE_FOLDER) throw new StorageError(`There's no folder ${path}.`, 404);
    const out: StorageEntry[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ q: `'${dir.id}' in parents and trashed = false`, fields: `nextPageToken,files(${DRIVE_FIELDS})`, pageSize: "1000", orderBy: "folder,name" });
      if (pageToken) params.set("pageToken", pageToken);
      const r = (await (await this.call(`${this.ep.api}/files?${params}`)).json()) as { files: DriveFile[]; nextPageToken?: string };
      for (const f of r.files) {
        const p = `${path === "/" ? "" : path}/${f.name}`;
        this.ids.set(p, f);
        out.push(this.entry(f, p));
      }
      pageToken = r.nextPageToken ?? "";
    } while (pageToken && out.length < 5000);
    return out;
  }

  async stat(path: string) {
    const f = await this.find(path);
    return f ? this.entry(f, path) : null;
  }

  async read(path: string, maxBytes: number) {
    const f = await this.find(path);
    if (!f || f.mimeType === DRIVE_FOLDER) throw new StorageError(`There's no file ${path}.`, 404);
    const exp = DRIVE_EXPORT[f.mimeType];
    const url = exp ? `${this.ep.api}/files/${f.id}/export?mimeType=${encodeURIComponent(exp.mime)}` : `${this.ep.api}/files/${f.id}?alt=media`;
    const res = await this.call(url, {}, "read that file");
    return { data: await limitedBody(res, maxBytes), mime: exp?.mime ?? f.mimeType, name: exp ? `${f.name}.${exp.ext}` : f.name };
  }

  async write(path: string, data: Buffer, mime: string) {
    const existing = await this.find(path);
    if (existing) {
      if (existing.mimeType === DRIVE_FOLDER || DRIVE_EXPORT[existing.mimeType]) throw new StorageError(`${path} is a ${existing.mimeType === DRIVE_FOLDER ? "folder" : "Google document"}; save under another name.`, 409);
      await this.call(`${this.ep.upload}/files/${existing.id}?uploadType=media`, { method: "PATCH", headers: { "content-type": mime }, body: new Uint8Array(data) }, "save that file");
      return;
    }
    const parent = await this.find(parentPath(path));
    if (!parent || parent.mimeType !== DRIVE_FOLDER) throw new StorageError(`The folder ${parentPath(path)} doesn't exist; make it first.`, 409);
    const boundary = `wisp${Math.random().toString(36).slice(2)}`;
    const meta = JSON.stringify({ name: baseName(path), parents: [parent.id] });
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--`)]);
    const res = await this.call(`${this.ep.upload}/files?uploadType=multipart&fields=${DRIVE_FIELDS}`, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body) }, "save that file");
    this.ids.set(path, (await res.json()) as DriveFile);
  }

  /** Into Drive's bin, where it stays for 30 days, rather than gone for good. */
  async remove(path: string) {
    const f = await this.find(path);
    if (!f) return;
    await this.call(`${this.ep.api}/files/${f.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ trashed: true }) }, "delete that");
    this.ids.delete(path);
  }

  async mkdir(path: string) {
    if (await this.find(path)) throw new StorageError(`${path} is already there.`, 409);
    const parent = await this.find(parentPath(path));
    if (!parent || parent.mimeType !== DRIVE_FOLDER) throw new StorageError(`The folder ${parentPath(path)} doesn't exist; make it first.`, 409);
    const res = await this.call(`${this.ep.api}/files?fields=${DRIVE_FIELDS}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: baseName(path), mimeType: DRIVE_FOLDER, parents: [parent.id] }) }, "make that folder");
    this.ids.set(path, (await res.json()) as DriveFile);
  }

  /** Drive searches everything by name; keep only what sits under an allowed folder. */
  async search(query: string, under: string[]): Promise<StorageEntry[]> {
    const q = `name contains '${query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false`;
    const r = (await (await this.call(`${this.ep.api}/files?${new URLSearchParams({ q, fields: `files(${DRIVE_FIELDS})`, pageSize: "100" })}`)).json()) as { files: DriveFile[] };
    const out: StorageEntry[] = [];
    const paths = new Map<string, string | null>([["root", ""]]);
    const pathOfId = async (id: string, depth = 0): Promise<string | null> => {
      if (paths.has(id)) return paths.get(id)!;
      if (depth > 32) return null;
      const f = (await (await this.call(`${this.ep.api}/files/${id}?fields=${DRIVE_FIELDS}`)).json()) as DriveFile;
      // My Drive itself has no parents and its own id; anything shared in from elsewhere doesn't have a path here
      const up = f.parents?.[0] ? await pathOfId(f.parents[0], depth + 1) : f.name === "My Drive" ? "" : null;
      const p = up === null ? null : f.parents?.[0] ? `${up}/${f.name}` : "";
      paths.set(id, p);
      return p;
    };
    for (const f of r.files) {
      const up = f.parents?.[0] ? await pathOfId(f.parents[0]) : null;
      if (up === null) continue;
      const p = `${up}/${f.name}`;
      if (under.some((u) => u === "/" || p === u || p.startsWith(`${u}/`))) out.push(this.entry(f, p));
      if (out.length >= 50) break;
    }
    return out;
  }
}

// --- Dropbox ---------------------------------------------------------------------------------

export interface DropboxEndpoints {
  auth: string;
  token: string;
  api: string;
  content: string;
}

export const DROPBOX: DropboxEndpoints = {
  auth: "https://www.dropbox.com/oauth2/authorize",
  token: "https://api.dropboxapi.com/oauth2/token",
  api: "https://api.dropboxapi.com/2",
  content: "https://content.dropboxapi.com/2",
};

type DropboxEntry = { ".tag": "file" | "folder" | "deleted"; name: string; path_display?: string; size?: number; server_modified?: string };

/** Dropbox-API-Arg is a header, so anything outside ASCII goes as \uXXXX. */
const headerJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export class DropboxProvider implements StorageProvider {
  constructor(
    private token: () => Promise<string>,
    private fetchFn: Fetch,
    private ep: DropboxEndpoints = DROPBOX,
  ) {}

  private async rpc<T>(route: string, arg: unknown, what: string): Promise<T> {
    const res = await this.fetchFn(`${this.ep.api}/${route}`, { method: "POST", headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" }, body: JSON.stringify(arg), signal: AbortSignal.timeout(120_000) });
    if (res.status === 409) throw dropboxConflict(await res.text(), what);
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as T;
  }

  private entry(e: DropboxEntry, fallback?: string): StorageEntry {
    const path = e.path_display ?? fallback ?? `/${e.name}`;
    return { name: e.name, path, type: e[".tag"] === "folder" ? "folder" : "file", size: e[".tag"] === "file" ? (e.size ?? null) : null, modified: e.server_modified ?? null, mime: e[".tag"] === "file" ? mimeOf(e.name) : null };
  }

  async list(path: string): Promise<StorageEntry[]> {
    const out: StorageEntry[] = [];
    let r = await this.rpc<{ entries: DropboxEntry[]; cursor: string; has_more: boolean }>("files/list_folder", { path: path === "/" ? "" : path, limit: 2000 }, "list that folder");
    for (;;) {
      out.push(...r.entries.filter((e) => e[".tag"] !== "deleted").map((e) => this.entry(e)));
      if (!r.has_more || out.length >= 5000) break;
      r = await this.rpc("files/list_folder/continue", { cursor: r.cursor }, "list that folder");
    }
    return out;
  }

  async stat(path: string) {
    if (path === "/") return { name: "", path: "/", type: "folder" as const, size: null, modified: null, mime: null };
    try {
      return this.entry(await this.rpc<DropboxEntry>("files/get_metadata", { path }, "look at that"), path);
    } catch (e) {
      if (e instanceof StorageError && e.status === 404) return null;
      throw e;
    }
  }

  async read(path: string, maxBytes: number) {
    const res = await this.fetchFn(`${this.ep.content}/files/download`, { method: "POST", headers: { authorization: `Bearer ${await this.token()}`, "dropbox-api-arg": headerJson({ path }) }, signal: AbortSignal.timeout(120_000) });
    if (res.status === 409) throw dropboxConflict(await res.text(), "read that file");
    if (!res.ok) throw await failure(res, "read that file");
    return { data: await limitedBody(res, maxBytes), mime: mimeOf(path), name: baseName(path) };
  }

  async write(path: string, data: Buffer, _mime: string) {
    const res = await this.fetchFn(`${this.ep.content}/files/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/octet-stream", "dropbox-api-arg": headerJson({ path, mode: "overwrite", autorename: false, mute: true }) },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 409) throw dropboxConflict(await res.text(), "save that file");
    if (!res.ok) throw await failure(res, "save that file");
  }

  /** Dropbox keeps deleted files for at least 30 days, so this can be undone from its website. */
  async remove(path: string) {
    await this.rpc("files/delete_v2", { path }, "delete that");
  }

  async mkdir(path: string) {
    await this.rpc("files/create_folder_v2", { path, autorename: false }, "make that folder");
  }

  async search(query: string, under: string[]): Promise<StorageEntry[]> {
    const out: StorageEntry[] = [];
    for (const folder of under) {
      const r = await this.rpc<{ matches: { metadata: { metadata: DropboxEntry } }[] }>("files/search_v2", { query, options: { ...(folder === "/" ? {} : { path: folder }), max_results: 50 } }, "search");
      out.push(...r.matches.map((m) => this.entry(m.metadata.metadata)));
      if (out.length >= 50) break;
    }
    return out.slice(0, 50);
  }
}

function dropboxConflict(body: string, what: string): StorageError {
  if (/not_found/.test(body)) return new StorageError("Nothing at that path.", 404);
  if (/conflict/.test(body)) return new StorageError("Something's already there.", 409);
  if (/insufficient_space/.test(body)) return new StorageError("The Dropbox is full.", 507);
  return new StorageError(`Couldn't ${what}: Dropbox said ${body.slice(0, 200)}.`, 409);
}
