import { describe, expect, test } from "bun:test";
import type { Change } from "@bettersync/core";
import { checkObserved, simulate, World, type SimConfig } from "../src/index.ts";

/**
 * The M1 exit gate: "all 5 invariants hold in sim".
 *
 * Each seed runs 3–10 clients (a mix of case-sensitive and case-insensitive
 * disks, one a headless agent) through 30 s of random creates, edits,
 * deletes, renames and case-only renames, with client crashes (sometimes
 * losing their state file), server crashes, partitions, slow, reordered and
 * lost messages. Then faults stop, every client syncs until nothing changes,
 * and the invariants are checked.
 *
 * Replay a failure with BETTERSYNC_SEED=<seed> SIM_SEEDS=1 bun test packages/sim.
 */
const SEEDS = Number(process.env.SIM_SEEDS ?? 300);
const BASE_SEED = Number(process.env.BETTERSYNC_SEED ?? 1);
const TIMEOUT = 60 * 60 * 1000;

async function expectClean(config: SimConfig) {
  const r = await simulate(config);
  if (r.violations.length > 0) {
    throw new Error(`seed ${config.seed} (${r.clients} clients) failed; replay with BETTERSYNC_SEED=${config.seed} SIM_SEEDS=1\n${r.violations.slice(0, 10).join("\n")}`);
  }
  return r;
}

describe("simulation", () => {
  test(`invariants hold over ${SEEDS} seeds`, async () => {
    let merges = 0;
    let conflicts = 0;
    for (let i = 0; i < SEEDS; i++) {
      const r = await expectClean({ seed: (BASE_SEED + i) >>> 0 });
      merges += r.stats.merges;
      conflicts += r.stats.conflicts;
    }
    // The runs must actually exercise the interesting paths.
    if (SEEDS >= 20) {
      expect(merges).toBeGreaterThan(0);
      expect(conflicts).toBeGreaterThan(0);
    }
  }, TIMEOUT);

  test("scale: 3,000 notes, 5 devices and 2 agents", async () => {
    for (const seed of [BASE_SEED, BASE_SEED + 1]) {
      const r = await expectClean({ seed, clients: 7, agents: 2, initialNotes: 3000 });
      expect(r.stats.files).toBeGreaterThanOrEqual(3000);
    }
  }, TIMEOUT);

  test("without faults", async () => {
    for (let i = 0; i < Math.min(SEEDS, 50); i++) await expectClean({ seed: BASE_SEED + i, faults: false });
  }, TIMEOUT);

  test("seeds that once failed", async () => {
    // 922: a retried put that the server had merged into the note's new name was merged again.
    for (const seed of [922]) await expectClean({ seed });
  }, TIMEOUT);

  test("a seed replays exactly", async () => {
    const run = async () => {
      const w = new World({ seed: BASE_SEED });
      const r = await w.run();
      return { stats: r.stats, log: w.store.allChanges().map((c) => `${c.seq} ${c.op} ${c.path} ${c.hash} ${c.device} ${c.time}`) };
    };
    expect(await run()).toEqual(await run());
  });
});

describe("invariant checkers", () => {
  const ch = (seq: number, op: Change["op"], path: string, hash: string | null, baseVersion: number | null, extra: Partial<Change> = {}): Change => ({ seq, op, path, hash, baseVersion, device: "d", time: seq * 10, ...extra });
  const check = (changes: Change[], placed: { key: string; hash: string; time: number; moved: boolean }[] = []) => {
    const rows = new Map<string, { path: string; hash: string; version: number }>();
    for (const c of changes) {
      if (c.op === "move" && c.from) rows.delete(c.from.toLowerCase());
      if (c.hash === null) rows.delete(c.path.toLowerCase());
      else rows.set(c.path.toLowerCase(), { path: c.path, hash: c.hash, version: c.seq });
    }
    return checkObserved({ changes, rows: [...rows.values()], clients: [], clobbered: [], placed }).filter((v) => v.startsWith("resurrection"));
  };

  test("a renamed note brought back under its old name is a resurrection", () => {
    expect(check([ch(1, "put", "X.md", "h", null), ch(2, "move", "Y.md", "h", 1, { from: "X.md" }), ch(3, "put", "X.md", "h", null)])).toHaveLength(1);
    expect(check([ch(1, "put", "X.md", "h", null), ch(2, "delete", "X.md", null, 1), ch(3, "put", "X.md", "h", null)])).toHaveLength(1);
  });

  test("a user move long before the delete does not excuse a resurrection", () => {
    const log = [ch(1, "put", "K.md", "h", null), ch(2, "move", "J.md", "h", 1, { from: "K.md" }), ch(3, "move", "K.md", "h", 2, { from: "J.md" }), ch(4, "delete", "K.md", null, 3), ch(5, "put", "K.md", "h", null)];
    const early = [{ key: "j.md", hash: "h", time: 15, moved: true }, { key: "k.md", hash: "h", time: 25, moved: true }];
    expect(check(log, early)).toHaveLength(1);
    // A user move made after the version the delete was based on is concurrent with it: exempt.
    expect(check(log, [{ key: "j.md", hash: "h", time: 35, moved: true }])).toHaveLength(0);
  });
});
