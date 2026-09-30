import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, Vault } from "@bettersync/core";
import { simulate } from "@bettersync/sim";
import { SqliteVaultStore } from "../src/store.ts";

/**
 * The simulator's seeds, run against the SQLite store instead of the memory
 * one. Every simulated server crash reopens the database from disk, so each
 * run also checks that what the store persists is exactly what the Vault
 * relies on.
 */
const SEEDS = Number(process.env.SIM_SEEDS ?? 40);
const BASE_SEED = Number(process.env.BETTERSYNC_SEED ?? 1);
const TIMEOUT = 60 * 60 * 1000;

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "bettersync-store-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const enc = new TextEncoder();

describe("SqliteVaultStore", () => {
  test(`simulator invariants hold over ${SEEDS} seeds, reopening the database on every server crash`, async () => {
    for (let i = 0; i < SEEDS; i++) {
      const seed = (BASE_SEED + i) >>> 0;
      const dir = tempDir();
      const r = await simulate({ seed, store: () => new SqliteVaultStore(dir) });
      if (r.violations.length > 0) throw new Error(`seed ${seed} failed; replay with BETTERSYNC_SEED=${seed} SIM_SEEDS=1\n${r.violations.slice(0, 10).join("\n")}`);
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test("gives the same change log as the memory store for the same seed", async () => {
    const dir = tempDir();
    let sqlite: SqliteVaultStore | undefined;
    const a = await simulate({ seed: BASE_SEED, store: () => (sqlite = new SqliteVaultStore(dir)) });
    const b = await simulate({ seed: BASE_SEED });
    expect(a.stats).toEqual(b.stats);
    const reopened = new SqliteVaultStore(dir);
    expect(reopened.seq()).toBe(a.stats.changes);
    reopened.close();
    void sqlite;
  }, TIMEOUT);

  test("persists rows, log and blobs across reopen", async () => {
    const dir = tempDir();
    const store = new SqliteVaultStore(dir);
    const vault = new Vault(store, { now: () => Date.UTC(2026, 8, 30) });
    const bytes = enc.encode("hello\n");
    const hash = await sha256Hex(bytes);
    await vault.putBlob(hash, bytes);
    const r = await vault.applyOps("laptop", [
      { op: "put", path: "A.md", hash, baseVersion: null },
      { op: "move", from: "A.md", to: "B/A.md", baseVersion: 1 },
    ]);
    expect(r.results.map((x) => x.status)).toEqual(["accepted", "accepted"]);
    store.close();

    const again = new SqliteVaultStore(dir);
    expect(again.seq()).toBe(2);
    expect(again.liveRows()).toEqual([{ path: "B/A.md", hash, size: 6, mtime: Date.UTC(2026, 8, 30), version: 2 }]);
    expect(again.row("a.md")).toEqual({ path: "A.md", hash: null, size: 0, mtime: Date.UTC(2026, 8, 30), version: 2, movedTo: "B/A.md" });
    expect(again.change(2)).toEqual({ seq: 2, op: "move", from: "A.md", path: "B/A.md", hash, baseVersion: 1, device: "laptop", time: Date.UTC(2026, 8, 30) });
    expect(again.blob(hash)).toEqual(bytes);
    expect(again.seenAfter("b/a.md", 0, hash)).toBe(true);
    expect(again.seenAfter("b/a.md", 2, hash)).toBe(false);
    again.close();
  });

  test("refuses to commit when another process moved the log", async () => {
    const dir = tempDir();
    const a = new SqliteVaultStore(dir);
    const b = new SqliteVaultStore(dir);
    const va = new Vault(a, { now: Date.now });
    const vb = new Vault(b, { now: Date.now });
    const bytes = enc.encode("x");
    const hash = await sha256Hex(bytes);
    await va.putBlob(hash, bytes);
    await va.applyOps("a", [{ op: "put", path: "A.md", hash, baseVersion: null }]);
    await expect(vb.applyOps("b", [{ op: "put", path: "B.md", hash, baseVersion: null }])).rejects.toThrow(/another server/);
    a.close();
    b.close();
  });

  test("a failed commit leaves nothing behind", () => {
    const dir = tempDir();
    const store = new SqliteVaultStore(dir);
    const change = { seq: 1, op: "put" as const, path: "A.md", hash: "a".repeat(64), baseVersion: null, device: "d", time: 1 };
    expect(() => store.commit([change, { ...change, seq: 3 }], [["a.md", { path: "A.md", hash: "a".repeat(64), size: 1, mtime: 1, version: 1 }]])).toThrow(/non-consecutive/);
    expect(store.seq()).toBe(0);
    expect(store.row("a.md")).toBeUndefined();
    expect(store.allChanges()).toEqual([]);
    store.close();
  });

  test("cleans temp files a killed server left in the blob store", () => {
    const dir = tempDir();
    const store = new SqliteVaultStore(dir);
    mkdirSync(join(dir, "blobs", "ab", "cd"), { recursive: true });
    writeFileSync(join(dir, "blobs", "ab", "cd", "abcd.123.x.tmp"), "partial");
    expect(store.cleanTemp()).toBe(1);
    store.close();
  });
});
