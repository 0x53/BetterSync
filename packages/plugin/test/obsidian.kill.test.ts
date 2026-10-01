import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSyncablePath, pathKey, Rng, type Change } from "@bettersync/core";
import { checkObserved, type Clobber } from "@bettersync/sim";
import { ClientProc, damageState, Driver, notesIn, ServerProc } from "../../headless/test/harness.ts";
import { ObsidianApp, PLUGIN_ID } from "./obsidian-harness.ts";

/**
 * The M2 kill tests with a real Obsidian as one of the devices.
 *
 * Three headless daemons and a cron agent sync folders that a driver edits,
 * as in M2, while an Obsidian driver works in the vault the way a person
 * does: vault edits, renames (including case-only), deletes, and typing into
 * an open editor that Obsidian saves on its own schedule. Clients, the server
 * and Obsidian itself are SIGKILLed and restarted at random; the plugin's
 * state is sometimes deleted or corrupted first. Then everything must
 * converge, and the simulator's invariants must hold on the server's real
 * change log. Typed lines are checked separately: every line typed into an
 * editor must be in some version the server holds, unless Obsidian was
 * killed before it could save it.
 *
 * Opt-in, like the Obsidian end-to-end tests: OBSIDIAN_CDP, plus
 * OBSIDIAN_KILL and OBSIDIAN_START, shell commands that SIGKILL and start
 * Obsidian (with the test vault and --remote-debugging-port).
 * E2E_SECONDS, E2E_RUNS, BETTERSYNC_SEED and OBSIDIAN_SERVER_PORT/URL as in
 * the other end-to-end tests.
 */
const CDP = process.env.OBSIDIAN_CDP;
const KILL = process.env.OBSIDIAN_KILL;
const START = process.env.OBSIDIAN_START;
const PORT = Number(process.env.OBSIDIAN_SERVER_PORT ?? 8787);
const SERVER_URL = process.env.OBSIDIAN_SERVER_URL ?? `http://127.0.0.1:${PORT}`;
const SECONDS = Number(process.env.E2E_SECONDS ?? 30);
const RUNS = Number(process.env.E2E_RUNS ?? 1);
const BASE_SEED = Number(process.env.BETTERSYNC_SEED ?? 1);
/** Typing unsaved at a kill is lost with the editor; Obsidian saves within ~2 s and the plugin within ~5 s of typing. */
const UNSAVED_WINDOW_MS = 8000;

const dirs: string[] = [];
const procs: { kill(): void }[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
  if (process.env.E2E_KEEP !== "1") for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function sh(cmd: string): Promise<void> {
  const p = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd} exited ${code}: ${await new Response(p.stderr).text()}`);
}

const NAMES = ["Inbox.md", "Todo.md", "Ideas.md", "Journal.md", "Projects/Alpha.md", "Projects/Beta.md", "Daily/2026-09-30.md", "Notes/Émigré.md", "Notes/Long name with spaces.md", "Archive/Old.md"];
const LINES = ["", "---", "# Heading", "## Section", "- [ ] todo", "- [x] done", "- item", "> quote", "Some text here.", "émoji 🙂", "[[Link]]"];

/** Obsidian as a device: a person working in the vault, and the app being killed and restarted. */
class ObsidianClient {
  readonly device = "obsidian";
  app: ObsidianApp | null = null;
  /** Path → hash of what the user last saved there through the vault (not typed into an editor). */
  private readonly model = new Map<string, string>();
  /** The note open in the editor, whose content is the editor's business, not the model's. */
  private editing: string | null = null;
  readonly typed: { line: string; time: number }[] = [];
  readonly kills: number[] = [];
  /** What the driver did, for diagnosing a failure. */
  readonly actions: string[] = [];
  private uniq = 0;

  constructor(
    private readonly rng: Rng,
    private readonly clobbered: Clobber[],
    private readonly placed: { key: string; hash: string; time: number; moved: boolean }[],
  ) {}

  get running(): boolean {
    return this.app !== null;
  }

  async start(): Promise<void> {
    await sh(START!);
    this.app = await ObsidianApp.connect(CDP!);
    this.editing = null;
  }

  async kill(damage?: "delete" | "corrupt"): Promise<void> {
    if (damage && this.app) {
      await this.app
        .eval(
          async ({ id, damage }) => {
            const a = (globalThis as any).app.vault.adapter;
            const p = `${(globalThis as any).app.vault.configDir}/plugins/${id}/state.json`;
            if (damage === "delete") await a.remove(p).catch(() => {});
            else await a.write(p, "{corrupt");
          },
          { id: PLUGIN_ID, damage },
        )
        .catch(() => {});
    }
    await this.app?.close().catch(() => {});
    this.app = null;
    await sh(KILL!);
    this.kills.push(Date.now());
    this.actions.push(`${Date.now()} kill${damage ? ` (${damage} state)` : ""}`);
    this.editing = null;
  }

  /** The vault's syncable notes: path → sha256. */
  async files(): Promise<Map<string, string>> {
    const entries = await this.app!.eval(async () => {
      const app = (globalThis as any).app;
      const out: [string, string][] = [];
      for (const f of app.vault.getMarkdownFiles()) {
        const bytes = await app.vault.adapter.readBinary(f.path).catch(() => null);
        if (!bytes) continue;
        const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        out.push([f.path.normalize("NFC"), Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("")]);
      }
      return out;
    });
    return new Map(entries.filter(([p]) => isSyncablePath(p)));
  }

  private async hashOf(path: string): Promise<string | null> {
    return (await this.files()).get(path) ?? null;
  }

  /** Records a clobber if the note no longer holds what the user last saved there. */
  private async check(path: string): Promise<void> {
    const mine = this.model.get(pathKey(path));
    if (mine === undefined) return;
    const cur = await this.hashOf(path);
    if (cur !== mine) {
      this.clobbered.push({ device: this.device, path, hash: mine, time: Date.now() });
      this.actions.push(`${Date.now()} clobber ${path} ${mine.slice(0, 8)} now ${cur?.slice(0, 8)}`);
    }
    this.model.delete(pathKey(path));
  }

  async checkAll(): Promise<void> {
    const files = await this.files();
    for (const [key, mine] of this.model) {
      const path = [...files.keys()].find((p) => pathKey(p) === key);
      if ((path === undefined ? null : files.get(path)) !== mine) this.clobbered.push({ device: this.device, path: path ?? key, hash: mine, time: Date.now() });
    }
    this.model.clear();
  }

  private line(): string {
    return `obsidian wrote ${++this.uniq}`;
  }

  async act(): Promise<void> {
    const app = this.app!;
    const notes = [...(await this.files()).keys()].filter((p) => p !== this.editing).sort();
    const r = this.rng.next();
    if (r < 0.3) return this.type();
    if (notes.length === 0 || r < 0.42) {
      const path = this.rng.pick(NAMES);
      if (path === this.editing || notes.some((n) => pathKey(n) === pathKey(path) && n !== path)) return;
      await this.check(path);
      const text = await app.eval(
        async ({ path, extra }) => {
          const app = (globalThis as any).app;
          const f = app.vault.getAbstractFileByPath(path);
          if (f) {
            const t = (await app.vault.read(f)) + extra;
            await app.vault.modify(f, t);
            return t;
          }
          const dir = path.split("/").slice(0, -1).join("/");
          if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
          await app.vault.create(path, extra);
          return extra;
        },
        { path, extra: `${this.line()}\n${this.rng.pick(LINES)}\n` },
      );
      this.record(path, text, false);
      return;
    }
    const path = this.rng.pick(notes);
    if (r < 0.6) {
      await this.check(path);
      const text = await app.eval(
        async ({ path, line, at, drop }) => {
          const app = (globalThis as any).app;
          const f = app.vault.getAbstractFileByPath(path);
          if (!f) return null;
          const lines = (await app.vault.read(f)).split("\n");
          if (drop && lines.length > 2) lines.splice(Math.min(at, lines.length - 2), 1);
          lines.splice(Math.min(at, lines.length - 1), 0, line);
          const t = lines.join("\n");
          await app.vault.modify(f, t);
          return t;
        },
        { path, line: this.line(), at: this.rng.int(0, 8), drop: this.rng.chance(0.4) },
      );
      if (text !== null) this.record(path, text, false);
    } else if (r < 0.72) {
      await this.check(path);
      await app.eval((path) => {
        const app = (globalThis as any).app;
        const f = app.vault.getAbstractFileByPath(path);
        return f && app.vault.delete(f, true);
      }, path);
      this.actions.push(`${Date.now()} delete ${path}`);
    } else if (r < 0.88) {
      const caseOnly = this.rng.chance(0.3);
      const to = caseOnly ? flipCase(this.rng, path) : this.rng.pick(NAMES);
      if (to === path || (!caseOnly && notes.some((n) => pathKey(n) === pathKey(to)))) return;
      await this.check(path);
      await this.check(to);
      const moved = await app.eval(
        async ({ path, to }) => {
          const app = (globalThis as any).app;
          const f = app.vault.getAbstractFileByPath(path);
          if (!f || (app.vault.getAbstractFileByPath(to) && path.toLowerCase() !== to.toLowerCase())) return null;
          const dir = to.split("/").slice(0, -1).join("/");
          if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
          // vault.rename, not fileManager.renameFile: link updates would edit other notes behind the model's back.
          await app.vault.rename(f, to);
          return app.vault.read(app.vault.getAbstractFileByPath(to));
        },
        { path, to },
      );
      if (moved !== null) this.record(to, moved, pathKey(path) !== pathKey(to));
    } else {
      await app.eval(async (name) => {
        const a = (globalThis as any).app.vault.adapter;
        if (name.includes("/") && !(await a.exists(name.split("/")[0]))) await a.mkdir(name.split("/")[0]);
        await a.write(name, "junk\n");
      }, this.rng.pick(["image.png", "Projects/diagram.canvas", ".drafts/hidden.md"]));
    }
  }

  private record(path: string, text: string, moved: boolean): void {
    const h = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    this.actions.push(`${Date.now()} put ${path} ${h.slice(0, 8)}${moved ? " (moved in)" : ""}`);
    this.model.set(pathKey(path), h);
    this.placed.push({ key: pathKey(path), hash: h, time: Date.now(), moved });
  }

  /** Types a unique line into a note in the editor, and leaves the saving to Obsidian (and the plugin). */
  private async type(): Promise<void> {
    const app = this.app!;
    const files = [...(await this.files()).keys()].sort();
    if (files.length === 0) return;
    if (this.editing === null || !files.includes(this.editing) || this.rng.chance(0.2)) {
      const path = this.rng.pick(files);
      // Its content is now the editor's: stop tracking it in the model (checking what it holds first).
      await this.check(path);
      const ok = await app.eval(async (path) => {
        const app = (globalThis as any).app;
        const f = app.vault.getAbstractFileByPath(path);
        if (!f) return false;
        await app.workspace.getLeaf(false).openFile(f);
        return true;
      }, path);
      if (!ok) return;
      this.editing = path;
      this.actions.push(`${Date.now()} open ${path} in the editor`);
    }
    const line = this.line();
    const typed = await app.eval(
      ({ line, at }) => {
        const ed = (globalThis as any).app.workspace.activeEditor?.editor;
        if (!ed) return false;
        const n = Math.min(at, ed.lastLine());
        ed.replaceRange(`${line}\n`, { line: n, ch: 0 });
        return true;
      },
      { line, at: this.rng.int(0, 6) },
    );
    if (typed) {
      this.typed.push({ line, time: Date.now() });
      this.actions.push(`${Date.now()} type "${line}" into ${this.editing}`);
    }
  }
}

function flipCase(rng: Rng, path: string): string {
  const slash = path.lastIndexOf("/");
  const i = rng.int(slash + 1, path.length - 4);
  const ch = path[i]!;
  const flipped = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  return path.slice(0, i) + flipped + path.slice(i + 1);
}

async function run(seed: number) {
  const rng = new Rng(seed);
  const dir = mkdtempSync(join(tmpdir(), "bettersync-obsidian-kill-"));
  dirs.push(dir);
  const server = new ServerProc(join(dir, "data"), PORT);
  procs.push(server);
  await server.init();
  await server.start();

  const daemons = ["laptop", "desktop", "agent-1"].map((d) => new ClientProc(join(dir, d), d, server));
  const cron = new ClientProc(join(dir, "agent-2"), "agent-2", server);
  const all = [...daemons, cron];
  procs.push(...all);
  const driver = new Driver(rng);
  const obs = new ObsidianClient(rng, driver.clobbered, driver.placed);

  await obs.start();
  await obs.app!.reset();
  await obs.app!.installPlugin({ server: SERVER_URL, token: server.token, device: obs.device });
  for (const c of daemons) c.start();
  const stats = { clientKills: 0, serverKills: 0, obsidianKills: 0, lostState: 0, actions: 0, obsidianActions: 0, obsidianActionRaces: 0 };

  let chaos = true;
  const sleep = (min: number, max: number) => Bun.sleep(rng.int(min, max));
  // Obsidian is restarted by one loop at a time; others skip it meanwhile.
  let obsBusy: Promise<void> = Promise.resolve();
  const withObs = (fn: () => Promise<void>) => (obsBusy = obsBusy.then(fn, fn));

  const userLoop = (async () => {
    while (chaos) {
      driver.act(rng.pick(all));
      stats.actions++;
      await sleep(20, 250);
    }
  })();

  const obsLoop = (async () => {
    while (chaos) {
      await withObs(async () => {
        if (!obs.running) return;
        // A failed action is the driver racing the plugin (the note it picked just moved) or Obsidian
        // dying under the call; the plugin's own errors show up in its log, which is checked below.
        await obs.act().then(
          () => stats.obsidianActions++,
          () => stats.obsidianActionRaces++,
        );
      });
      await sleep(50, 400);
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
      if (r < 0.2) {
        const d = rng.next();
        const damage = d < 0.1 ? "delete" : d < 0.15 ? "corrupt" : undefined;
        if (damage) stats.lostState++;
        stats.obsidianKills++;
        await withObs(async () => {
          await obs.kill(damage);
          await sleep(200, 2000);
          await obs.start();
        });
      } else if (r < 0.6) {
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
  await Promise.all([userLoop, obsLoop, cronLoop, faultLoop]);
  await obsBusy;
  if (!server.running) await server.start();
  for (const c of daemons) if (!c.running) c.start();
  if (!obs.running) await obs.start();
  // Let Obsidian save the editor (the person stops typing), then close it so nothing stays unsaved.
  await obs.app!.eval(async () => {
    const app = (globalThis as any).app;
    for (const leaf of app.workspace.getLeavesOfType("markdown")) await leaf.view.save?.();
  });

  const deadline = Date.now() + 180_000;
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
    const views: [string, Map<string, string>][] = [...all.map((c) => [c.device, c.files()] as [string, Map<string, string>]), [obs.device, await obs.files()]];
    for (const [device, have] of views) {
      for (const [p, h] of want) if (have.get(p) !== h) diffs.push(`${device}: ${p} ${have.has(p) ? "differs" : "missing"}`);
      for (const p of have.keys()) if (!want.has(p)) diffs.push(`${device}: ${p} only local`);
    }
    if (diffs.length === 0 && Date.now() - stableSince >= 3000) break;
    if (Date.now() > deadline) throw new Error(`seed ${seed}: did not converge in 180 s:\n${diffs.slice(0, 20).join("\n")}\n${(await obs.app!.log()).slice(-30).join("\n")}`);
    await Bun.sleep(500);
  }

  driver.checkAll(all);
  await obs.checkAll();
  const changes = await server.allChanges();
  const st = await server.state();
  const violations = checkObserved({
    changes,
    rows: st.files,
    clients: [...all.map((c) => ({ device: c.device, files: notesIn(c.folder) })), { device: obs.device, files: await obs.files() }],
    clobbered: driver.clobbered,
    placed: driver.placed,
  });

  // Every typed line reached the server, unless Obsidian was killed before it could be saved.
  const history = await historyText(server, changes);
  const lostTyping = obs.typed.filter((t) => !history.has(t.line) && !obs.kills.some((k) => k >= t.time && k - t.time < UNSAVED_WINDOW_MS));

  const logs = [...server.logs, ...all.flatMap((c) => c.logs), ...(await obs.app!.log()).map((l) => `obsidian: ${l}`)];
  const rejected = logs.filter((l) => l.includes("rejected by the server"));
  const crashes = logs.filter((l) => /\b(TypeError|ReferenceError|RangeError|internal error)\b/.test(l));

  if (violations.length > 0 || lostTyping.length > 0) {
    // Everything known about the paths involved, for diagnosis.
    const keys = new Set([...violations.join("\n").matchAll(/replaced (.+?) \(/g)].map((m) => pathKey(m[1]!)));
    for (const t of lostTyping) {
      const typedInto = obs.actions.find((a) => a.includes(`"${t.line}"`))?.split(" into ")[1];
      if (typedInto) keys.add(pathKey(typedInto));
    }
    const about = (l: string) => [...keys].some((k) => l.toLowerCase().includes(k));
    console.log(`obsidian driver:\n${obs.actions.filter((a) => about(a) || a.includes("kill") || a.includes(" open ")).join("\n")}`);
    console.log(`server changes:\n${changes.filter((c) => keys.has(pathKey(c.path)) || (c.from && keys.has(pathKey(c.from)))).map((c) => `${c.seq} ${c.time} ${c.device} ${c.op} ${c.from ? `${c.from} -> ` : ""}${c.path} base=${c.baseVersion} ${c.hash?.slice(0, 8)} submitted=${c.submitted?.slice(0, 8)}`).join("\n")}`);
    console.log(`plugin log:\n${(await obs.app!.log()).filter(about).join("\n")}`);
  }
  for (const c of all) c.kill();
  server.kill();
  await obs.app!.reset();
  return {
    seed,
    stats: { ...stats, changes: changes.length, notes: st.files.length, typed: obs.typed.length, clobbers: driver.clobbered.length, conflicts: logs.filter((l) => l.includes("conflict:")).length },
    violations: [...violations, ...lostTyping.map((t) => `typed line lost: ${t.line}`), ...rejected, ...crashes],
  };
}

/** Every line of every version the server has held. */
async function historyText(server: ServerProc, changes: Change[]): Promise<Set<string>> {
  const lines = new Set<string>();
  const hashes = new Set(changes.flatMap((c) => [c.hash, c.submitted]).filter((h): h is string => typeof h === "string"));
  for (const h of hashes) {
    const r = await fetch(`${server.url}/v1/blobs/${h}`, { headers: { Authorization: `Bearer ${server.token}`, "X-Device-Name": "test" } });
    for (const l of (await r.text()).split("\n")) lines.add(l);
  }
  return lines;
}

describe.skipIf(!CDP || !KILL || !START)("kill tests with Obsidian", () => {
  test(`converges after random kills, Obsidian included (${RUNS} × ${SECONDS} s)`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const r = await run(BASE_SEED + i);
      console.log(`seed ${r.seed}: ${JSON.stringify(r.stats)}`);
      if (r.violations.length > 0) throw new Error(`seed ${r.seed} failed:\n${r.violations.slice(0, 20).join("\n")}`);
      expect(r.stats.changes).toBeGreaterThan(0);
    }
  }, RUNS * (SECONDS + 300) * 1000);
});
