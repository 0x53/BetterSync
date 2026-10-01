import { Database } from "bun:sqlite";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StateStore } from "@bettersync/core";
import { fsyncDir, isNotFound } from "./fs.ts";

/**
 * The engine's state file, saved atomically (temp file, fsync, rename). A
 * torn or missing file is harmless: the engine rebuilds it from the server.
 */
export class FileStateStore implements StateStore {
  constructor(readonly path: string) {}

  async load(): Promise<string | null> {
    try {
      return await fsp.readFile(this.path, "utf8");
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async save(json: string): Promise<void> {
    // Only the state folder itself: recreating a synced folder that went missing would make it look emptied.
    await fsp.mkdir(dirname(this.path)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new Error(`${dirname(dirname(this.path))} is missing or not a folder`);
      if (e.code !== "EEXIST") throw e;
    });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fh = await fsp.open(tmp, "w", 0o600);
    try {
      await fh.writeFile(json);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, this.path);
    fsyncDir(dirname(this.path));
  }
}

/** Where a folder's state and lock live: `<folder>/.bettersync/`. Never synced (not a .md path). */
export function stateDir(folder: string): string {
  return join(folder, ".bettersync");
}

/**
 * One client per folder: two engines on one folder would each think the
 * other's writes are user edits. The lock is an exclusive SQLite lock on
 * `.bettersync/lock.db`, held by the open connection: the OS releases it
 * when the process exits or is killed, so there is no stale lock to judge,
 * and it holds across containers sharing the folder (pids would not).
 */
export class FolderLock {
  private constructor(private readonly db: Database) {}

  static async acquire(folder: string): Promise<FolderLock> {
    const path = join(stateDir(folder), "lock.db");
    await fsp.mkdir(dirname(path), { recursive: true });
    const db = new Database(path, { create: true });
    try {
      db.run("PRAGMA busy_timeout = 0");
      db.run("PRAGMA locking_mode = EXCLUSIVE");
      // Never committed: the open transaction holds the lock for the process's lifetime.
      db.run("BEGIN EXCLUSIVE");
    } catch (e) {
      db.close();
      if ((e as { code?: string }).code?.startsWith("SQLITE_BUSY")) throw new Error(`${folder} is already being synced by another process`);
      throw e;
    }
    return new FolderLock(db);
  }

  releaseSync(): void {
    try {
      this.db.close();
    } catch {
      // The OS drops the lock when the process ends anyway.
    }
  }
}
