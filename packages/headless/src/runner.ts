import { watch, type FSWatcher } from "node:fs";
import type { LiveMessage, PassReport, SyncEngine } from "@bettersync/core";
import { ConcurrentChangeError } from "./fs.ts";
import { HttpError, type HttpRemote } from "./remote.ts";

/**
 * Keeps a folder in sync (design doc, "Headless client"): a pass runs
 *
 * - about 1 s after local writes stop (native file watching; at most 5 s
 *   after the first write of a burst), to meet the 2 s end-to-end target;
 * - at once when the server announces a change on WS /v1/live, and when the
 *   live connection (re)opens, to catch up on anything missed;
 * - every minute regardless, which catches writes the watcher missed;
 * - after a failure, with backoff (1 s doubling to 60 s).
 *
 * Only one pass runs at a time; a trigger during a pass runs another after it.
 */
export interface RunnerOptions {
  engine: SyncEngine;
  remote: HttpRemote;
  folder: string;
  log(message: string): void;
  debounceMs?: number;
  maxWaitMs?: number;
  rescanMs?: number;
  /** Close the live connection if the server is silent this long (it pings every 25 s). */
  liveTimeoutMs?: number;
}

const IGNORED = /^(?:\.bettersync|\.obsidian|\.trash)(?:[\\/]|$)|(?:^|[\\/])\.bettersync-[0-9a-z]+\.tmp$/;

export class Runner {
  private stopped = false;
  private running: Promise<void> | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = Infinity;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private burstStart = 0;
  private failures = 0;
  private watcher: FSWatcher | undefined;
  private ws: WebSocket | undefined;
  private liveFailures = 0;
  private readonly intervals: ReturnType<typeof setInterval>[] = [];
  private idleWaiters: (() => void)[] = [];
  /** Passes completed without error, for tests and status. */
  passes = 0;

  constructor(private readonly o: RunnerOptions) {}

  start(): void {
    this.watchFolder();
    this.connectLive();
    this.intervals.push(setInterval(() => this.kick(0), this.o.rescanMs ?? 60_000));
    this.kick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.debounce);
    for (const i of this.intervals) clearInterval(i);
    this.watcher?.close();
    this.ws?.close();
    await this.running;
  }

  /** Resolves once no pass is running or scheduled. */
  idle(): Promise<void> {
    if (!this.running && this.timerAt === Infinity) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // ---- triggers ----

  private watchFolder(): void {
    if (this.stopped) return;
    try {
      this.watcher = watch(this.o.folder, { recursive: true }, (_event, name) => {
        if (name !== null && IGNORED.test(String(name))) return;
        this.localChange();
      });
      this.watcher.on("error", (e) => {
        this.o.log(`file watching failed (${e.message}); relying on the periodic rescan, retrying in 10 s`);
        this.watcher?.close();
        setTimeout(() => this.watchFolder(), 10_000);
      });
    } catch (e) {
      this.o.log(`file watching unavailable (${(e as Error).message}); relying on the periodic rescan`);
    }
  }

  private localChange(): void {
    const now = Date.now();
    if (this.debounce === undefined) this.burstStart = now;
    clearTimeout(this.debounce);
    const wait = Math.min(this.o.debounceMs ?? 1000, Math.max(0, this.burstStart + (this.o.maxWaitMs ?? 5000) - now));
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.kick(0);
    }, wait);
  }

  private connectLive(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = this.o.remote.live();
    } catch (e) {
      this.o.log(`live connection failed: ${(e as Error).message}`);
      setTimeout(() => this.connectLive(), backoff(this.liveFailures++, 30_000));
      return;
    }
    this.ws = ws;
    let last = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - last > (this.o.liveTimeoutMs ?? 70_000)) ws.close();
      else if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25_000);
    ws.onopen = () => {
      this.liveFailures = 0;
      last = Date.now();
      this.kick(0);
    };
    ws.onmessage = (m) => {
      last = Date.now();
      let msg: LiveMessage;
      try {
        msg = JSON.parse(String(m.data)) as LiveMessage;
      } catch {
        return;
      }
      if (msg.type === "change" && msg.change.seq > this.o.engine.cursor) this.kick(0);
    };
    ws.onclose = () => {
      clearInterval(heartbeat);
      if (this.stopped) return;
      setTimeout(() => this.connectLive(), backoff(this.liveFailures++, 30_000));
    };
  }

  // ---- passes ----

  /** Runs a pass in `delay` ms, unless one is already due sooner. */
  private kick(delay: number): void {
    if (this.stopped) return;
    if (this.running) {
      if (delay === 0) this.dirty = true;
      return;
    }
    const at = Date.now() + delay;
    if (at >= this.timerAt) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = Infinity;
      this.running = this.pass().then((retry) => {
        this.running = null;
        // After a failure the retry waits out its backoff, whatever arrived meanwhile.
        if (retry !== undefined) this.kick(retry);
        else if (this.dirty) this.kick(0);
        this.dirty = false;
        if (!this.running && this.timerAt === Infinity) {
          for (const w of this.idleWaiters.splice(0)) w();
        }
      });
    }, delay);
  }

  /** One engine pass; returns the delay before a retry if it failed. */
  private async pass(): Promise<number | undefined> {
    try {
      const r = await this.o.engine.sync();
      this.failures = 0;
      this.passes++;
      this.report(r);
      return undefined;
    } catch (e) {
      this.failures++;
      let delay: number;
      if (e instanceof ConcurrentChangeError) {
        delay = 500;
        this.o.log(`paused: ${e.message}; retrying`);
      } else if (e instanceof HttpError && e.status === 401) {
        delay = 60_000;
        this.o.log("the server rejected the token; set the current one (BETTERSYNC_TOKEN or the config file)");
      } else {
        delay = backoff(this.failures - 1, 60_000);
        this.o.log(`sync failed (${e instanceof Error ? e.message : String(e)}); retrying in ${Math.round(delay / 1000)} s`);
      }
      return delay;
    }
  }

  private report(r: PassReport): void {
    if (r.applied > 0 || r.pushed > 0) this.o.log(`synced: ${r.applied} applied, ${r.pushed} pushed, cursor ${this.o.engine.cursor}`);
    for (const c of r.conflicts) this.o.log(`conflict: kept the other version; this device's edit is in ${c}`);
    for (const x of r.rejected) this.o.log(`rejected by the server: ${JSON.stringify(x.op)}: ${x.reason}`);
  }
}

function backoff(n: number, max: number): number {
  const base = Math.min(max, 1000 * 2 ** Math.min(n, 16));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
