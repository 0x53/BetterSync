import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConcurrentChangeError, pathKey, type LocalFs, type LocalStat } from "@bettersync/core";

/**
 * A plain folder as the engine's LocalFs.
 *
 * Names. The engine works in vault paths: "/"-separated, NFC. On disk a name
 * may be NFD (copied from a Mac onto Linux) or differ in case on a
 * case-insensitive disk (Windows, macOS, WSL's /mnt/c). Every call resolves a
 * vault path to the actual name on disk by reading each folder on the way,
 * and reports actual names back (NFC-normalized).
 *
 * Atomic writes. Content is written to a temp file in the same folder,
 * fsynced, renamed over the note, and the folder fsynced, so a reader never
 * sees half a note and a crash never loses an acknowledged one.
 *
 * Concurrent edits. The engine reads a note, decides the server already has
 * that content, then replaces it. In between, the user or an agent may have
 * saved a new edit, and replacing it would lose that edit. So this adapter
 * remembers each file's identity (inode, size, mtime, ctime) as of the
 * engine's last look, and refuses to overwrite, delete or rename a file that
 * changed since, or to write over a path that was empty when the engine
 * looked. The engine's pass then fails with ConcurrentChangeError and the
 * next pass sees the edit. What remains is the moment between that check and
 * the rename, a few system calls wide.
 */
export class DiskFs implements LocalFs {
  /** Identity of each file as of the engine's last look, by path on disk; null = it was not there. */
  private readonly seen = new Map<string, string | null>();
  private sensitive: Promise<boolean> | undefined;

  constructor(readonly root: string) {}

  async list(): Promise<LocalStat[]> {
    const out: LocalStat[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdirSafe(join(this.root, dir))) {
        const rel = dir === "" ? e.name : `${dir}/${e.name}`;
        // Symlinks are not followed: a link out of the folder would sync files that are not in it.
        if (e.isDirectory()) await walk(rel);
        else if (e.isFile() && !isTemp(e.name)) {
          const st = await lstatSafe(join(this.root, rel));
          if (st?.isFile()) out.push(toStat(rel, st));
        }
      }
    };
    await walk("");
    return out;
  }

  async stat(path: string): Promise<LocalStat | null> {
    const disk = await this.resolve(path);
    if (disk === null) {
      this.seen.set(path, null);
      return null;
    }
    const st = await lstatSafe(join(this.root, disk));
    if (!st?.isFile()) return null;
    this.seen.set(disk, sig(st));
    return toStat(disk, st);
  }

  async variants(path: string): Promise<string[]> {
    const found = await this.diskVariants(path);
    if (found.length === 0) this.seen.set(path, null);
    return found.map(nfc);
  }

  async read(path: string): Promise<Uint8Array | null> {
    const disk = await this.resolve(path);
    if (disk === null) {
      this.seen.set(path, null);
      return null;
    }
    const abs = join(this.root, disk);
    const before = await lstatSafe(abs);
    if (!before?.isFile()) return null;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fsp.readFile(abs));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
    const after = await lstatSafe(abs);
    if (!after || sig(after) !== sig(before)) throw new ConcurrentChangeError(path, "changed while being read");
    this.seen.set(disk, sig(after));
    return bytes;
  }

  async write(path: string, bytes: Uint8Array): Promise<LocalStat> {
    const existing = await this.resolve(path);
    await this.checkUnchanged(existing, path);
    // Over an existing file, keep its actual name (folder case included), like a save in an editor does.
    const disk = existing ?? path;
    const abs = join(this.root, disk);
    await fsp.mkdir(dirname(abs), { recursive: true });
    const mode = existing ? (await lstatSafe(abs))?.mode : undefined;
    const tmp = join(dirname(abs), tempName());
    const fh = await fsp.open(tmp, "wx", mode === undefined ? 0o644 : mode & 0o7777);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await this.checkUnchanged(existing, path);
      await fsp.rename(tmp, abs);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    fsyncDir(dirname(abs));
    const st = await lstatSafe(abs);
    if (!st) {
      // Deleted the moment it landed. The write still happened, so the engine
      // records it, and its next pass sees the delete as the user's.
      this.seen.set(disk, null);
      return { path: nfc(disk), mtime: Date.now(), size: bytes.length };
    }
    this.seen.set(disk, sig(st));
    return toStat(disk, st);
  }

  async remove(path: string): Promise<void> {
    const disk = await this.resolve(path);
    if (disk === null) return;
    await this.checkUnchanged(disk, path);
    await fsp.rm(join(this.root, disk), { force: true });
    this.seen.set(disk, null);
    await this.pruneEmpty(dirname(disk));
  }

  async rename(from: string, to: string): Promise<void> {
    const src = await this.resolve(from);
    if (src === null) throw new Error(`rename: ${from} is missing`);
    await this.checkUnchanged(src, from);
    const dst = await this.resolve(to);
    if (dst !== null && dst !== src) throw new ConcurrentChangeError(to, "is another file");
    const abs = join(this.root, to);
    await fsp.mkdir(dirname(abs), { recursive: true });
    await fsp.rename(join(this.root, src), abs);
    fsyncDir(dirname(abs));
    const moved = (await this.resolve(to)) ?? to;
    const st = await lstatSafe(join(this.root, moved));
    this.seen.set(src, null);
    if (st) this.seen.set(moved, sig(st));
    if (pathKey(dirname(src)) !== pathKey(dirname(to))) await this.pruneEmpty(dirname(src));
  }

  /** Deletes temp files left by a killed process. */
  async cleanTemp(): Promise<number> {
    let n = 0;
    const walk = async (dir: string) => {
      for (const e of await readdirSafe(dir)) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && isTemp(e.name)) {
          await fsp.rm(p, { force: true });
          n++;
        }
      }
    };
    await walk(this.root);
    return n;
  }

  // ---- names ----

  /**
   * The file the filesystem opens for `path`, by its path on disk, or null.
   * Prefers the exact name (after NFC); otherwise, on a disk that ignores
   * case, the one file the OS resolves the path to.
   */
  private async resolve(path: string): Promise<string | null> {
    // Fast path: on a case-sensitive disk, a path that exists is its own actual name.
    if (await this.caseSensitive()) {
      const st = await lstatSafe(join(this.root, path));
      if (st?.isFile()) return path;
    }
    const found = await this.diskVariants(path);
    const exact = found.find((d) => nfc(d) === path);
    if (exact !== undefined) return exact;
    if (found.length === 0) return null;
    const st = await lstatSafe(join(this.root, path));
    if (!st) return null;
    for (const d of found) {
      const s = await lstatSafe(join(this.root, d));
      if (s && s.ino === st.ino && s.dev === st.dev) return d;
    }
    return null;
  }

  /** Every regular file whose path equals `path` ignoring case and normalization, by path on disk. */
  private async diskVariants(path: string): Promise<string[]> {
    const segments = path.split("/");
    let dirs = [""];
    for (const [i, seg] of segments.entries()) {
      const last = i === segments.length - 1;
      const key = pathKey(seg);
      const next: string[] = [];
      for (const dir of dirs) {
        for (const e of await readdirSafe(join(this.root, dir))) {
          if (pathKey(e.name) !== key || (last ? !e.isFile() || isTemp(e.name) : !e.isDirectory())) continue;
          next.push(dir === "" ? e.name : `${dir}/${e.name}`);
        }
      }
      if (next.length === 0) return [];
      dirs = next;
    }
    return dirs;
  }

  /**
   * Whether the folder's disk tells names apart by case, probed once with a
   * temp file. Unknown (the folder is missing) counts as insensitive, whose
   * path is slower but right on every disk.
   */
  private caseSensitive(): Promise<boolean> {
    this.sensitive ??= (async () => {
      const name = tempName();
      const probe = join(this.root, name);
      try {
        await fsp.writeFile(probe, "", { flag: "wx" });
      } catch {
        this.sensitive = undefined;
        return false;
      }
      try {
        return (await lstatSafe(join(this.root, name.toUpperCase()))) === null;
      } finally {
        await fsp.rm(probe, { force: true });
      }
    })();
    return this.sensitive;
  }

  private async checkUnchanged(disk: string | null, path: string): Promise<void> {
    if (disk === null) {
      if (this.seen.get(path)) throw new ConcurrentChangeError(path, "was deleted since it was read");
      return;
    }
    const st = await lstatSafe(join(this.root, disk));
    const now = st ? sig(st) : null;
    if (this.seen.get(disk) !== now) throw new ConcurrentChangeError(path, "changed since it was read");
  }

  /** Removes folders left empty by the engine's own deletes and moves, up to the root. */
  private async pruneEmpty(dir: string): Promise<void> {
    while (dir !== "." && dir !== "" && dir !== "/") {
      try {
        await fsp.rmdir(join(this.root, dir));
      } catch {
        return;
      }
      dir = dirname(dir);
    }
  }
}

const TEMP = /^\.bettersync-[0-9a-z]+\.tmp$/;
const isTemp = (name: string) => TEMP.test(name);
const tempName = () => `.bettersync-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}.tmp`;

const nfc = (s: string) => s.normalize("NFC");

function sig(st: Stats): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

function toStat(disk: string, st: Stats): LocalStat {
  return { path: nfc(disk), mtime: st.mtimeMs, size: st.size };
}

// Lookups are synchronous: Bun's async fs costs several times more per call,
// and a pass over 3,000 notes makes thousands of them with nothing else to do.

async function readdirSafe(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (isNotFound(e) || (e as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw e;
  }
}

async function lstatSafe(path: string): Promise<Stats | null> {
  try {
    return lstatSync(path);
  } catch (e) {
    if (isNotFound(e) || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw e;
  }
}

export function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Makes a rename in `dir` durable. Not possible on Windows, where it is skipped. */
export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Platforms that cannot fsync a directory.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
