import { MemoryVaultStore, pathKey, Rng, SyncEngine, Vault, type Change, type LocalFs, type Op, type PassReport, type Remote, type VaultStore } from "@bettersync/core";
import { SimFs, type Clobber } from "./fs.ts";
import { hashAsync, hashSync } from "./hash.ts";
import { checkInvariants } from "./invariants.ts";
import { Scheduler } from "./scheduler.ts";

export interface SimConfig {
  seed: number;
  /** Number of clients; default 3–10 from the seed. */
  clients?: number;
  /** Virtual ms of user activity and faults before the quiet period. */
  duration?: number;
  /** How many of the clients are headless agents (case-sensitive disks). Default 1 when there are more than 3 clients. */
  agents?: number;
  /** Notes the first client starts with, for scale runs. */
  initialNotes?: number;
  /** Crashes, partitions, lost and slow messages. Default on. */
  faults?: boolean;
  /**
   * Opens the server's store. Called at start and again after every server
   * crash, so a persistent store (SQLite) is reopened from disk. Default: one
   * in-memory store that survives crashes.
   */
  store?: () => SimStore;
  /**
   * The LocalFs a client's engine sees, given its disk and the disk's
   * engine view. Called at every (re)start. Default: the engine view itself.
   * The plugin's tests put its Obsidian adapter here.
   */
  localFs?: (client: { device: string; fs: SimFs; view: LocalFs }) => LocalFs;
  log?: (message: string) => void;
}

/** A VaultStore the invariant checks can read the whole log from. */
export type SimStore = VaultStore & { allChanges(): readonly Change[]; close?(): void };

export interface SimResult {
  seed: number;
  clients: number;
  violations: string[];
  stats: { changes: number; ops: number; merges: number; conflicts: number; crashes: number; rounds: number; files: number };
}

/** Thrown by the simulated network; the engine treats it like any network failure. */
export class NetError extends Error {
  constructor(what = "network error") {
    super(what);
  }
}

const START = Date.UTC(2026, 8, 30, 9, 0, 0);

const NAMES = [
  "Inbox.md",
  "Todo.md",
  "Ideas.md",
  "Journal.md",
  "Projects/Alpha.md",
  "Projects/Beta.md",
  "Projects/Gamma notes.md",
  "Daily/2026-09-30.md",
  "Daily/2026-10-01.md",
  "Notes/Émigré.md",
  "Notes/Long name with spaces.md",
  "Archive/Old.md",
];
const JUNK = [".obsidian/app.json", ".obsidian/workspace.json", ".trash/Gone.md", "image.png", "Projects/diagram.canvas"];
const LINES = ["", "", "---", "# Heading", "## Section", "- [ ] todo", "- [x] done", "- item", "  - nested", "> quote", "Some text here.", "émoji 🙂", "[[Link]]", "crlf\r"];

interface SimClient {
  device: string;
  fs: SimFs;
  /** The engine's state file; survives crashes unless the sim loses it on purpose. */
  stateJson: string | null;
  epoch: number;
  online: boolean;
  engine?: SyncEngine | undefined;
  /** The current runner, for waiting on it to stop. */
  loop?: Promise<void> | undefined;
}

export class World {
  readonly sched = new Scheduler();
  readonly rng: Rng;
  store: SimStore;
  private readonly openStore: () => SimStore;
  vault: Vault;
  serverUp = true;
  serverEpoch = 0;
  readonly clients: SimClient[] = [];
  readonly clobbered: Clobber[] = [];
  /** Content a user put at a path key, by writing it there or moving it in from another key. */
  readonly placed: { key: string; hash: string; time: number; moved: boolean }[] = [];
  readonly violations: string[] = [];
  private faults: boolean;
  private stopping = false;
  private mtime = 0;
  private uniq = 0;
  private readonly stats = { changes: 0, ops: 0, merges: 0, conflicts: 0, crashes: 0, rounds: 0, files: 0 };

  constructor(readonly config: SimConfig) {
    this.rng = new Rng(config.seed);
    this.faults = config.faults ?? true;
    const memory = new MemoryVaultStore();
    this.openStore = config.store ?? (() => memory);
    this.store = this.openStore();
    this.vault = this.newVault();
    const n = config.clients ?? this.rng.int(3, 10);
    const agents = config.agents ?? (n > 3 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const device = i >= n - agents ? `agent-${i - (n - agents) + 1}` : `device-${i}`;
      // Headless agents run on Linux (case-sensitive); the rest are a mix.
      const caseInsensitive = device.startsWith("agent") ? false : this.rng.chance(0.7);
      this.clients.push({ device, fs: new SimFs(caseInsensitive, () => ++this.mtime), stateJson: null, epoch: 0, online: true });
    }
  }

  /** A server (re)start: reopen the store, then a fresh Vault with an empty queue. */
  private restartServer() {
    const old = this.store;
    this.store = this.openStore();
    if (old !== this.store) old.close?.();
    this.vault = this.newVault();
    this.serverUp = true;
  }

  private newVault() {
    return new Vault(this.store, { now: () => START + this.sched.now, hash: hashAsync });
  }

  async run(): Promise<SimResult> {
    const duration = this.config.duration ?? 30_000;
    const first = this.clients[0]!;
    for (let i = 0; i < (this.config.initialNotes ?? 0); i++) first.fs.userWrite(`Bulk/${i % 50}/Note ${i}.md`, this.text(first, this.rng.int(5, 40)));
    for (const c of this.clients) this.start(c);
    // Some clients start with notes of their own, like a first sync of existing vaults.
    for (const c of this.clients) if (this.rng.chance(0.3)) for (let i = this.rng.int(1, 4); i > 0; i--) this.userCreate(c);

    this.every(50, 500, duration, () => this.userAction());
    if (this.faults) this.every(300, 3000, duration, () => this.fault());
    await this.sched.runUntil(duration);

    const converged = await this.quiesce();
    if (converged) this.violations.push(...checkInvariants(this));
    this.stats.changes = this.store.seq();
    this.stats.files = this.store.liveRows().length;
    this.store.close?.();
    return { seed: this.config.seed, clients: this.clients.length, violations: this.violations, stats: this.stats };
  }

  private every(min: number, max: number, until: number, fn: () => void) {
    const tick = () => {
      if (this.sched.now > until) return;
      fn();
      this.sched.at(this.rng.int(min, max), tick);
    };
    this.sched.at(this.rng.int(min, max), tick);
  }

  // ---- clients ----

  private start(c: SimClient): Promise<void> {
    const epoch = c.epoch;
    const view = c.fs.engineView(c.device, this.clobbered, () => this.sched.now, this.config.log && ((m) => this.config.log!(`t=${this.sched.now} ${c.device}: ${m}`)));
    const opened = SyncEngine.open({
      fs: this.config.localFs ? this.config.localFs({ device: c.device, fs: c.fs, view }) : view,
      remote: this.remote(c),
      store: {
        load: async () => c.stateJson,
        save: async (json) => {
          if (c.epoch === epoch) c.stateJson = json;
        },
      },
      device: c.device,
      now: () => START + this.sched.now,
      hash: hashAsync,
      log: (m) => this.config.log?.(`t=${this.sched.now} ${c.device}: ${m}`),
    });
    return opened.then((engine) => {
      if (c.epoch !== epoch) return;
      c.engine = engine;
      c.loop = this.runLoop(c, epoch);
    });
  }

  private async runLoop(c: SimClient, epoch: number): Promise<void> {
    while (c.epoch === epoch && !this.stopping) {
      await this.pass(c);
      if (c.epoch !== epoch) return;
      await this.sched.sleep(this.rng.int(100, 1500));
    }
  }

  private async pass(c: SimClient): Promise<PassReport | null> {
    try {
      const r = await c.engine!.sync();
      this.stats.ops += r.pushed;
      this.stats.conflicts += r.conflicts.length;
      for (const x of r.rejected) this.violations.push(`${c.device}: server rejected ${JSON.stringify(x.op)}: ${x.reason}`);
      return r;
    } catch (e) {
      if (!(e instanceof NetError)) this.violations.push(`${c.device}: engine error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return null;
    }
  }

  private crash(c: SimClient) {
    this.config.log?.(`t=${this.sched.now} ${c.device}: crash`);
    this.stats.crashes++;
    c.epoch++;
    c.engine = undefined;
    c.loop = undefined;
    const r = this.rng.next();
    if (r < 0.1) c.stateJson = null;
    else if (r < 0.15) c.stateJson = "{corrupt";
    const epoch = c.epoch;
    this.sched.at(this.rng.int(100, 3000), () => c.epoch === epoch && void this.start(c));
  }

  /** The simulated network: each call is a request and a response, each delayed, either possibly lost. */
  private remote(c: SimClient): Remote {
    const call = <T>(fn: () => T | Promise<T>): Promise<T> => {
      const epoch = c.epoch;
      return new Promise<T>((resolve, reject) => {
        const fail = () => this.sched.at(this.delay(), () => c.epoch === epoch && reject(new NetError()));
        if (!c.online || this.lose()) return fail();
        this.sched.at(this.delay(), () => {
          if (!this.serverUp || !c.online) return fail();
          const serverEpoch = this.serverEpoch;
          Promise.resolve()
            .then(fn)
            .then(
              (v) => {
                if (this.lose()) return fail();
                this.sched.at(this.delay(), () => {
                  if (c.epoch !== epoch) return;
                  if (!c.online || this.serverEpoch !== serverEpoch) reject(new NetError());
                  else resolve(v);
                });
              },
              (e) => this.sched.at(this.delay(), () => c.epoch === epoch && reject(e instanceof Error ? new NetError(e.message) : e)),
            );
        });
      });
    };
    return {
      state: () => call(() => this.vault.state()),
      changes: (after) => call(() => this.vault.changes(after, this.rng.int(1, 50))),
      hasBlob: (hash) => call(() => this.vault.hasBlob(hash)),
      putBlob: (hash, bytes) => call(() => this.vault.putBlob(hash, bytes)),
      getBlob: (hash) =>
        call(() => {
          const b = this.vault.blob(hash);
          if (!b) throw new Error(`blob ${hash} not found`);
          return b;
        }),
      ops: (ops: Op[]) =>
        call(async () => {
          const res = await this.vault.applyOps(c.device, ops);
          this.stats.merges += res.results.filter((r) => r.status === "merged").length;
          return res;
        }),
    };
  }

  private delay() {
    if (!this.faults) return this.rng.int(1, 20);
    return this.rng.chance(0.05) ? this.rng.int(500, 3000) : this.rng.int(1, 150);
  }

  private lose() {
    return this.faults && this.rng.chance(0.03);
  }

  private fault() {
    const r = this.rng.next();
    if (r < 0.4) {
      this.crash(this.rng.pick(this.clients));
    } else if (r < 0.8) {
      const c = this.rng.pick(this.clients);
      c.online = false;
      this.sched.at(this.rng.int(500, 8000), () => (c.online = true));
    } else if (this.serverUp) {
      this.stats.crashes++;
      this.serverUp = false;
      this.serverEpoch++;
      this.sched.at(this.rng.int(200, 3000), () => this.restartServer());
    }
  }

  // ---- the quiet period ----

  /** Stops faults and activity, lets every runner finish, then syncs round-robin until nothing changes. */
  private async quiesce(): Promise<boolean> {
    this.faults = false;
    this.stopping = true;
    for (const c of this.clients) c.online = true;
    if (!this.serverUp) this.restartServer();
    for (const c of this.clients) {
      if (!c.engine) {
        c.epoch++;
        await this.sched.settle(this.start(c));
      }
    }
    await this.sched.settle(Promise.all(this.clients.map((c) => c.loop)));

    for (let round = 1; round <= 30; round++) {
      this.stats.rounds = round;
      const before = this.store.seq();
      let active = false;
      for (const c of this.clients) {
        const r = await this.sched.settle(this.pass(c));
        if (!r) {
          this.violations.push(`${c.device}: pass failed with faults off`);
          return false;
        }
        if (r.applied > 0 || r.pushed > 0) active = true;
      }
      if (!active && this.store.seq() === before) return true;
    }
    this.violations.push("did not converge within 30 quiet rounds");
    return false;
  }

  // ---- the user ----

  private write(c: SimClient, path: string, bytes: Uint8Array) {
    c.fs.userWrite(path, bytes);
    this.placed.push({ key: pathKey(path), hash: hashSync(bytes), time: START + this.sched.now, moved: false });
  }

  private rename(c: SimClient, from: string, to: string) {
    const e = c.fs.get(from);
    c.fs.userRename(from, to);
    if (e && pathKey(from) !== pathKey(to)) this.placed.push({ key: pathKey(to), hash: hashSync(e.bytes), time: START + this.sched.now, moved: true });
  }

  private note(c: SimClient, what: string) {
    this.config.log?.(`t=${this.sched.now} ${c.device}: user ${what}`);
  }

  private userAction() {
    const c = this.rng.pick(this.clients);
    const notes = [...c.fs.syncable().keys()].sort();
    const r = this.rng.next();
    if (notes.length === 0 || r < 0.2) return this.userCreate(c);
    const path = this.rng.pick(notes);
    if (r < 0.65) {
      this.note(c, `edit ${path}`);
      this.write(c, path, this.edit(c, c.fs.get(path)!.bytes));
    } else if (r < 0.75) {
      this.note(c, `delete ${path}`);
      c.fs.userRemove(path);
    } else if (r < 0.87) {
      const to = this.name();
      this.note(c, `rename ${path} -> ${to}`);
      this.rename(c, path, to);
    } else if (r < 0.93) {
      const to = flipCase(this.rng, path);
      this.note(c, `rename ${path} -> ${to}`);
      this.rename(c, path, to);
    } else if (r < 0.97) {
      this.write(c, this.rng.pick(JUNK), this.text(c, 3));
    } else {
      // An edit made through a different-case path, e.g. a script writing "todo.md".
      const via = flipCase(this.rng, path);
      this.note(c, `edit ${path} via ${via}`);
      this.write(c, via, this.edit(c, c.fs.get(path)!.bytes));
    }
  }

  private userCreate(c: SimClient) {
    const path = this.name();
    const old = c.fs.get(path);
    this.note(c, `create ${path}${old ? " (exists)" : ""}`);
    this.write(c, path, old ? this.edit(c, old.bytes) : this.text(c, this.rng.int(0, 12)));
  }

  private name() {
    const n = this.rng.pick(NAMES);
    return this.rng.chance(0.1) ? flipCase(this.rng, n) : n;
  }

  private unique(c: SimClient) {
    return `${c.device} wrote ${++this.uniq}`;
  }

  private text(c: SimClient, lines: number): Uint8Array {
    const out = Array.from({ length: lines }, () => this.rng.pick(LINES));
    out.splice(this.rng.int(0, out.length), 0, this.unique(c));
    return encode(out.join("\n") + (this.rng.chance(0.9) ? "\n" : ""));
  }

  /** A few line edits, always including one new unique line so no two writes are ever identical. */
  private edit(c: SimClient, bytes: Uint8Array): Uint8Array {
    const text = new TextDecoder().decode(bytes);
    const nl = text.endsWith("\n");
    const lines = text === "" ? [] : (nl ? text.slice(0, -1) : text).split("\n");
    for (let i = this.rng.int(0, 2); i > 0 && lines.length > 0; i--) {
      const at = this.rng.int(0, lines.length - 1);
      if (this.rng.chance(0.5)) lines.splice(at, 1);
      else lines[at] = this.rng.pick(LINES);
    }
    lines.splice(this.rng.int(0, lines.length), 0, this.unique(c));
    return encode(lines.join("\n") + (nl || this.rng.chance(0.1) ? "\n" : ""));
  }
}

const encoder = new TextEncoder();
const encode = (s: string) => encoder.encode(s);

function flipCase(rng: Rng, path: string): string {
  const slash = path.lastIndexOf("/");
  const i = rng.int(slash + 1, path.length - 4);
  const ch = path[i]!;
  const flipped = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  return path.slice(0, i) + flipped + path.slice(i + 1);
}

export async function simulate(config: SimConfig): Promise<SimResult> {
  return new World(config).run();
}
