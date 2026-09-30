import { rmSync } from "node:fs";
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
    await fsp.mkdir(dirname(this.path), { recursive: true });
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
 * other's writes are user edits. The lock file holds the owner's pid; a lock
 * whose process is gone (killed) is taken over.
 */
export class FolderLock {
  private constructor(readonly path: string) {}

  static async acquire(folder: string): Promise<FolderLock> {
    const path = join(stateDir(folder), "lock");
    await fsp.mkdir(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fh = await fsp.open(path, "wx");
        await fh.writeFile(String(process.pid));
        await fh.close();
        return new FolderLock(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const pid = Number((await fsp.readFile(path, "utf8").catch(() => "")).trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
        throw new Error(`${folder} is already being synced by process ${pid}`);
      }
      await fsp.rm(path, { force: true });
    }
    throw new Error(`could not lock ${folder}`);
  }

  releaseSync(): void {
    try {
      rmSync(this.path, { force: true });
    } catch {
      // Best effort; a stale lock is taken over next time.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
