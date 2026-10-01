import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSha256Hex, pathKey, type BlobHash, type Change, type ChangeOp, type FileRow, type Seq, type VaultStore } from "@bettersync/core";

/**
 * The server's VaultStore on disk (design doc, "Storage"):
 *
 *   <data>/bettersync.db       SQLite in WAL mode: file rows, change log, token
 *   <data>/blobs/ab/cd/<hash>  immutable note contents
 *
 * A blob is written and fsynced before any change that names it commits, and
 * each `commit` is one SQLite transaction, so a kill at any point leaves every
 * op fully applied or not at all. Only one process may write: `commit` checks
 * that the log still ends where this process thinks it does.
 */

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
CREATE TABLE files (
  key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  hash TEXT,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  version INTEGER NOT NULL,
  moved_to TEXT
) STRICT;
CREATE TABLE changes (
  seq INTEGER PRIMARY KEY,
  op TEXT NOT NULL,
  path TEXT NOT NULL,
  key TEXT NOT NULL,
  from_path TEXT,
  hash TEXT,
  base_version INTEGER,
  device TEXT NOT NULL,
  time INTEGER NOT NULL,
  submitted TEXT,
  conflict_of TEXT,
  conflict_key TEXT
) STRICT;
CREATE INDEX changes_key ON changes (key, seq);
CREATE INDEX changes_conflict ON changes (conflict_key, seq) WHERE conflict_key IS NOT NULL;
`;

interface FileRecord {
  path: string;
  hash: string | null;
  size: number;
  mtime: number;
  version: number;
  moved_to: string | null;
}

interface ChangeRecord {
  seq: number;
  op: string;
  path: string;
  from_path: string | null;
  hash: string | null;
  base_version: number | null;
  device: string;
  time: number;
  submitted: string | null;
  conflict_of: string | null;
}

const TMP_SUFFIX = ".tmp";
export const DB_FILE = "bettersync.db";
const VAULT_META = "vault_id";

export class SqliteVaultStore implements VaultStore {
  readonly db: Database;
  private readonly blobDir: string;
  private lastSeq: Seq;
  private readonly id: string;
  private readonly q;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.blobDir = join(dataDir, "blobs");
    mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(join(dataDir, DB_FILE), { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    // FULL: a commit acknowledged to a client survives power loss, not just a killed process.
    this.db.run("PRAGMA synchronous = FULL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.migrate();
    this.q = {
      seq: this.db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM changes"),
      row: this.db.query<FileRecord, [string]>("SELECT path, hash, size, mtime, version, moved_to FROM files WHERE key = ?"),
      live: this.db.query<FileRecord, []>("SELECT path, hash, size, mtime, version, moved_to FROM files WHERE hash IS NOT NULL"),
      change: this.db.query<ChangeRecord, [number]>("SELECT * FROM changes WHERE seq = ?"),
      after: this.db.query<ChangeRecord, [number, number]>("SELECT * FROM changes WHERE seq > ? ORDER BY seq LIMIT ?"),
      on: this.db.query<ChangeRecord, [string, number]>("SELECT * FROM changes WHERE key = ? AND seq > ? ORDER BY seq"),
      under: this.db.query<{ x: number }, [string, string]>("SELECT 1 AS x FROM files WHERE key >= ? AND key < ? AND hash IS NOT NULL LIMIT 1"),
      seen: this.db.query<{ x: number }, { key: string; after: number; hash: string }>(
        `SELECT 1 AS x FROM changes WHERE key = $key AND seq > $after AND (hash = $hash OR submitted = $hash)
         UNION ALL
         SELECT 1 AS x FROM changes WHERE conflict_key = $key AND seq > $after AND hash = $hash
         LIMIT 1`,
      ),
      insertChange: this.db.query(
        `INSERT INTO changes (seq, op, path, key, from_path, hash, base_version, device, time, submitted, conflict_of, conflict_key)
         VALUES ($seq, $op, $path, $key, $from_path, $hash, $base_version, $device, $time, $submitted, $conflict_of, $conflict_key)`,
      ),
      upsertFile: this.db.query(
        `INSERT INTO files (key, path, hash, size, mtime, version, moved_to) VALUES ($key, $path, $hash, $size, $mtime, $version, $moved_to)
         ON CONFLICT (key) DO UPDATE SET path = excluded.path, hash = excluded.hash, size = excluded.size,
           mtime = excluded.mtime, version = excluded.version, moved_to = excluded.moved_to`,
      ),
      getMeta: this.db.query<{ v: string }, [string]>("SELECT v FROM meta WHERE k = ?"),
      setMeta: this.db.query("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v"),
    };
    this.lastSeq = this.q.seq.get()?.seq ?? 0;
    this.id = this.getMeta(VAULT_META) ?? (this.setMeta(VAULT_META, crypto.randomUUID()), this.getMeta(VAULT_META)!);
  }

  private migrate(): void {
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (version === SCHEMA_VERSION) return;
    if (version !== 0) throw new Error(`database schema version ${version} is newer than this server (${SCHEMA_VERSION})`);
    this.db.transaction(() => {
      this.db.run(SCHEMA);
      this.db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  }

  close(): void {
    this.lock?.close();
    this.db.close();
  }

  private lock: Database | undefined;

  /**
   * Takes the data directory for this process alone, until close or exit: an
   * exclusive SQLite lock on `server.lock`, which the OS drops when the
   * process dies. False if another process holds it.
   */
  lockExclusive(): boolean {
    const db = new Database(join(this.dataDir, "server.lock"), { create: true });
    try {
      db.run("PRAGMA locking_mode = EXCLUSIVE");
      db.run("BEGIN EXCLUSIVE");
    } catch (e) {
      db.close();
      if ((e as { code?: string }).code?.startsWith("SQLITE_BUSY")) return false;
      throw e;
    }
    this.lock = db;
    return true;
  }

  // ---- VaultStore ----

  vaultId(): string {
    return this.id;
  }

  seq(): Seq {
    return this.lastSeq;
  }

  row(key: string): FileRow | undefined {
    const r = this.q.row.get(key);
    return r ? toRow(r) : undefined;
  }

  liveRows(): FileRow[] {
    return this.q.live
      .all()
      .map(toRow)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  change(seq: Seq): Change | undefined {
    const c = this.q.change.get(seq);
    return c ? toChange(c) : undefined;
  }

  changesAfter(after: Seq, limit: number): Change[] {
    return this.q.after.all(after, limit).map(toChange);
  }

  changesOn(key: string, after: Seq): Change[] {
    return this.q.on.all(key, after).map(toChange);
  }

  hasLiveUnder(prefix: string): boolean {
    // Keys under "a/" sort from "a/" up to "a0" ("0" follows "/").
    return this.q.under.get(prefix, `${prefix.slice(0, -1)}0`) !== null;
  }

  seenAfter(key: string, after: Seq, hash: BlobHash): boolean {
    return this.q.seen.get({ key, after, hash }) !== null;
  }

  hasBlob(hash: BlobHash): boolean {
    return existsSync(this.blobPath(hash));
  }

  blob(hash: BlobHash): Uint8Array | undefined {
    try {
      return new Uint8Array(readFileSync(this.blobPath(hash)));
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }

  /** Writes a blob durably: temp file, fsync, rename, fsync of the folder. The caller has checked the hash. */
  putBlob(hash: BlobHash, bytes: Uint8Array): void {
    const path = this.blobPath(hash);
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (!existsSync(dir)) {
      // New fan-out folders must be durable entries in their parents too, or a power cut can lose a committed blob.
      mkdirSync(dir, { recursive: true });
      fsyncDir(dirname(dir));
      fsyncDir(dirname(dirname(dir)));
    }
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}${TMP_SUFFIX}`;
    const fd = openSync(tmp, "wx");
    try {
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    fsyncDir(dir);
  }

  commit(changes: Change[], rows: [string, FileRow][]): void {
    this.db.transaction(() => {
      const last = this.q.seq.get()?.seq ?? 0;
      if (last !== this.lastSeq) throw new Error(`change log moved from ${this.lastSeq} to ${last} under this process: is another server running on this data directory?`);
      for (const [i, c] of changes.entries()) {
        if (c.seq !== last + 1 + i) throw new Error(`non-consecutive seq ${c.seq}`);
        this.q.insertChange.run({
          seq: c.seq,
          op: c.op,
          path: c.path,
          key: pathKey(c.path),
          from_path: c.from ?? null,
          hash: c.hash,
          base_version: c.baseVersion,
          device: c.device,
          time: c.time,
          submitted: c.submitted ?? null,
          conflict_of: c.conflictOf ?? null,
          conflict_key: c.conflictOf === undefined ? null : pathKey(c.conflictOf),
        });
      }
      for (const [key, r] of rows) {
        this.q.upsertFile.run({ key, path: r.path, hash: r.hash, size: r.size, mtime: r.mtime, version: r.version, moved_to: r.movedTo ?? null });
      }
    })();
    this.lastSeq += changes.length;
  }

  // ---- beyond VaultStore ----

  /** The whole change log, for the invariant checks in tests. */
  allChanges(): Change[] {
    return this.changesAfter(0, Number.MAX_SAFE_INTEGER);
  }

  getMeta(k: string): string | undefined {
    return this.q.getMeta.get(k)?.v;
  }

  setMeta(k: string, v: string): void {
    this.q.setMeta.run(k, v);
  }

  /** Removes temp files a killed server left in the blob store. */
  cleanTemp(): number {
    let n = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(TMP_SUFFIX)) {
          unlinkSync(p);
          n++;
        }
      }
    };
    walk(this.blobDir);
    return n;
  }

  private blobPath(hash: BlobHash): string {
    if (!isSha256Hex(hash)) throw new Error(`not a blob hash: ${hash}`);
    return join(this.blobDir, hash.slice(0, 2), hash.slice(2, 4), hash);
  }
}

function toRow(r: FileRecord): FileRow {
  const row: FileRow = { path: r.path, hash: r.hash, size: r.size, mtime: r.mtime, version: r.version };
  if (r.moved_to !== null) row.movedTo = r.moved_to;
  return row;
}

function toChange(r: ChangeRecord): Change {
  const c: Change = { seq: r.seq, op: r.op as ChangeOp, path: r.path, hash: r.hash, baseVersion: r.base_version, device: r.device, time: r.time };
  if (r.from_path !== null) c.from = r.from_path;
  if (r.submitted !== null) c.submitted = r.submitted;
  if (r.conflict_of !== null) c.conflictOf = r.conflict_of;
  return c;
}

/** Makes a rename in `dir` durable. Not possible on Windows, where it is skipped. */
export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // EISDIR / EPERM on platforms that cannot fsync a directory.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}
