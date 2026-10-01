import { describe, expect, test } from "bun:test";
import { simulate, type SimConfig } from "@bettersync/sim";
import { obsidianFs } from "./fake-vault.ts";

/**
 * The M1 simulator with the plugin's adapter: every device but the headless
 * agents runs ObsidianFs on a fake Obsidian vault, through the same edits,
 * renames, case changes, crashes, lost state and partitions, and the same
 * five invariants must hold.
 *
 * Replay a failure with BETTERSYNC_SEED=<seed> SIM_SEEDS=1 bun test packages/plugin.
 */
const SEEDS = Number(process.env.SIM_SEEDS ?? 100);
const BASE_SEED = Number(process.env.BETTERSYNC_SEED ?? 1);

const withPlugin: NonNullable<SimConfig["localFs"]> = ({ device, fs, view }) => (device.startsWith("agent") ? view : obsidianFs(fs, view).fs);

async function expectClean(config: SimConfig) {
  const r = await simulate({ localFs: withPlugin, ...config });
  if (r.violations.length > 0) {
    throw new Error(`seed ${config.seed} (${r.clients} clients) failed; replay with BETTERSYNC_SEED=${config.seed} SIM_SEEDS=1\n${r.violations.slice(0, 10).join("\n")}`);
  }
  return r;
}

describe("simulation with the Obsidian adapter", () => {
  test(`invariants hold over ${SEEDS} seeds`, async () => {
    let merges = 0;
    let conflicts = 0;
    for (let i = 0; i < SEEDS; i++) {
      const r = await expectClean({ seed: (BASE_SEED + i) >>> 0 });
      merges += r.stats.merges;
      conflicts += r.stats.conflicts;
    }
    if (SEEDS >= 20) {
      expect(merges).toBeGreaterThan(0);
      expect(conflicts).toBeGreaterThan(0);
    }
  }, 60 * 60 * 1000);

  test("scale: 3,000 notes, 5 devices and 2 agents", async () => {
    const r = await expectClean({ seed: BASE_SEED, clients: 7, agents: 2, initialNotes: 3000 });
    expect(r.stats.files).toBeGreaterThanOrEqual(3000);
  }, 60 * 60 * 1000);
});
