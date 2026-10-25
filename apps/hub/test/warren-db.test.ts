import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptWarrenDb } from "../src/app.ts";
import { openDb } from "../src/db.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-db-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a data folder from before the rename", () => {
  it("takes over warren.db with its write-ahead log, keeping what was written", () => {
    const old = openDb(path.join(dir, "warren.db"));
    old.exec("CREATE TABLE IF NOT EXISTS kept (v TEXT)");
    old.prepare("INSERT INTO kept VALUES (?)").run("from warren");
    // leave the -wal/-shm in place, as a hub that was stopped hard would
    for (const s of ["", "-wal", "-shm"]) if (fs.existsSync(path.join(dir, `warren.db${s}`))) fs.copyFileSync(path.join(dir, `warren.db${s}`), path.join(dir, `snap.db${s}`));
    old.close();
    for (const s of ["", "-wal", "-shm"]) {
      fs.rmSync(path.join(dir, `warren.db${s}`), { force: true });
      if (fs.existsSync(path.join(dir, `snap.db${s}`))) fs.renameSync(path.join(dir, `snap.db${s}`), path.join(dir, `warren.db${s}`));
    }

    expect(adoptWarrenDb(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "warren.db"))).toBe(false);
    const db = openDb(path.join(dir, "wisp.db"));
    expect(db.prepare("SELECT v FROM kept").all()).toEqual([{ v: "from warren" }]);
    db.close();
    expect(adoptWarrenDb(dir)).toBe(false);
  });

  it("never replaces an existing wisp.db", () => {
    fs.writeFileSync(path.join(dir, "wisp.db"), "new");
    fs.writeFileSync(path.join(dir, "warren.db"), "old");
    expect(adoptWarrenDb(dir)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "wisp.db"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(dir, "warren.db"), "utf8")).toBe("old");
  });

  it("does nothing on a fresh folder", () => {
    expect(adoptWarrenDb(dir)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
