import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/**
 * Stand-ins for the services the Storage mod talks to: a WebDAV server over a folder on disk
 * (with Nextcloud's sign-in flow in front), and small in-memory Google Drive and Dropbox APIs.
 * They answer the way the real ones do for the calls Wisp makes, nothing more.
 */
export interface Stubs {
  base: string;
  close(): Promise<void>;
  /** the person clicks "Grant access" in Nextcloud */
  approveNextcloud(): void;
  /** what each stub saw, for checking that secrets go where they should */
  seen: { path: string; auth: string | undefined }[];
  drive: Map<string, DriveItem>;
  dropbox: Map<string, Buffer | "folder">;
  seedDropbox(p: string, v: Buffer | "folder"): void;
  seedDrive(name: string, parent: string, data?: Buffer): string;
}

type DriveItem = { id: string; name: string; mimeType: string; parents: string[]; data?: Buffer; trashed?: boolean; modifiedTime: string };

const FOLDER = "application/vnd.google-apps.folder";

export async function startStubs(root: string, creds: { user: string; password: string }): Promise<Stubs> {
  let approved = false;
  const seen: Stubs["seen"] = [];
  const drive = new Map<string, DriveItem>([["root", { id: "root", name: "My Drive", mimeType: FOLDER, parents: [], modifiedTime: new Date().toISOString() }]]);
  const dropbox = new Map<string, Buffer | "folder">();
  let nextId = 1;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    seen.push({ path: url.pathname, auth: req.headers.authorization });
    const send = (status: number, data?: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(data === undefined ? undefined : typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
    };

    // --- Nextcloud Login Flow v2 ---
    if (url.pathname === "/nc/index.php/login/v2" && req.method === "POST") return send(200, { poll: { token: "poll-token", endpoint: `${base}/nc/login/v2/poll` }, login: `${base}/nc/login/v2/flow/abc` });
    if (url.pathname === "/nc/login/v2/poll" && req.method === "POST") {
      if (new URLSearchParams(body.toString()).get("token") !== "poll-token" || !approved) return send(404, []);
      return send(200, { server: `${base}/nc`, loginName: creds.user, appPassword: creds.password });
    }

    // --- WebDAV (also Nextcloud's /remote.php/dav/files/<user>/) ---
    const dav = url.pathname.match(/^\/(?:dav|nc\/remote\.php\/dav\/files\/[^/]+)(\/.*)?$/);
    if (dav) {
      const [user, pass] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":");
      if (user !== creds.user || pass !== creds.password) return send(401, "no", "text/plain");
      const prefix = url.pathname.slice(0, url.pathname.length - (dav[1]?.length ?? 0));
      const rel = decodeURIComponent(dav[1] ?? "/");
      const file = path.join(root, rel);
      if (!file.startsWith(root)) return send(400, "bad path", "text/plain");
      const exists = fs.existsSync(file);
      const hrefOf = (r: string) => `${prefix}${r.split("/").map(encodeURIComponent).join("/")}`;
      const prop = (r: string, f: string) => {
        const st = fs.statSync(f);
        return `<d:response><d:href>${hrefOf(r)}${st.isDirectory() && !r.endsWith("/") ? "/" : ""}</d:href><d:propstat><d:prop><d:resourcetype>${st.isDirectory() ? "<d:collection/>" : ""}</d:resourcetype>${st.isDirectory() ? "" : `<d:getcontentlength>${st.size}</d:getcontentlength>`}<d:getlastmodified>${st.mtime.toUTCString()}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      };
      if (req.method === "PROPFIND") {
        if (!exists) return send(404, "", "text/plain");
        const out = [prop(rel, file)];
        if (req.headers.depth === "1" && fs.statSync(file).isDirectory()) for (const n of fs.readdirSync(file)) out.push(prop(`${rel.replace(/\/$/, "")}/${n}`, path.join(file, n)));
        return send(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${out.join("")}</d:multistatus>`, "application/xml");
      }
      if (req.method === "GET") return exists && fs.statSync(file).isFile() ? send(200, fs.readFileSync(file), "text/plain") : send(404, "", "text/plain");
      if (req.method === "PUT") {
        if (!fs.existsSync(path.dirname(file))) return send(409, "", "text/plain");
        fs.writeFileSync(file, body);
        return send(exists ? 204 : 201, "", "text/plain");
      }
      if (req.method === "DELETE") {
        if (!exists) return send(404, "", "text/plain");
        fs.rmSync(file, { recursive: true });
        return send(204, "", "text/plain");
      }
      if (req.method === "MKCOL") {
        if (exists) return send(405, "", "text/plain");
        if (!fs.existsSync(path.dirname(file))) return send(409, "", "text/plain");
        fs.mkdirSync(file);
        return send(201, "", "text/plain");
      }
      return send(405, "", "text/plain");
    }

    // --- Google ---
    if (url.pathname === "/google/token") {
      const f = new URLSearchParams(body.toString());
      if (f.get("client_id") !== "goog-client" || f.get("client_secret") !== "goog-secret") return send(401, { error: "invalid_client" });
      if (f.get("grant_type") === "authorization_code" && (f.get("code") !== "goog-code" || !f.get("code_verifier"))) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: "goog-access", refresh_token: "goog-refresh", expires_in: 3600 });
    }
    if (url.pathname.startsWith("/google/")) {
      if (req.headers.authorization !== "Bearer goog-access") return send(401, { error: "unauthorized" });
      const view = (f: DriveItem) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, modifiedTime: f.modifiedTime, ...(f.data ? { size: String(f.data.length) } : {}) });
      if (url.pathname === "/google/drive/v3/about") return send(200, { user: { emailAddress: "you@example.com" } });
      if (url.pathname === "/google/drive/v3/files" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const live = [...drive.values()].filter((f) => f.id !== "root" && !f.trashed);
        const inParent = q.match(/'([^']+)' in parents/)?.[1];
        const named = q.match(/name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\(.)/g, "$1");
        const contains = q.match(/name contains '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\(.)/g, "$1");
        const files = live.filter((f) => (!inParent || f.parents.includes(inParent)) && (named === undefined || f.name === named) && (contains === undefined || f.name.toLowerCase().includes(contains.toLowerCase())));
        return send(200, { files: files.map(view) });
      }
      if (url.pathname === "/google/drive/v3/files" && req.method === "POST") {
        const meta = JSON.parse(body.toString());
        const f: DriveItem = { id: `d${nextId++}`, name: meta.name, mimeType: meta.mimeType, parents: meta.parents, modifiedTime: new Date().toISOString() };
        drive.set(f.id, f);
        return send(200, view(f));
      }
      const one = url.pathname.match(/^\/google\/drive\/v3\/files\/([^/]+)$/);
      if (one) {
        const f = drive.get(one[1]);
        if (!f) return send(404, { error: "notFound" });
        if (req.method === "PATCH") {
          Object.assign(f, JSON.parse(body.toString()));
          return send(200, view(f));
        }
        if (url.searchParams.get("alt") === "media") return send(200, f.data ?? Buffer.alloc(0), "application/octet-stream");
        return send(200, view(f));
      }
      if (url.pathname === "/google/upload/drive/v3/files" && req.method === "POST") {
        // multipart/related: the JSON part, then the bytes
        const boundary = String(req.headers["content-type"]).match(/boundary=(.+)$/)![1];
        const parts = body.toString("latin1").split(`--${boundary}`);
        const meta = JSON.parse(parts[1].split("\r\n\r\n")[1]);
        const data = Buffer.from(parts[2].split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, ""), "latin1");
        const f: DriveItem = { id: `d${nextId++}`, name: meta.name, mimeType: "application/octet-stream", parents: meta.parents, data, modifiedTime: new Date().toISOString() };
        drive.set(f.id, f);
        return send(200, view(f));
      }
      const up = url.pathname.match(/^\/google\/upload\/drive\/v3\/files\/([^/]+)$/);
      if (up && req.method === "PATCH") {
        const f = drive.get(up[1])!;
        f.data = body;
        return send(200, view(f));
      }
      return send(404, { error: "no route" });
    }

    // --- Dropbox ---
    if (url.pathname === "/dropbox/token") {
      const f = new URLSearchParams(body.toString());
      if (f.get("client_id") !== "dbx-key") return send(400, { error: "invalid_client" });
      if (f.get("grant_type") === "authorization_code" && (f.get("code") !== "dbx-code" || !f.get("code_verifier"))) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: "dbx-access", refresh_token: "dbx-refresh", expires_in: 14400 });
    }
    if (url.pathname.startsWith("/dropbox/")) {
      if (req.headers.authorization !== "Bearer dbx-access") return send(401, { error: "unauthorized" });
      const key = (p: string) => p.toLowerCase();
      const meta = (p: string) => {
        const v = dropbox.get(key(p));
        const name = p.slice(p.lastIndexOf("/") + 1);
        return v === "folder" ? { ".tag": "folder", name, path_display: p } : { ".tag": "file", name, path_display: p, size: v!.length, server_modified: "2026-11-01T00:00:00Z" };
      };
      const arg = JSON.parse(req.headers["dropbox-api-arg"] ? String(req.headers["dropbox-api-arg"]) : body.toString() || "{}");
      const notFound = () => send(409, { error_summary: "path/not_found/.." });
      const r = url.pathname.replace(/^\/dropbox\/(api|content)\/2\//, "");
      if (r === "users/get_current_account") return send(200, { email: "you@dropbox.example" });
      if (r === "files/list_folder") {
        const dir = key(arg.path);
        if (dir && dropbox.get(dir) !== "folder") return notFound();
        const kids = [...dropbox.keys()].filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes("/"));
        return send(200, { entries: kids.map((k) => meta(display.get(k)!)), cursor: "c", has_more: false });
      }
      if (r === "files/get_metadata") return dropbox.has(key(arg.path)) ? send(200, meta(display.get(key(arg.path))!)) : notFound();
      if (r === "files/download") return dropbox.get(key(arg.path)) instanceof Buffer ? send(200, dropbox.get(key(arg.path)) as Buffer, "application/octet-stream") : notFound();
      if (r === "files/upload") {
        if (key(arg.path).lastIndexOf("/") > 0 && dropbox.get(key(arg.path).slice(0, key(arg.path).lastIndexOf("/"))) !== "folder") return notFound();
        dropbox.set(key(arg.path), body);
        display.set(key(arg.path), arg.path);
        return send(200, meta(arg.path));
      }
      if (r === "files/create_folder_v2") {
        if (dropbox.has(key(arg.path))) return send(409, { error_summary: "path/conflict/folder/.." });
        dropbox.set(key(arg.path), "folder");
        display.set(key(arg.path), arg.path);
        return send(200, { metadata: meta(arg.path) });
      }
      if (r === "files/delete_v2") {
        if (!dropbox.has(key(arg.path))) return notFound();
        for (const k of [...dropbox.keys()]) if (k === key(arg.path) || k.startsWith(`${key(arg.path)}/`)) dropbox.delete(k);
        return send(200, { metadata: {} });
      }
      if (r === "files/search_v2") {
        const under = key(arg.options?.path ?? "");
        const hits = [...dropbox.keys()].filter((k) => k.startsWith(`${under}/`) && k.slice(k.lastIndexOf("/") + 1).includes(arg.query.toLowerCase()));
        return send(200, { matches: hits.map((k) => ({ metadata: { metadata: meta(display.get(k)!) } })) });
      }
      return send(404, { error: "no route" });
    }
    send(404, { error: "no route" });
  });
  const display = new Map<string, string>();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    seen,
    drive,
    dropbox,
    approveNextcloud: () => (approved = true),
    seedDropbox: (p, v) => {
      dropbox.set(p.toLowerCase(), v);
      display.set(p.toLowerCase(), p);
    },
    seedDrive: (name, parent, data) => {
      const f: DriveItem = { id: `d${nextId++}`, name, mimeType: data ? "text/plain" : FOLDER, parents: [parent], data, modifiedTime: new Date().toISOString() };
      drive.set(f.id, f);
      return f.id;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
