import { isSyncablePath, pathKey, type LocalFs, type LocalStat } from "@bettersync/core";
import { hashSync } from "./hash.ts";

interface Entry {
  name: string;
  bytes: Uint8Array;
  mtime: number;
}

/** Content the engine destroyed (overwrote, deleted or renamed over). The server must still have it. */
export interface Clobber {
  device: string;
  path: string;
  hash: string;
  time: number;
}

/**
 * An in-memory folder. Case-insensitive folders (Windows, macOS, iOS) keep
 * the name a file was created with, like the real ones do, and allow a
 * case-only rename.
 *
 * The user side (`user*`) is synchronous and unchecked; the engine side
 * (`engineView`) records every piece of content it destroys, and throws if
 * the engine touches a file it must leave alone.
 */
export class SimFs {
  private readonly files = new Map<string, Entry>();
  /** Told about the user's changes, as a file watcher would be (the plugin's fake vault listens). */
  onUserChange: ((kind: "create" | "modify" | "delete" | "rename", path: string, oldPath?: string) => void) | undefined;

  constructor(
    readonly caseInsensitive: boolean,
    private readonly tick: () => number,
  ) {}

  private k(path: string) {
    return this.caseInsensitive ? pathKey(path) : path;
  }

  get(path: string): Entry | undefined {
    return this.files.get(this.k(path));
  }

  /** Syncable files by actual name, for the convergence check. */
  syncable(): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const e of this.files.values()) if (isSyncablePath(e.name)) out.set(e.name, e.bytes);
    return out;
  }

  all(): Entry[] {
    return [...this.files.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  userWrite(path: string, bytes: Uint8Array): void {
    const e = this.get(path);
    const name = e?.name ?? path;
    this.files.set(this.k(path), { name, bytes, mtime: this.tick() });
    this.onUserChange?.(e ? "modify" : "create", name);
  }

  userRemove(path: string): void {
    const e = this.get(path);
    this.files.delete(this.k(path));
    if (e) this.onUserChange?.("delete", e.name);
  }

  userRename(from: string, to: string): void {
    const e = this.get(from);
    if (!e) return;
    const replaced = this.get(to);
    this.files.delete(this.k(from));
    if (replaced && replaced !== e) this.onUserChange?.("delete", replaced.name);
    this.files.set(this.k(to), { name: to, bytes: e.bytes, mtime: e.mtime });
    this.onUserChange?.("rename", to, e.name);
  }

  engineView(device: string, clobbered: Clobber[], now: () => number, log?: (m: string) => void): LocalFs {
    const guard = (path: string) => {
      if (!isSyncablePath(path)) throw new Error(`engine touched unsyncable path ${path}`);
    };
    const lost = (e: Entry | undefined, replacement?: Uint8Array) => {
      if (!e || (replacement && sameBytes(e.bytes, replacement))) return;
      clobbered.push({ device, path: e.name, hash: hashSync(e.bytes), time: now() });
    };
    const stat = (e: Entry): LocalStat => ({ path: e.name, mtime: e.mtime, size: e.bytes.length });
    return {
      list: async () => this.all().map(stat),
      stat: async (path) => {
        const e = this.get(path);
        return e ? stat(e) : null;
      },
      variants: async (path) => {
        if (this.caseInsensitive) return this.get(path) ? [this.get(path)!.name] : [];
        const key = pathKey(path);
        return this.all()
          .map((e) => e.name)
          .filter((n) => pathKey(n) === key);
      },
      read: async (path) => this.get(path)?.bytes ?? null,
      write: async (path, bytes) => {
        guard(path);
        log?.(`fs write ${path}`);
        const old = this.get(path);
        lost(old, bytes);
        const e = { name: old?.name ?? path, bytes, mtime: this.tick() };
        this.files.set(this.k(path), e);
        return stat(e);
      },
      remove: async (path) => {
        guard(path);
        log?.(`fs remove ${path}`);
        lost(this.get(path));
        this.files.delete(this.k(path));
      },
      rename: async (from, to) => {
        guard(from);
        guard(to);
        log?.(`fs rename ${from} -> ${to}`);
        const e = this.get(from);
        if (!e) throw new Error(`rename: ${from} missing`);
        const target = this.get(to);
        if (target && target !== e) lost(target);
        this.files.delete(this.k(from));
        this.files.set(this.k(to), { ...e, name: to });
      },
    };
  }
}

function sameBytes(x: Uint8Array, y: Uint8Array) {
  return x.length === y.length && x.every((b, i) => b === y[i]);
}
