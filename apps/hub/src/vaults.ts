import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Vault } from "@wisp/vault";
import type { Store } from "./store.ts";

interface Opened {
  vault: Vault;
  db: Database.Database;
  stopWatching: () => void;
}

/**
 * Every organization has its own memory vault. The first one keeps the vault the hub always had
 * (<data>/vault, or the folder the owner chose); the others live under <data>/orgs/<id>/vault, each
 * with its own search index, so notes never mix between organizations.
 */
export class Vaults {
  private others = new Map<string, Opened>();
  private opening = new Map<string, Promise<Vault>>();

  constructor(
    private dataDir: string,
    readonly primary: Vault,
    private store: Store,
    private onChange: (workspaceId: string) => void = () => {},
  ) {}

  /** The organization that owns the original vault: the first one made on this hub. */
  primaryWorkspaceId(): string | undefined {
    return this.store.firstWorkspace()?.id;
  }

  isPrimary(workspaceId: string): boolean {
    const first = this.primaryWorkspaceId();
    return !first || first === workspaceId;
  }

  /** Where an organization other than the first keeps its own files (vault, index, git gateway). */
  orgDir(workspaceId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) throw new Error("bad organization id");
    return path.join(this.dataDir, "orgs", workspaceId);
  }

  /** The vault of an organization. It must have been opened (at startup, or when the organization was made). */
  get(workspaceId: string): Vault {
    if (this.isPrimary(workspaceId)) return this.primary;
    const v = this.others.get(workspaceId);
    if (!v) throw new Error(`memory for organization ${workspaceId} isn't open`);
    return v.vault;
  }

  /** Open (creating and git-initialising it the first time) an organization's vault. */
  open(workspaceId: string): Promise<Vault> {
    if (this.isPrimary(workspaceId)) return Promise.resolve(this.primary);
    const ready = this.others.get(workspaceId);
    if (ready) return Promise.resolve(ready.vault);
    let p = this.opening.get(workspaceId);
    if (!p) {
      p = (async () => {
        const dir = this.orgDir(workspaceId);
        fs.mkdirSync(dir, { recursive: true });
        // the index is a cache of the notes on disk; one file per organization keeps paths from colliding
        const db = new Database(path.join(dir, "vault-index.db"));
        db.pragma("journal_mode = WAL");
        const vault = new Vault(path.join(dir, "vault"), db);
        try {
          await vault.init();
        } catch (e) {
          db.close();
          throw e;
        }
        const stopWatching = vault.watch({ onChange: () => this.onChange(workspaceId) });
        this.others.set(workspaceId, { vault, db, stopWatching });
        return vault;
      })().finally(() => this.opening.delete(workspaceId));
      this.opening.set(workspaceId, p);
    }
    return p;
  }

  /** Open every organization's vault (at startup). */
  async openAll() {
    const ids = (this.store.db.prepare("SELECT id FROM workspaces ORDER BY created_at").all() as { id: string }[]).map((r) => r.id);
    for (const wsId of ids) await this.open(wsId);
  }

  /** Close an organization's vault and delete its files (the organization was deleted). Never the first one's. */
  async remove(workspaceId: string) {
    if (this.isPrimary(workspaceId)) throw new Error("the first organization's memory can't be removed");
    await this.opening.get(workspaceId)?.catch(() => {});
    const o = this.others.get(workspaceId);
    if (o) {
      o.stopWatching();
      o.db.close();
      this.others.delete(workspaceId);
    }
    fs.rmSync(this.orgDir(workspaceId), { recursive: true, force: true });
  }

  close() {
    for (const o of this.others.values()) {
      o.stopWatching();
      o.db.close();
    }
    this.others.clear();
  }
}
