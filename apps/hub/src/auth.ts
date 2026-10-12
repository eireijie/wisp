import crypto from "node:crypto";
import type { Db } from "./db.ts";

export type TokenKind = "session" | "agent" | "node";

export interface Principal {
  kind: TokenKind;
  subjectId: string; // user id, agent id, or node id
  workspaceId: string;
  /** the person who made an agent's connection token: an agent connected that way works for them */
  createdBy: string | null;
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt") return false;
  const key = Buffer.from(keyB64, "base64");
  const test = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), key.length);
  return crypto.timingSafeEqual(key, test);
}

const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

/** Issue a bearer token. Only the hash is stored; the plaintext is shown once. */
export function issueToken(db: Db, kind: TokenKind, subjectId: string, workspaceId: string, label = "", createdBy: string | null = null): string {
  const token = `wr_${kind}_${crypto.randomBytes(24).toString("base64url")}`;
  db.prepare("INSERT INTO tokens (hash, kind, subject_id, workspace_id, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(sha(token), kind, subjectId, workspaceId, label, createdBy, now());
  return token;
}

export function resolveToken(db: Db, token: string | undefined): Principal | null {
  if (!token) return null;
  const row = db.prepare("SELECT kind, subject_id, workspace_id, created_by FROM tokens WHERE hash = ?").get(sha(token)) as
    | { kind: TokenKind; subject_id: string; workspace_id: string; created_by: string | null }
    | undefined;
  if (!row) return null;
  db.prepare("UPDATE tokens SET last_used = ? WHERE hash = ?").run(now(), sha(token));
  return { kind: row.kind, subjectId: row.subject_id, workspaceId: row.workspace_id, createdBy: row.created_by };
}

export function revokeToken(db: Db, token: string) {
  db.prepare("DELETE FROM tokens WHERE hash = ?").run(sha(token));
}

export function revokeSubjectTokens(db: Db, kind: TokenKind, subjectId: string) {
  db.prepare("DELETE FROM tokens WHERE kind = ? AND subject_id = ?").run(kind, subjectId);
}

export function bearer(header: string | undefined): string | undefined {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1];
}
