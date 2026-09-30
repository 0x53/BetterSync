import { describe, expect, test } from "bun:test";
import { simulate, World, type SimConfig } from "../src/index.ts";

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

  test("a seed replays exactly", async () => {
    const run = async () => {
      const w = new World({ seed: BASE_SEED });
      const r = await w.run();
      return { stats: r.stats, log: w.store.allChanges().map((c) => `${c.seq} ${c.op} ${c.path} ${c.hash} ${c.device} ${c.time}`) };
    };
    expect(await run()).toEqual(await run());
  });
});
