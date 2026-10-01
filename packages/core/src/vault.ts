import { sha256Hex } from "./hash.ts";
import { mergeBytes } from "./merge.ts";
import { conflictCopyPath, invalidPathReason, MAX_NOTE_BYTES, pathKey } from "./paths.ts";
import type { BlobHash, Change, ChangesResponse, FileEntry, Op, OpResult, OpsResponse, OpStatus, PathState, Seq, StateResponse } from "./protocol.ts";

/**
 * The server's authoritative vault: current files, the append-only change log
 * and the blob store, with the write rules from the design doc ("Sync model").
 * Shared by the real server (SQLite store, M2) and the simulator (memory store).
 *
 * All writes go through one queue, so each op is a compare-and-swap against
 * the state left by the previous one. Each op's effects reach the store in a
 * single `commit`, which the SQLite store runs as one transaction: a crash
 * leaves every op either fully applied or not at all.
 */

/** A path key's row: a live file, or a tombstone (`hash: null`) once deleted or moved away. */
export interface FileRow {
  path: string;
  hash: BlobHash | null;
  size: number;
  mtime: number;
  version: Seq;
  /** On a tombstone left by a move: where the note went. */
  movedTo?: string;
}

/** Storage behind a Vault. Synchronous so the SQLite store can use bun:sqlite directly. */
export interface VaultStore {
  /** A random id fixed when the store was created. */
  vaultId(): string;
  seq(): Seq;
  row(key: string): FileRow | undefined;
  liveRows(): FileRow[];
  change(seq: Seq): Change | undefined;
  changesAfter(after: Seq, limit: number): Change[];
  /** Changes whose (destination) path has key `key`, with seq > after, in order. */
  changesOn(key: string, after: Seq): Change[];
  /** Whether a live note's key starts with `prefix` (a folder key ending in "/"). */
  hasLiveUnder(prefix: string): boolean;
  /** Whether `hash` was a version of, or was submitted for, `key` in a change with seq > after. */
  seenAfter(key: string, after: Seq, hash: BlobHash): boolean;
  hasBlob(hash: BlobHash): boolean;
  blob(hash: BlobHash): Uint8Array | undefined;
  putBlob(hash: BlobHash, bytes: Uint8Array): void;
  /** Atomically appends `changes` (consecutive seqs after seq()) and upserts `rows`. */
  commit(changes: Change[], rows: [string, FileRow][]): void;
}

export interface VaultDeps {
  now(): number;
  hash?(bytes: Uint8Array): Promise<BlobHash>;
}

export const CHANGES_PAGE = 1000;
/** Bound on following a note through successive moves. */
const MAX_MOVE_HOPS = 16;

export class Vault {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly hash: (bytes: Uint8Array) => Promise<BlobHash>;

  constructor(
    readonly store: VaultStore,
    private readonly deps: VaultDeps,
  ) {
    this.hash = deps.hash ?? sha256Hex;
  }

  state(): StateResponse {
    const files: FileEntry[] = this.store.liveRows().map((r) => ({ path: r.path, hash: r.hash!, size: r.size, mtime: r.mtime, version: r.version }));
    return { vault: this.store.vaultId(), seq: this.store.seq(), files };
  }

  changes(after: Seq, limit = CHANGES_PAGE): ChangesResponse {
    return { vault: this.store.vaultId(), changes: this.store.changesAfter(after, limit), seq: this.store.seq() };
  }

  hasBlob(hash: BlobHash): boolean {
    return this.store.hasBlob(hash);
  }

  blob(hash: BlobHash): Uint8Array | undefined {
    return this.store.blob(hash);
  }

  async putBlob(hash: BlobHash, bytes: Uint8Array): Promise<void> {
    if (bytes.length > MAX_NOTE_BYTES) throw new VaultError(413, "note too large");
    if ((await this.hash(bytes)) !== hash) throw new VaultError(400, "hash mismatch");
    if (!this.store.hasBlob(hash)) this.store.putBlob(hash, bytes);
  }

  /** Applies a batch of ops in order, one at a time, after any batch already queued. */
  applyOps(device: string, ops: readonly Op[]): Promise<OpsResponse> {
    const run = async () => {
      const results: OpResult[] = [];
      for (const op of ops) results.push(await this.applyOp(device, op));
      return { results };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async applyOp(device: string, op: Op): Promise<OpResult> {
    const bad = op.op === "move" ? (invalidPathReason(op.from) ?? invalidPathReason(op.to)) : invalidPathReason(op.path);
    if (bad) return { status: "rejected", reason: bad };
    const clash = op.op === "delete" ? null : this.folderClash(op.op === "move" ? op.to : op.path);
    if (clash) return { status: "rejected", reason: clash };
    const tx = new Tx(this.store, device, this.deps.now());
    let result: OpResult;
    switch (op.op) {
      case "put":
        result = await this.put(tx, op.path, op.hash, op.baseVersion);
        break;
      case "delete":
        result = this.delete(tx, op.path, op.baseVersion);
        break;
      case "move":
        result = this.move(tx, op.from, op.to, op.baseVersion);
        break;
    }
    tx.commit();
    return result;
  }

  private async put(tx: Tx, path: string, hash: BlobHash, base: Seq | null): Promise<OpResult> {
    const bytes = this.store.blob(hash);
    if (!bytes) return { status: "rejected", reason: "missing blob" };
    const key = pathKey(path);
    const row = tx.row(key);
    const live = row?.hash != null ? row : undefined;

    if (live?.hash === hash) return tx.result("unchanged", [key]);
    if ((row?.version ?? null) === base) {
      tx.write(key, { op: "put", path: live?.path ?? path, hash, size: bytes.length, baseVersion: base });
      return tx.result("accepted", [key]);
    }
    // Base is stale. Follow the note if it was moved after the base, so the edit lands where it went.
    let target = key;
    const touched = [key];
    for (let hop = 0; hop < MAX_MOVE_HOPS; hop++) {
      const r = tx.row(target);
      if (!r || r.hash != null || r.movedTo === undefined || r.version <= (base ?? 0)) break;
      target = pathKey(r.movedTo);
      touched.push(target);
    }
    // Content the note has already seen since the base, here or where it moved, is a replay
    // (a retry after a lost response or a crash) or, with no base, a stale copy from a device
    // that lost its state: the server has it already.
    if (touched.some((k) => this.store.seenAfter(k, base ?? 0, hash))) return tx.result("unchanged", touched);

    const cur = tx.row(target);
    if (cur?.hash == null) {
      // Deleted after the base (or created fresh on a device that never saw it): the edit wins.
      tx.write(key, { op: "put", path, hash, size: bytes.length, baseVersion: base });
      return tx.result("accepted", touched);
    }

    const ancestor = this.contentAt(base, touched);
    const merged = mergeBytes(ancestor, this.store.blob(cur.hash)!, bytes);
    if (merged.clean) {
      const mergedHash = await this.hash(merged.bytes);
      if (!this.store.hasBlob(mergedHash)) this.store.putBlob(mergedHash, merged.bytes);
      tx.write(target, { op: "put", path: cur.path, hash: mergedHash, size: merged.bytes.length, baseVersion: base, submitted: hash });
      return tx.result("merged", touched);
    }
    const copy = tx.conflictCopy(path, hash, bytes.length);
    return tx.result("conflicted", [...touched, pathKey(copy)], copy);
  }

  private delete(tx: Tx, path: string, base: Seq): OpResult {
    const key = pathKey(path);
    const row = tx.row(key);
    if (row?.hash == null) return tx.result("unchanged", [key]);
    if (row.version !== base) return tx.result("superseded", [key]);
    tx.write(key, { op: "delete", path: row.path, hash: null, size: 0, baseVersion: base });
    return tx.result("accepted", [key]);
  }

  private move(tx: Tx, from: string, to: string, base: Seq): OpResult {
    const fromKey = pathKey(from);
    const toKey = pathKey(to);
    const src = tx.row(fromKey);
    if (src?.hash == null) return tx.result("unchanged", [fromKey, toKey]);
    if (fromKey === toKey) {
      if (src.path === to) return tx.result("unchanged", [fromKey]);
      tx.write(fromKey, { op: "move", from: src.path, path: to, hash: src.hash, size: src.size, baseVersion: base });
      return tx.result("accepted", [fromKey]);
    }
    // A stale base still moves: the rename is independent of any newer edit,
    // which travels with the note. A taken destination gets a conflict name.
    const dest = tx.row(toKey)?.hash != null ? conflictCopyPath(to, tx.date, tx.device, (k) => tx.row(k) !== undefined) : to;
    const destKey = pathKey(dest);
    tx.write(destKey, { op: "move", from: src.path, path: dest, hash: src.hash, size: src.size, baseVersion: base });
    tx.tombstone(fromKey, src.path, dest);
    return tx.result("accepted", dest === to ? [fromKey, toKey] : [fromKey, toKey, destKey]);
  }

  /**
   * Content of the note at version `base`, if that change belongs to one of
   * `keys` (the note's path, then each place it moved to) and the note now at
   * the end of that chain descends from it; else empty, so the edit merges
   * only if the two versions do not overlap at all, and is otherwise kept as
   * a conflict copy. A note deleted and created anew, a note created where
   * this one moved away, or another note moved in, is not a descendant:
   * merging against the old content would splice an edit into a stranger.
   */
  private contentAt(base: Seq | null, keys: readonly string[]): Uint8Array {
    if (base === null) return new Uint8Array();
    const c = this.store.change(base);
    if (!c?.hash || !keys.includes(pathKey(c.path))) return new Uint8Array();
    if (!this.descends(base, keys)) return new Uint8Array();
    return this.store.blob(c.hash) ?? new Uint8Array();
  }

  private descends(base: Seq, keys: readonly string[]): boolean {
    // The note sat at keys[i] from its move there (the tombstone it left at keys[i-1] has that
    // move's seq) until its move on to keys[i+1]; only changes in that window are its history.
    const arrived = keys.map((_, i) => (i === 0 ? base : (this.store.row(keys[i - 1]!)?.version ?? base)));
    for (const [i, k] of keys.entries()) {
      const left = arrived[i + 1] ?? Infinity;
      for (const c of this.store.changesOn(k, arrived[i]!)) {
        if (c.seq >= left) break;
        if (c.op === "delete") return false;
        if (c.op === "move" && pathKey(c.from!) !== k) return false;
        if (c.op === "put" && c.baseVersion !== null) {
          // Accepted onto an empty path: the key held no note when this was written.
          const prev = this.store.change(c.baseVersion);
          if (prev && ((prev.op === "delete" && pathKey(prev.path) === k) || (prev.op === "move" && pathKey(prev.from!) === k && pathKey(prev.path) !== k))) return false;
        }
      }
    }
    return true;
  }

  /** Why `path` cannot hold a note because a note and a folder would share a name, or null. */
  private folderClash(path: string): string | null {
    const key = pathKey(path);
    for (let i = key.indexOf("/"); i !== -1; i = key.indexOf("/", i + 1)) {
      if (this.store.row(key.slice(0, i))?.hash != null) return `folder ${path.slice(0, i)} is a note`;
    }
    return this.store.hasLiveUnder(`${key}/`) ? "a folder has this name" : null;
  }
}

export class VaultError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Pending effects of one op, committed together. */
class Tx {
  private readonly changes: Change[] = [];
  private readonly rows = new Map<string, FileRow>();
  readonly date: string;

  constructor(
    private readonly store: VaultStore,
    readonly device: string,
    private readonly time: number,
  ) {
    this.date = new Date(time).toISOString().slice(0, 10);
  }

  row(key: string): FileRow | undefined {
    return this.rows.get(key) ?? this.store.row(key);
  }

  write(key: string, c: Omit<Change, "seq" | "device" | "time"> & { size: number }): void {
    const { size, ...rest } = c;
    const seq = this.store.seq() + this.changes.length + 1;
    const change: Change = { seq, ...rest, device: this.device, time: this.time };
    this.changes.push(change);
    this.rows.set(key, { path: c.path, hash: c.hash, size, mtime: this.time, version: seq });
  }

  /** The source row of a move, sharing the move's seq. */
  tombstone(key: string, path: string, movedTo: string): void {
    const seq = this.store.seq() + this.changes.length;
    this.rows.set(key, { path, hash: null, size: 0, mtime: this.time, version: seq, movedTo });
  }

  /** Saves a losing edit next to its note as a new file; returns its path. */
  conflictCopy(path: string, hash: BlobHash, size: number): string {
    const copy = conflictCopyPath(path, this.date, this.device, (k) => this.row(k) !== undefined);
    this.write(pathKey(copy), { op: "put", path: copy, hash, size, baseVersion: null, conflictOf: path });
    return copy;
  }

  result(status: OpStatus, keys: readonly string[], conflictPath?: string): OpResult {
    const files: PathState[] = [...new Set(keys)].map((k) => {
      const r = this.row(k);
      return r ? { path: r.path, version: r.version, hash: r.hash } : { path: k, version: 0, hash: null };
    });
    return conflictPath === undefined ? { status, files } : { status, files, conflictPath };
  }

  commit(): void {
    if (this.changes.length > 0 || this.rows.size > 0) this.store.commit(this.changes, [...this.rows]);
  }
}

/** In-memory VaultStore for tests and the simulator. */
export class MemoryVaultStore implements VaultStore {
  constructor(private readonly id = "memory") {}

  private readonly log: Change[] = [];
  private readonly rows = new Map<string, FileRow>();
  private readonly seen = new Map<string, { seq: Seq; hash: BlobHash }[]>();
  private readonly blobs = new Map<BlobHash, Uint8Array>();

  vaultId(): string {
    return this.id;
  }

  seq(): Seq {
    return this.log.length;
  }

  row(key: string): FileRow | undefined {
    const r = this.rows.get(key);
    return r && { ...r };
  }

  liveRows(): FileRow[] {
    return [...this.rows.values()].filter((r) => r.hash !== null).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  change(seq: Seq): Change | undefined {
    return this.log[seq - 1];
  }

  changesAfter(after: Seq, limit: number): Change[] {
    return this.log.slice(after, after + limit);
  }

  changesOn(key: string, after: Seq): Change[] {
    return this.log.slice(after).filter((c) => pathKey(c.path) === key);
  }

  hasLiveUnder(prefix: string): boolean {
    for (const [key, r] of this.rows) if (r.hash !== null && key.startsWith(prefix)) return true;
    return false;
  }

  seenAfter(key: string, after: Seq, hash: BlobHash): boolean {
    return (this.seen.get(key) ?? []).some((s) => s.seq > after && s.hash === hash);
  }

  hasBlob(hash: BlobHash): boolean {
    return this.blobs.has(hash);
  }

  blob(hash: BlobHash): Uint8Array | undefined {
    return this.blobs.get(hash);
  }

  putBlob(hash: BlobHash, bytes: Uint8Array): void {
    this.blobs.set(hash, bytes);
  }

  commit(changes: Change[], rows: [string, FileRow][]): void {
    for (const c of changes) {
      if (c.seq !== this.log.length + 1) throw new Error(`non-consecutive seq ${c.seq}`);
      this.log.push(c);
      const note = (path: string, hash: BlobHash | null | undefined) => {
        if (!hash) return;
        const key = pathKey(path);
        let list = this.seen.get(key);
        if (!list) this.seen.set(key, (list = []));
        list.push({ seq: c.seq, hash });
      };
      note(c.path, c.hash);
      note(c.path, c.submitted);
      if (c.conflictOf !== undefined) note(c.conflictOf, c.hash);
    }
    for (const [key, row] of rows) this.rows.set(key, { ...row });
  }

  /** Every change, for invariant checks. */
  allChanges(): readonly Change[] {
    return this.log;
  }
}
