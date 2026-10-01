import { sha256Hex } from "./hash.ts";
import { conflictCopyPath, isSyncablePath, MAX_NOTE_BYTES, pathKey, sameNoteName } from "./paths.ts";
import type { BlobHash, Change, ChangesResponse, Op, OpsResponse, PathState, Seq, StateResponse } from "./protocol.ts";

/**
 * The sync engine shared by the plugin and the headless client (design doc,
 * "Sync model"). It runs against an abstract filesystem, server and state
 * store, so the simulator can drive it deterministically.
 *
 * A pass pulls the change log, pushes local changes as compare-and-swap ops,
 * then pulls again. The one rule that keeps it safe: the engine overwrites or
 * deletes local content only when the server already has it, either as the
 * version this device last synced or as content the server just acknowledged.
 * Anything else is a local edit, which is pushed (and merged by the server)
 * instead of overwritten.
 *
 * Every step is idempotent, so a crash at any point is repaired by the next
 * pass: local files are rehashed, stale ops are recognised by the server, and
 * lost client state is rebuilt from the server's state.
 */

export interface LocalStat {
  /** The file's actual name on disk, "/"-separated and relative to the vault root. */
  path: string;
  mtime: number;
  size: number;
}

/**
 * A vault folder. Writes are atomic (temp file + rename) and create parent
 * folders. An adapter that can tell a file changed since the engine last
 * looked at it (a user's edit racing the engine's write) throws
 * ConcurrentChangeError instead of replacing it; the next pass sees the edit.
 */
export interface LocalFs {
  /** Every file in the folder, syncable or not. */
  list(): Promise<LocalStat[]>;
  /** Looks a path up the way the filesystem does, so on a case-insensitive one it may return another case. */
  stat(path: string): Promise<LocalStat | null>;
  /**
   * Every file whose path equals `path` ignoring case, by actual name. On a
   * case-insensitive disk that is at most the file itself; on a
   * case-sensitive one there may be several ("Note.md", "note.md").
   */
  variants(path: string): Promise<string[]>;
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<LocalStat>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** The file changed under the engine; the pass stops and the next one sees the change. */
export class ConcurrentChangeError extends Error {
  constructor(
    readonly path: string,
    what: string,
  ) {
    super(`${path} ${what}`);
  }
}

/**
 * The adapter cannot change this one file yet: an editor holds typing that
 * the change would clash with (the plugin), or a folder on its path is a
 * symlink, which the adapter will not write through. The engine keeps the server's
 * state pending, as it does for unsynced local content, and carries on with
 * the rest of the pass. Uncaught, it is a ConcurrentChangeError: retry soon.
 */
export class LocalBusyError extends ConcurrentChangeError {}

/** The server API (design doc, "API"). Methods reject on network or server errors. */
export interface Remote {
  state(): Promise<StateResponse>;
  changes(after: Seq): Promise<ChangesResponse>;
  hasBlob(hash: BlobHash): Promise<boolean>;
  putBlob(hash: BlobHash, bytes: Uint8Array): Promise<void>;
  getBlob(hash: BlobHash): Promise<Uint8Array>;
  ops(ops: Op[]): Promise<OpsResponse>;
}

/** Where the engine keeps its small JSON state (the plugin folder, or next to the headless folder). */
export interface StateStore {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
}

export interface EngineDeps {
  fs: LocalFs;
  remote: Remote;
  store: StateStore;
  device: string;
  now(): number;
  hash?(bytes: Uint8Array): Promise<BlobHash>;
  /** Debug trace of ops sent and their results. */
  log?(message: string): void;
}

/** What this device last synced for a path key: the server's version and its content hash. */
interface BaseEntry {
  path: string;
  version: Seq;
  /** null: deleted at `version`. */
  hash: BlobHash | null;
  /** Local stat when the file was last known to hold `hash` (or `prev`), to skip rehashing. */
  mtime?: number;
  size?: number;
  /**
   * The mtime was within RACY_MS of when it was recorded, so an edit saved
   * right after may share it (and the size): the stat cannot vouch for the
   * content, and the next pass rehashes. Git calls this "racily clean".
   */
  racy?: true;
  /** On a deleted entry: the content the delete removed here, to spot the same file under another name. */
  prev?: BlobHash;
}

interface ClientState {
  v: 1;
  /** The server vault this state belongs to; versions and the cursor mean nothing on another. */
  vault?: string;
  cursor: Seq;
  /**
   * The change at the cursor, as `markOf` prints it. Each pull reads it again:
   * a server restored from a backup of its own data keeps its vault id, but
   * no longer has this change (or has another one at its seq).
   */
  mark?: string;
  files: Record<string, BaseEntry>;
  /**
   * Newer server states not applied because the local file held unsynced
   * content. Usually the push that follows supersedes them, but if that
   * content goes away first (deleted, reverted) they still have to land.
   */
  pending: Record<string, PathState>;
}

export interface PassReport {
  /** Local files written, renamed or deleted to match the server. */
  applied: number;
  /** Ops sent to the server. */
  pushed: number;
  /** Conflict copies the server created for this device's edits. */
  conflicts: string[];
  rejected: { op: Op; reason: string }[];
}

const OPS_BATCH = 100;
/** Blob transfers in flight at once. One at a time, a first sync is bound by round trips (and on iOS by cellular latency). */
const TRANSFERS = 8;
/** Remote states whose blobs are fetched ahead of applying them, which bounds the memory the prefetch holds. */
const PREFETCH_WINDOW = 64;
/** Filesystem timestamps are coarse (ext4: a few ms; FAT: 2 s), so a stat this recent may hide an edit. */
const RACY_MS = 2000;
/** A pass that finds no notes at all where at least this many were synced refuses to delete them (an unmounted or emptied folder). */
const MASS_DELETE = 10;

interface Planned {
  op: Op;
  /** Put: the content sent. */
  bytes?: Uint8Array;
  /** Content now at the op's destination on disk, which the server keeps safe if it accepts the op. */
  ack?: { key: string; hash: BlobHash };
}

export class SyncEngine {
  private state: ClientState;
  /** Per key, local content the server has acknowledged keeping, so it may be overwritten. */
  private readonly acked = new Map<string, Set<BlobHash>>();
  /** Local names per key from the last listing; a case-sensitive disk may hold several. */
  private names = new Map<string, string[]>();
  private readonly hash: (bytes: Uint8Array) => Promise<BlobHash>;
  /** Blobs fetched ahead for the states being applied. Only a cache: each apply still checks the local file first. */
  private prefetched = new Map<BlobHash, Uint8Array>();

  private constructor(
    private readonly deps: EngineDeps,
    state: ClientState,
  ) {
    this.state = state;
    this.hash = deps.hash ?? sha256Hex;
  }

  /** Loads saved state; missing or corrupt state starts fresh and is rebuilt from the server. */
  static async open(deps: EngineDeps): Promise<SyncEngine> {
    return new SyncEngine(deps, parseState(await deps.store.load()));
  }

  get cursor(): Seq {
    return this.state.cursor;
  }

  /** One full pass. Rejects if the server is unreachable; progress so far is kept. */
  async sync(): Promise<PassReport> {
    const report: PassReport = { applied: 0, pushed: 0, conflicts: [], rejected: [] };
    await this.pull(report);
    const planned = await this.plan();
    if (planned.length > 0) {
      await this.push(planned, report);
      await this.pull(report);
    }
    return report;
  }

  // ---- pull ----

  private async pull(report: PassReport): Promise<void> {
    if (this.state.cursor === 0 && Object.keys(this.state.files).length === 0) {
      // First sync, or state was lost: start from the server's current files.
      // They supersede anything pending, including keys they no longer list.
      const st = await this.deps.remote.state();
      this.state.pending = {};
      if (st.vault !== undefined) this.state.vault = st.vault;
      const states: PathState[] = st.files.map((f) => ({ path: f.path, version: f.version, hash: f.hash }));
      await this.applyAll(states, (s) => s, (s) => this.applyRemote(s, report));
      this.state.cursor = st.seq;
    } else {
      // The first page of a pull starts one change early, to check the change at the cursor.
      let verify = this.state.mark !== undefined && this.state.cursor > 0;
      for (;;) {
        const known = verify;
        verify = false;
        const page = await this.deps.remote.changes(known ? this.state.cursor - 1 : this.state.cursor);
        let changes = page.changes;
        let other = (page.vault !== undefined && this.state.vault !== undefined && page.vault !== this.state.vault) || page.seq < this.state.cursor;
        if (known && !other) {
          if (changes[0]?.seq === this.state.cursor && markOf(changes[0]) === this.state.mark) changes = changes.slice(1);
          else other = true;
        }
        if (other) {
          // Another server, or this one restored from a backup: its versions are not the ones this
          // state recorded, and a stale base could delete newer work. Start over as if the state
          // were lost; local files are kept and compared with the server's.
          this.deps.log?.(`server ${page.vault ?? "?"} at seq ${page.seq} is not the one this state was synced with (${this.state.vault ?? "?"} at ${this.state.cursor}); resyncing from scratch`);
          this.state = { v: 1, cursor: 0, files: {}, pending: {} };
          this.acked.clear();
          return this.pull(report);
        }
        if (page.vault !== undefined) this.state.vault = page.vault;
        await this.applyAll(changes, (c) => ({ path: c.path, version: c.seq, hash: c.hash }), async (c) => {
          await this.applyChange(c, report);
          this.state.cursor = c.seq;
          this.state.mark = markOf(c);
        });
        await this.save();
        if (page.changes.length === 0 || this.state.cursor >= page.seq) break;
      }
    }
    for (const s of Object.values(this.state.pending)) await this.applyRemote(s, report);
    await this.save();
  }

  /**
   * Applies states in order, a window at a time, fetching the blobs each
   * window needs concurrently first. A blob is fetched only if the local file
   * does not already hold that content, as tryApply would decide.
   */
  private async applyAll<T>(items: readonly T[], state: (item: T) => PathState, apply: (item: T) => Promise<void>): Promise<void> {
    for (let i = 0; i < items.length; i += PREFETCH_WINDOW) {
      const window = items.slice(i, i + PREFETCH_WINDOW);
      const wanted = new Set<BlobHash>();
      for (const s of window.map(state)) {
        if (s.hash === null || this.prefetched.has(s.hash) || !this.isNewer(pathKey(s.path), s.version)) continue;
        const base = this.state.files[pathKey(s.path)];
        const local = await this.findLocal(pathKey(s.path), base ? [s.path, base.path] : [s.path]);
        if (!local || (await this.readHash(local.path)) !== s.hash) wanted.add(s.hash);
      }
      this.prefetched = new Map();
      await mapLimit([...wanted], TRANSFERS, async (h) => {
        this.prefetched.set(h, await this.deps.remote.getBlob(h));
      });
      try {
        for (const s of window) await apply(s);
      } finally {
        this.prefetched = new Map();
      }
    }
  }

  private async applyChange(c: Change, report: PassReport): Promise<void> {
    if (c.op !== "move" || c.from === undefined) {
      await this.applyRemote({ path: c.path, version: c.seq, hash: c.hash }, report);
      return;
    }
    const fromKey = pathKey(c.from);
    const toKey = pathKey(c.path);
    if (fromKey !== toKey && c.hash !== null) await this.tryRename(fromKey, c, report);
    await this.applyRemote({ path: c.path, version: c.seq, hash: c.hash }, report);
    if (fromKey !== toKey) await this.applyRemote({ path: c.from, version: c.seq, hash: null }, report);
  }

  /** Follows a remote move with a local rename when the note is unchanged here, so open editors keep it. */
  private async tryRename(fromKey: string, c: Change, report: PassReport): Promise<void> {
    const toKey = pathKey(c.path);
    if (!this.isNewer(fromKey, c.seq) || !this.isNewer(toKey, c.seq)) return;
    const src = await this.findLocal(fromKey, [c.from!]);
    if (!src || (await this.findLocal(toKey, [c.path]))) return;
    const h = await this.readHash(src.path);
    if (h === null || h !== c.hash || !this.safe(fromKey, h)) return;
    if (await this.renameLocal(src.path, c.path)) report.applied++;
  }

  /**
   * Makes the local file for `s`'s key match the server, unless the local
   * file holds content the server does not have yet; then `s` is kept as
   * pending and retried on every pull.
   */
  private async applyRemote(s: PathState, report: PassReport): Promise<void> {
    const key = pathKey(s.path);
    const pending = this.state.pending[key];
    let applied: boolean;
    try {
      applied = await this.tryApply(s, report);
    } catch (e) {
      if (!(e instanceof LocalBusyError)) throw e;
      this.deps.log?.(`waiting: ${e.message}`);
      applied = false;
    }
    if (applied) {
      if (pending && pending.version <= s.version) delete this.state.pending[key];
    } else if (!pending || pending.version < s.version) {
      this.state.pending[key] = s;
    }
  }

  /** Returns whether the key now reflects `s` (or something newer). */
  private async tryApply(s: PathState, report: PassReport): Promise<boolean> {
    const key = pathKey(s.path);
    if (!this.isNewer(key, s.version)) return true;
    const base = this.state.files[key];
    const hints = base ? [s.path, base.path] : [s.path];

    // Fetch first: no network wait may sit between checking the local file and replacing it.
    let bytes: Uint8Array | undefined;
    if (s.hash !== null) {
      const cur = await this.findLocal(key, hints);
      if (!cur || (await this.readHash(cur.path)) !== s.hash) bytes = await this.fetchBlob(s.hash);
    }

    if (s.hash === null) {
      // Every local name for the key goes, or none: a case twin left behind would come back as a new note.
      const all = await this.allLocal(key, hints);
      const hashes = await Promise.all(all.map((l) => this.readHash(l.path)));
      if (hashes.some((x) => x !== null && !this.safe(key, x))) return false;
      for (const l of all) {
        await this.deps.fs.remove(l.path);
        report.applied++;
      }
      const gone = base?.hash ? { prev: base.hash, ...(base.mtime !== undefined && { mtime: base.mtime }), ...(base.size !== undefined && { size: base.size }) } : {};
      this.setBase(key, s.version === 0 ? undefined : { path: s.path, version: s.version, hash: null, ...gone });
      return true;
    }
    const local = await this.findLocal(key, hints);
    const h = local ? await this.readHash(local.path) : null;
    if (h === s.hash && local) {
      if (local.path !== s.path) {
        if (!(await this.renameLocal(local.path, s.path))) return false;
        report.applied++;
      }
      const st = await this.deps.fs.stat(s.path);
      this.setBase(key, { path: s.path, version: s.version, hash: s.hash, ...(st && this.statCache(st)) });
      return true;
    }
    if (h !== null && !this.safe(key, h)) return false;
    if (!bytes) return false; // changed under us while fetching; the next pass sorts it out
    if (local && local.path !== s.path && !(await this.renameLocal(local.path, s.path))) return false;
    const st = await this.deps.fs.write(s.path, bytes);
    report.applied++;
    this.setBase(key, { path: s.path, version: s.version, hash: s.hash, ...this.statCache(st) });
    return true;
  }

  /** A stat to remember for a file, flagged racy when its mtime is too recent to vouch for its content. */
  private statCache(st: LocalStat): Pick<BaseEntry, "mtime" | "size" | "racy"> {
    return st.mtime > this.deps.now() - RACY_MS ? { mtime: st.mtime, size: st.size, racy: true } : { mtime: st.mtime, size: st.size };
  }

  private isNewer(key: string, version: Seq): boolean {
    const base = this.state.files[key];
    return !base || base.version < version;
  }

  /** Whether local content `h` at `key` may be replaced: the server already has it. */
  private safe(key: string, h: BlobHash): boolean {
    return h === this.state.files[key]?.hash || (this.acked.get(key)?.has(h) ?? false);
  }

  private setBase(key: string, entry: BaseEntry | undefined): void {
    if (entry) this.state.files[key] = entry;
    else delete this.state.files[key];
    this.acked.delete(key);
  }

  // ---- push ----

  /** Compares the folder with the synced base and lists the ops that send local changes up. */
  private async plan(): Promise<Planned[]> {
    await this.indexLocal();
    await this.separateCaseTwins();

    const locals = new Map<string, { path: string; hash: BlobHash; bytes?: Uint8Array }>();
    const tooLarge = new Set<string>();
    for (const [key, [path]] of this.names) {
      const st = await this.deps.fs.stat(path!);
      if (!st) continue;
      if (st.size > MAX_NOTE_BYTES) {
        // Not sent, but present: a synced note that outgrew the limit must not read as deleted.
        tooLarge.add(key);
        this.deps.log?.(`not syncing ${st.path}: over ${MAX_NOTE_BYTES} bytes`);
        continue;
      }
      const base = this.state.files[key];
      if (base?.hash && !base.racy && sameNoteName(base.path, st.path) && base.mtime === st.mtime && base.size === st.size) {
        locals.set(key, { path: st.path, hash: base.hash });
        continue;
      }
      const bytes = await this.deps.fs.read(st.path);
      if (!bytes) continue;
      const hash = await this.hash(bytes);
      locals.set(key, { path: st.path, hash, bytes });
      if (base?.hash === hash && sameNoteName(base.path, st.path)) {
        // Touched but unchanged: refresh the stat cache.
        delete base.racy;
        Object.assign(base, this.statCache(st));
      }
    }

    const planned: Planned[] = [];
    const created: string[] = [];
    for (const [key, l] of locals) {
      const base = this.state.files[key];
      if (!base?.hash) {
        created.push(key);
      } else {
        // A case-only rename; an edit made alongside it follows as a put, which the server merges onto the move.
        const renamed = !sameNoteName(l.path, base.path);
        if (renamed) planned.push({ op: { op: "move", from: base.path, to: l.path, baseVersion: base.version }, ...(l.hash === base.hash && { ack: { key, hash: l.hash } }) });
        if (l.hash !== base.hash) planned.push({ op: { op: "put", path: l.path, hash: l.hash, baseVersion: base.version }, bytes: l.bytes!, ack: { key, hash: l.hash } });
      }
    }
    const deleted = Object.entries(this.state.files)
      .filter(([key, b]) => b.hash !== null && !locals.has(key) && !tooLarge.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (this.names.size === 0 && deleted.length >= MASS_DELETE) {
      throw new Error(`the folder holds no notes but ${deleted.length} were synced; refusing to delete them all (is it unmounted or replaced?). Delete them in smaller steps if this is intended.`);
    }
    for (const [, base] of deleted) {
      // A note that vanished while an identical one appeared elsewhere was moved.
      const i = created.findIndex((k) => locals.get(k)!.hash === base.hash);
      if (i >= 0) {
        const to = locals.get(created[i]!)!;
        created.splice(i, 1);
        planned.push({ op: { op: "move", from: base.path, to: to.path, baseVersion: base.version }, ack: { key: pathKey(to.path), hash: base.hash! } });
      } else {
        planned.push({ op: { op: "delete", path: base.path, baseVersion: base.version } });
      }
    }
    for (const key of created) {
      const l = locals.get(key)!;
      if (await this.isLeftover(key, l.path, l.hash)) continue;
      const bytes = l.bytes ?? (await this.deps.fs.read(l.path));
      if (!bytes || (await this.hash(bytes)) !== l.hash) continue;
      const base = this.state.files[key];
      planned.push({ op: { op: "put", path: l.path, hash: l.hash, baseVersion: base?.version ?? null }, bytes, ack: { key, hash: l.hash } });
    }
    return planned;
  }

  /**
   * Whether a local file is the very file a remote delete removed, under a
   * name the engine could not see then (a case-only rename on a case-sensitive
   * disk, made while the delete was in flight). Same content and same stat
   * means it was renamed, not recreated, so the delete applies to it too.
   */
  private async isLeftover(key: string, path: string, hash: BlobHash): Promise<boolean> {
    const base = this.state.files[key];
    if (!base || base.hash !== null || base.prev !== hash || base.mtime === undefined) return false;
    const st = await this.deps.fs.stat(path);
    if (!st || st.mtime !== base.mtime || st.size !== base.size || (await this.readHash(st.path)) !== hash) return false;
    try {
      await this.deps.fs.remove(st.path);
    } catch (e) {
      if (!(e instanceof LocalBusyError)) throw e;
      // Open with typing: not sent this pass, looked at again next pass.
    }
    return true;
  }

  /**
   * A case-sensitive disk can hold "Note.md" and "note.md", which cannot
   * coexist on the server or on case-insensitive devices. Keep the synced
   * one; an extra the server already has is dropped, any other is renamed to
   * a conflict name and syncs as a new note.
   */
  private async separateCaseTwins(): Promise<void> {
    for (const [key, names] of this.names) {
      if (names.length < 2) continue;
      const base = this.state.files[key];
      const keep = names.find((n) => n === base?.path) ?? names[0]!;
      for (const name of names) {
        if (name === keep) continue;
        const h = await this.readHash(name);
        if (h === null) continue;
        if (this.acked.get(key)?.has(h) || h === base?.hash) {
          try {
            await this.deps.fs.remove(name);
          } catch (e) {
            if (!(e instanceof LocalBusyError)) throw e;
          }
        } else {
          const date = new Date(this.deps.now()).toISOString().slice(0, 10);
          const to = conflictCopyPath(name, date, this.deps.device, (k) => this.names.has(k) || k in this.state.files);
          if (!(await this.renameLocal(name, to))) continue;
          this.noteName(pathKey(to), to, true);
        }
      }
      this.names.set(key, [keep]);
    }
  }

  private async push(planned: Planned[], report: PassReport, retrying = false): Promise<void> {
    const puts = new Map<BlobHash, Uint8Array>();
    for (const p of planned) if (p.op.op === "put") puts.set(p.op.hash, p.bytes!);
    await mapLimit([...puts], TRANSFERS, async ([hash, bytes]) => {
      if (retrying || !(await this.deps.remote.hasBlob(hash))) await this.deps.remote.putBlob(hash, bytes);
    });
    const retry: Planned[] = [];
    for (let i = 0; i < planned.length; i += OPS_BATCH) {
      const batch = planned.slice(i, i + OPS_BATCH);
      const res = await this.deps.remote.ops(batch.map((p) => p.op));
      report.pushed += batch.length;
      for (const [j, r] of res.results.entries()) {
        const p = batch[j]!;
        this.deps.log?.(`${JSON.stringify(p.op)} -> ${JSON.stringify(r)}`);
        if (r.status === "rejected") {
          // hasBlob said yes but the server lacks it (a cache or proxy answered): upload regardless, once.
          if (r.reason === "missing blob" && p.op.op === "put" && !retrying) retry.push(p);
          else report.rejected.push({ op: p.op, reason: r.reason });
          continue;
        }
        const kept = p.op.op === "put" || (p.op.op === "move" && r.status === "accepted");
        if (kept && p.ack) {
          let set = this.acked.get(p.ack.key);
          if (!set) this.acked.set(p.ack.key, (set = new Set()));
          set.add(p.ack.hash);
        }
        if (r.conflictPath !== undefined) report.conflicts.push(r.conflictPath);
        for (const s of r.files) await this.applyRemote(s, report);
        if (p.op.op === "put" && p.ack) {
          // The server now holds exactly what was sent, but the file changed again during the round
          // trip, so applyRemote kept the old base. That content is the new base: a next put based
          // on the old one would have the server merge this device's two saves (or conflict them).
          const key = p.ack.key;
          const s = r.files.find((f) => pathKey(f.path) === key);
          if (s && s.hash === p.op.hash && this.isNewer(key, s.version)) {
            this.setBase(key, { path: s.path, version: s.version, hash: s.hash });
            if ((this.state.pending[key]?.version ?? Infinity) <= s.version) delete this.state.pending[key];
          }
        }
      }
      await this.save();
    }
    if (retry.length > 0) await this.push(retry, report, true);
  }

  // ---- local helpers ----

  private async indexLocal(): Promise<void> {
    const names = new Map<string, string[]>();
    for (const f of await this.deps.fs.list()) {
      if (!isSyncablePath(f.path)) continue;
      const key = pathKey(f.path);
      const list = names.get(key);
      if (list) list.push(f.path);
      else names.set(key, [f.path]);
    }
    for (const list of names.values()) list.sort();
    this.names = names;
  }

  private noteName(key: string, name: string, present: boolean): void {
    const list = (this.names.get(key) ?? []).filter((n) => n !== name);
    if (present) list.unshift(name);
    if (list.length > 0) this.names.set(key, list);
    else this.names.delete(key);
  }

  /** The local file for a key: the first hint that exists under that exact name, else any case variant. */
  private async findLocal(key: string, hints: readonly string[]): Promise<LocalStat | null> {
    const all = await this.allLocal(key, hints);
    for (const h of hints) {
      const l = all.find((x) => x.path === h);
      if (l) return l;
    }
    return all[0] ?? null;
  }

  /**
   * Renames a local file, unless `to` is already another file (a case twin
   * on a case-sensitive disk): then nothing moves and it returns false.
   */
  private async renameLocal(from: string, to: string): Promise<boolean> {
    const target = await this.deps.fs.stat(to);
    if (target && target.path !== from) return false;
    try {
      await this.deps.fs.rename(from, to);
    } catch (e) {
      if (!(e instanceof LocalBusyError)) throw e;
      this.deps.log?.(`waiting: ${e.message}`);
      return false;
    }
    return true;
  }

  /** Every local file for a key, looked up now (never from a listing that may be stale). */
  private async allLocal(key: string, hints: readonly string[]): Promise<LocalStat[]> {
    const found: LocalStat[] = [];
    for (const name of await this.deps.fs.variants(hints[0]!)) {
      const st = await this.deps.fs.stat(name);
      if (st && pathKey(st.path) === key && !found.some((f) => f.path === st.path)) found.push(st);
    }
    return found;
  }

  private async readHash(path: string): Promise<BlobHash | null> {
    const bytes = await this.deps.fs.read(path);
    return bytes ? this.hash(bytes) : null;
  }

  private async fetchBlob(hash: BlobHash): Promise<Uint8Array> {
    const bytes = this.prefetched.get(hash) ?? (await this.deps.remote.getBlob(hash));
    if ((await this.hash(bytes)) !== hash) throw new Error(`blob ${hash} failed verification`);
    return bytes;
  }

  private save(): Promise<void> {
    return this.deps.store.save(JSON.stringify(this.state));
  }
}

/** Runs `fn` over `items` with at most `limit` running at once; rejects with the first failure after all settle. */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (next < items.length && !failure) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}

/** What identifies a change across a restore: the same seq on a restored server is a different write. */
function markOf(c: Change): string {
  return `${c.seq} ${c.time} ${c.device} ${c.op} ${c.hash ?? "-"}`;
}

function parseState(json: string | null): ClientState {
  const fresh: ClientState = { v: 1, cursor: 0, files: {}, pending: {} };
  if (json === null) return fresh;
  try {
    const s = JSON.parse(json) as ClientState;
    if (s?.v !== 1 || typeof s.cursor !== "number" || typeof s.files !== "object" || s.files === null || typeof s.pending !== "object" || s.pending === null) return fresh;
    return s;
  } catch {
    return fresh;
  }
}
