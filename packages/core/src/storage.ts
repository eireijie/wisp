/**
 * The Storage mod: agents use files on the person's own storage (Nextcloud, a NAS, Google Drive,
 * Dropbox), only inside the folders the person allows. Everything runs on the hub, so sign-ins
 * never leave it.
 */

/** How Wisp talks to a service. */
export type StorageKind = "webdav" | "gdrive" | "dropbox";

/** What people pick from. Several WebDAV servers have their own name and logo. */
export type StorageService = "nextcloud" | "truenas" | "webdav" | "gdrive" | "dropbox";

export const STORAGE_SERVICES: Record<StorageService, { name: string; kind: StorageKind; logo: string | null; color: string | null }> = {
  nextcloud: { name: "Nextcloud", kind: "webdav", logo: "nextcloud", color: "#0082C9" },
  gdrive: { name: "Google Drive", kind: "gdrive", logo: "googledrive", color: "#4285F4" },
  dropbox: { name: "Dropbox", kind: "dropbox", logo: "dropbox", color: "#0061FF" },
  truenas: { name: "TrueNAS", kind: "webdav", logo: "truenas", color: "#0095D5" },
  webdav: { name: "Other server", kind: "webdav", logo: null, color: null },
};

export const STORAGE_SERVICE_IDS = Object.keys(STORAGE_SERVICES) as StorageService[];

/** How Wisp signs in: a token from the service, an app password, or a login read from the password manager each time. */
export type StorageSignIn = "oauth" | "app-password" | "password-manager";

/** What agents may do in a folder: look and copy out, or also add, replace and delete (each asked first). */
export type StorageAccess = "read" | "write";

export interface StorageFolder {
  /** "/Clients/Acme"; "/" is everything */
  path: string;
  access: StorageAccess;
}

/** A connection as people see it: never a password or token. */
export interface StorageConnection {
  id: string;
  workspaceId: string;
  name: string;
  service: StorageService;
  kind: StorageKind;
  /** the server's address (WebDAV), or null */
  url: string | null;
  /** who Wisp is signed in as, as the service says it */
  account: string;
  signIn: StorageSignIn;
  /** the password manager login it reads, when signIn is "password-manager" */
  loginItemId: string | null;
  folders: StorageFolder[];
  allAgents: boolean;
  agentIds: string[];
  /** "Always in this folder" answers: these agents add and replace files there without asking */
  always: { agentId: string; folder: string }[];
  /** why the last try failed, in words; null when fine */
  problem: string | null;
  createdBy: string;
  createdAt: string;
}

/** A file or folder on a storage. */
export interface StorageEntry {
  name: string;
  /** "/Clients/Acme/report.pdf" */
  path: string;
  type: "file" | "folder";
  size: number | null;
  modified: string | null;
  mime: string | null;
}

/** What an agent asks to do (an approval's `storage`). */
export interface StorageRequest {
  connectionId: string;
  connectionName: string;
  service: StorageService;
  action: "upload" | "replace" | "delete" | "mkdir";
  path: string;
  /** the Wisp file it puts there (upload, replace) */
  fileId: string | null;
  size: number | null;
  /** the allowed folder it falls in, for "Always in this folder" */
  folder: string;
  /** the person the agent was working for */
  requestedBy: string | null;
}

export class StoragePathError extends Error {}

/**
 * A path as Wisp keeps it: starts with "/", no trailing "/", no "." or ".." parts, no
 * backslashes or control characters. Anything that tries to climb out is refused rather than
 * cleaned up, so "a/../../b" never quietly means something else.
 */
export function storagePath(input: string): string {
  const raw = String(input ?? "").trim();
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw new StoragePathError(`"${input}" isn't a usable path`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || /^\.{3,}$/.test(p) || p.length > 255)) throw new StoragePathError(`"${input}" climbs out of its folder; give a plain path like /Clients/report.pdf`);
  if (parts.length > 64) throw new StoragePathError("that path is too deep");
  return `/${parts.join("/")}`;
}

/** Whether `path` is `folder` or inside it (both already through storagePath). */
export function inFolder(path: string, folder: string): boolean {
  if (folder === "/") return true;
  return path === folder || path.startsWith(`${folder}/`);
}

/** The allowed folder a path falls in (the deepest one), or null. */
export function folderFor(path: string, folders: StorageFolder[]): StorageFolder | null {
  return folders.filter((f) => inFolder(path, f.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

/** The parent folder of a path ("/" for top-level ones). */
export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** The last part of a path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
