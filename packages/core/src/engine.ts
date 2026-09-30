import { sha256Hex } from "./hash.ts";
import { conflictCopyPath, isSyncablePath, MAX_NOTE_BYTES, pathKey } from "./paths.ts";
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

/** A vault folder. Writes are atomic (temp file + rename) and create parent folders. */
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
  /** On a deleted entry: the content the delete removed here, to spot the same file under another name. */
  prev?: BlobHash;
}

interface ClientState {
  v: 1;
  cursor: Seq;
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
      for (const f of st.files) await this.applyRemote({ path: f.path, version: f.version, hash: f.hash }, report);
      this.state.cursor = st.seq;
    } else {
      for (;;) {
        const page = await this.deps.remote.changes(this.state.cursor);
        for (const c of page.changes) {
          await this.applyChange(c, report);
          this.state.cursor = c.seq;
        }
        await this.save();
        if (page.changes.length === 0 || this.state.cursor >= page.seq) break;
      }
    }
    for (const s of Object.values(this.state.pending)) await this.applyRemote(s, report);
    await this.save();
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
    if (await this.tryApply(s, report)) {
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
      this.setBase(key, { path: s.path, version: s.version, hash: s.hash, ...(st && { mtime: st.mtime, size: st.size }) });
      return true;
    }
    if (h !== null && !this.safe(key, h)) return false;
    if (!bytes) return false; // changed under us while fetching; the next pass sorts it out
    if (local && local.path !== s.path && !(await this.renameLocal(local.path, s.path))) return false;
    const st = await this.deps.fs.write(s.path, bytes);
    report.applied++;
    this.setBase(key, { path: s.path, version: s.version, hash: s.hash, mtime: st.mtime, size: st.size });
    return true;
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
    for (const [key, [path]] of this.names) {
      const st = await this.deps.fs.stat(path!);
      if (!st || st.size > MAX_NOTE_BYTES) continue;
      const base = this.state.files[key];
      if (base?.hash && base.path === st.path && base.mtime === st.mtime && base.size === st.size) {
        locals.set(key, { path: st.path, hash: base.hash });
        continue;
      }
      const bytes = await this.deps.fs.read(st.path);
      if (!bytes) continue;
      const hash = await this.hash(bytes);
      locals.set(key, { path: st.path, hash, bytes });
      if (base?.hash === hash && base.path === st.path) {
        // Touched but unchanged: refresh the stat cache.
        base.mtime = st.mtime;
        base.size = st.size;
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
        const renamed = l.path !== base.path;
        if (renamed) planned.push({ op: { op: "move", from: base.path, to: l.path, baseVersion: base.version }, ...(l.hash === base.hash && { ack: { key, hash: l.hash } }) });
        if (l.hash !== base.hash) planned.push({ op: { op: "put", path: l.path, hash: l.hash, baseVersion: base.version }, bytes: l.bytes!, ack: { key, hash: l.hash } });
      }
    }
    const deleted = Object.entries(this.state.files)
      .filter(([key, b]) => b.hash !== null && !locals.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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
    await this.deps.fs.remove(st.path);
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
          await this.deps.fs.remove(name);
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

  private async push(planned: Planned[], report: PassReport): Promise<void> {
    for (const p of planned) {
      if (p.op.op === "put" && !(await this.deps.remote.hasBlob(p.op.hash))) await this.deps.remote.putBlob(p.op.hash, p.bytes!);
    }
    for (let i = 0; i < planned.length; i += OPS_BATCH) {
      const batch = planned.slice(i, i + OPS_BATCH);
      const res = await this.deps.remote.ops(batch.map((p) => p.op));
      report.pushed += batch.length;
      for (const [j, r] of res.results.entries()) {
        const p = batch[j]!;
        this.deps.log?.(`${JSON.stringify(p.op)} -> ${JSON.stringify(r)}`);
        if (r.status === "rejected") {
          report.rejected.push({ op: p.op, reason: r.reason });
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
      }
      await this.save();
    }
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
    await this.deps.fs.rename(from, to);
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
    const bytes = await this.deps.remote.getBlob(hash);
    if ((await this.hash(bytes)) !== hash) throw new Error(`blob ${hash} failed verification`);
    return bytes;
  }

  private save(): Promise<void> {
    return this.deps.store.save(JSON.stringify(this.state));
  }
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
