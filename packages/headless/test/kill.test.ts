import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathKey, Rng, sameNoteName } from "@bettersync/core";
import { checkObserved } from "@bettersync/sim";
import { ClientProc, damageState, Driver, freePort, notesIn, ServerProc } from "./harness.ts";

/**
 * The M2 exit gate: "converges after kill tests".
 *
 * A real server and real headless clients, as separate processes on
 * localhost. Three daemons (`bettersync sync`) and one cron-style agent
 * (`bettersync once` in a loop) sync folders that a driver edits the way a
 * person or an agent does: in-place writes, editor-style temp-file saves,
 * creates, deletes, renames, case-only renames, and files that must not sync.
 * Meanwhile clients and the server are killed with SIGKILL at random and
 * restarted, and a killed client sometimes loses or corrupts its state file.
 *
 * Then faults and edits stop, and every folder must match the server, name
 * for name and byte for byte. The simulator's invariants are checked on the
 * server's real change log: no silent loss (every file content a client
 * replaced is in the server's history), no resurrection, no stale deletes.
 *
 * E2E_SECONDS sets the chaos phase (default 20), E2E_RUNS the number of runs
 * (default 1), BETTERSYNC_SEED the driver's seed; E2E_VERBOSE=1 echoes logs.
 * BETTERSYNC_CI_DIR puts the laptop's folder on a case-insensitive disk
 * (e.g. /mnt/c/... under WSL); folder case is then compared loosely, since
 * notes sharing a folder there share its case.
 */
const CI_DIR = process.env.BETTERSYNC_CI_DIR;
const SECONDS = Number(process.env.E2E_SECONDS ?? 20);
const RUNS = Number(process.env.E2E_RUNS ?? 1);
const BASE_SEED = Number(process.env.BETTERSYNC_SEED ?? 1);

const dirs: string[] = [];
const procs: { kill(): void }[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
  if (process.env.E2E_KEEP !== "1") for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function run(seed: number) {
  const rng = new Rng(seed);
  const dir = mkdtempSync(join(tmpdir(), "bettersync-kill-"));
  dirs.push(dir);
  const server = new ServerProc(join(dir, "data"), await freePort());
  procs.push(server);
  await server.init();
  await server.start();

  const folderFor = (d: string) => {
    if (d !== "laptop" || !CI_DIR) return join(dir, d);
    const f = mkdtempSync(join(CI_DIR, "bettersync-kill-"));
    dirs.push(f);
    return join(f, d);
  };
  const daemons = ["laptop", "desktop", "agent-1"].map((d) => new ClientProc(folderFor(d), d, server));
  const cron = new ClientProc(join(dir, "agent-2"), "agent-2", server);
  const all = [...daemons, cron];
  procs.push(...all);
  for (const c of daemons) c.start();
  const driver = new Driver(rng);
  const stats = { clientKills: 0, serverKills: 0, lostState: 0, actions: 0 };

  let chaos = true;
  const sleep = (min: number, max: number) => Bun.sleep(rng.int(min, max));

  const userLoop = (async () => {
    while (chaos) {
      driver.act(rng.pick(all));
      stats.actions++;
      await sleep(20, 250);
    }
  })();

  const cronLoop = (async () => {
    while (chaos) {
      if (!cron.running) await cron.once();
      await sleep(300, 1500);
    }
  })();

  const faultLoop = (async () => {
    while (chaos) {
      await sleep(800, 2500);
      if (!chaos) break;
      const r = rng.next();
      if (r < 0.55) {
        const c = rng.pick(all);
        c.kill();
        stats.clientKills++;
        const d = rng.next();
        if (d < 0.1) (damageState(c.folder, "delete"), stats.lostState++);
        else if (d < 0.15) (damageState(c.folder, "corrupt"), stats.lostState++);
        if (c !== cron) {
          await sleep(100, 1500);
          c.start();
        }
      } else if (r < 0.8) {
        server.kill();
        stats.serverKills++;
        await sleep(200, 1500);
        await server.start();
      }
    }
  })();

  await Bun.sleep(SECONDS * 1000);
  chaos = false;
  await Promise.all([userLoop, cronLoop, faultLoop]);
  if (!server.running) await server.start();
  for (const c of daemons) if (!c.running) c.start();

  // Quiet period: the cron agent runs `once` each round; done when every
  // folder matches the server and the log has not moved for 3 s.
  const deadline = Date.now() + 120_000;
  let lastSeq = -1;
  let stableSince = Date.now();
  let diffs: string[] = [];
  for (;;) {
    expect(await cron.once()).toBe(0);
    const st = await server.state();
    if (st.seq !== lastSeq) {
      lastSeq = st.seq;
      stableSince = Date.now();
    }
    const want = new Map(st.files.map((f) => [f.path, f.hash]));
    diffs = [];
    for (const c of all) {
      const have = loosen(c.files(), [...want.keys()]);
      for (const [p, h] of want) if (have.get(p) !== h) diffs.push(`${c.device}: ${p} ${have.has(p) ? "differs" : "missing"}`);
      for (const p of have.keys()) if (!want.has(p)) diffs.push(`${c.device}: ${p} only local`);
    }
    if (diffs.length === 0 && Date.now() - stableSince >= 3000) break;
    if (Date.now() > deadline) throw new Error(`seed ${seed}: did not converge in 120 s:\n${diffs.slice(0, 20).join("\n")}`);
    await Bun.sleep(500);
  }

  driver.checkAll(all);
  const changes = await server.allChanges();
  const st = await server.state();
  const violations = checkObserved({
    changes,
    rows: st.files,
    clients: all.map((c) => ({ device: c.device, files: notesIn(c.folder) })),
    clobbered: driver.clobbered,
    placed: driver.placed,
    looseFolders: CI_DIR !== undefined,
  });
  const logs = [...server.logs, ...all.flatMap((c) => c.logs)];
  const rejected = logs.filter((l) => l.includes("rejected by the server"));
  const crashes = logs.filter((l) => /\b(TypeError|ReferenceError|RangeError|internal error)\b/.test(l));

  for (const c of all) c.kill();
  server.kill();
  return { seed, stats: { ...stats, changes: changes.length, notes: st.files.length, clobbers: driver.clobbered.length, conflicts: logs.filter((l) => l.includes("conflict:")).length }, violations: [...violations, ...rejected, ...crashes] };
}

/** Under BETTERSYNC_CI_DIR, renames local notes to the server's name when only folder case differs. */
function loosen(files: Map<string, string>, server: string[]): Map<string, string> {
  if (!CI_DIR) return files;
  const byKey = new Map(server.map((p) => [pathKey(p), p]));
  return new Map([...files].map(([p, h]) => {
    const s = byKey.get(pathKey(p));
    return [s !== undefined && sameNoteName(s, p) ? s : p, h];
  }));
}

describe("kill tests", () => {
  test(`converges after random kills (${RUNS} × ${SECONDS} s)`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const r = await run(BASE_SEED + i);
      console.log(`seed ${r.seed}: ${JSON.stringify(r.stats)}`);
      if (r.violations.length > 0) throw new Error(`seed ${r.seed} failed:\n${r.violations.slice(0, 20).join("\n")}`);
      expect(r.stats.changes).toBeGreaterThan(0);
    }
  }, (RUNS * (SECONDS + 180)) * 1000);
});
