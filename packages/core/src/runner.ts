import { ConcurrentChangeError, type PassReport, type SyncEngine } from "./engine.ts";
import type { LiveMessage } from "./protocol.ts";
import { HttpError } from "./remote.ts";

/**
 * Decides when the engine runs, for the headless client and the plugin
 * alike (design doc, "Runtime" and "Headless client"). A pass runs
 *
 * - about 1 s after local changes stop (the client calls `localChange`; at
 *   most 5 s after the first change of a burst), to meet the 2 s target;
 * - at once when the server announces a change on WS /v1/live, and when the
 *   live connection (re)opens, to catch up on anything missed;
 * - every minute regardless, which catches changes nobody reported;
 * - after a failure, with backoff (1 s doubling to 60 s).
 *
 * Only one pass runs at a time; a trigger during a pass runs another after it.
 */
export interface RunnerOptions {
  engine: SyncEngine;
  /** Opens WS /v1/live; omitted, the runner relies on local changes and the periodic pass. */
  live?: () => WebSocket;
  log(message: string): void;
  onStatus?(status: RunnerStatus): void;
  onReport?(report: PassReport): void;
  /** Runs before each pass; the plugin saves editors holding typing here, so it goes out now. */
  beforePass?(): Promise<void>;
  debounceMs?: number;
  maxWaitMs?: number;
  rescanMs?: number;
  /** Close the live connection if the server is silent this long (it pings every 25 s). */
  liveTimeoutMs?: number;
}

/**
 * idle: not started. syncing: a pass is running. synced: the last pass
 * succeeded. offline: the last pass could not reach the server. unauthorized:
 * the server rejected the token. paused: stopped by the user.
 */
export type RunnerStatus = "idle" | "syncing" | "synced" | "offline" | "unauthorized" | "paused";

export class Runner {
  private started = false;
  private stopped = false;
  private paused = false;
  private running: Promise<void> | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = Infinity;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private burstStart = 0;
  private failures = 0;
  private ws: WebSocket | undefined;
  private liveRetry: ReturnType<typeof setTimeout> | undefined;
  private liveFailures = 0;
  private rescan: ReturnType<typeof setInterval> | undefined;
  private idleWaiters: (() => void)[] = [];
  private current: RunnerStatus = "idle";
  /** Passes completed without error, for tests and status. */
  passes = 0;

  constructor(private readonly o: RunnerOptions) {}

  get status(): RunnerStatus {
    return this.current;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.paused) return this.setStatus("paused");
    this.resumeLoops();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.suspendLoops();
    await this.running;
  }

  /** Stops syncing until `resume`; a pass already running finishes. */
  async pause(): Promise<void> {
    if (this.paused) return;
    this.paused = true;
    this.suspendLoops();
    await this.running;
    this.setStatus("paused");
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.started && !this.stopped) this.resumeLoops();
  }

  /**
   * The app came back (iOS resume, laptop wake): the live connection is
   * likely dead and edits may have happened meanwhile. Reconnect and pass now.
   */
  wake(): void {
    if (!this.active) return;
    this.failures = 0;
    this.liveFailures = 0;
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.ws?.close();
      clearTimeout(this.liveRetry);
      this.connectLive();
    }
    this.kick(0, true);
  }

  /** A local note changed; a pass follows once changes stop for a moment. */
  localChange(): void {
    if (!this.active) return;
    const now = Date.now();
    if (this.debounce === undefined) this.burstStart = now;
    clearTimeout(this.debounce);
    const wait = Math.min(this.o.debounceMs ?? 1000, Math.max(0, this.burstStart + (this.o.maxWaitMs ?? 5000) - now));
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.kick(0);
    }, wait);
  }

  /** Runs a pass as soon as possible. */
  syncNow(): void {
    this.kick(0, true);
  }

  /** Resolves once no pass is running or scheduled. */
  idle(): Promise<void> {
    if (!this.running && this.timerAt === Infinity) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private get active(): boolean {
    return this.started && !this.stopped && !this.paused;
  }

  private resumeLoops(): void {
    this.connectLive();
    this.rescan = setInterval(() => this.kick(0), this.o.rescanMs ?? 60_000);
    this.kick(0);
  }

  private suspendLoops(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = Infinity;
    clearTimeout(this.debounce);
    this.debounce = undefined;
    clearTimeout(this.liveRetry);
    clearInterval(this.rescan);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    if (!this.running) this.notifyIdle();
  }

  private setStatus(s: RunnerStatus): void {
    if (s === this.current) return;
    this.current = s;
    this.o.onStatus?.(s);
  }

  // ---- live ----

  private connectLive(): void {
    if (!this.active || !this.o.live) return;
    let ws: WebSocket;
    try {
      ws = this.o.live();
    } catch (e) {
      this.o.log(`live connection failed: ${(e as Error).message}`);
      this.liveRetry = setTimeout(() => this.connectLive(), backoff(this.liveFailures++, 30_000));
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
      if (this.ws !== ws || !this.active) return;
      this.ws = undefined;
      this.liveRetry = setTimeout(() => this.connectLive(), backoff(this.liveFailures++, 30_000));
    };
  }

  // ---- passes ----

  /** Runs a pass in `delay` ms, unless one is already due sooner. `force` cuts a failure backoff short. */
  private kick(delay: number, force = false): void {
    if (!this.active) return;
    if (this.running) {
      if (delay === 0) this.dirty = true;
      return;
    }
    const at = Date.now() + delay;
    if (at >= this.timerAt && !force) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = Infinity;
      this.setStatus("syncing");
      this.running = this.pass().then((retry) => {
        this.running = null;
        if (this.paused) this.setStatus("paused");
        // After a failure the retry waits out its backoff, whatever arrived meanwhile.
        if (retry !== undefined) this.kick(retry);
        else if (this.dirty) this.kick(0);
        this.dirty = false;
        if (this.timerAt === Infinity) this.notifyIdle();
      });
    }, delay);
  }

  private notifyIdle(): void {
    for (const w of this.idleWaiters.splice(0)) w();
  }

  /** One engine pass; returns the delay before a retry if it failed. */
  private async pass(): Promise<number | undefined> {
    try {
      await this.o.beforePass?.();
      const r = await this.o.engine.sync();
      this.failures = 0;
      this.passes++;
      this.setStatus("synced");
      this.report(r);
      return undefined;
    } catch (e) {
      this.failures++;
      let delay: number;
      if (e instanceof ConcurrentChangeError) {
        delay = 500;
        this.o.log(`paused: ${e.message}; retrying`);
        this.setStatus("syncing");
      } else if (e instanceof HttpError && e.status === 401) {
        delay = 60_000;
        this.o.log("the server rejected the token");
        this.setStatus("unauthorized");
      } else {
        delay = backoff(this.failures - 1, 60_000);
        this.o.log(`sync failed (${e instanceof Error ? e.message : String(e)}); retrying in ${Math.round(delay / 1000)} s`);
        this.setStatus("offline");
      }
      return delay;
    }
  }

  private report(r: PassReport): void {
    if (r.applied > 0 || r.pushed > 0) this.o.log(`synced: ${r.applied} applied, ${r.pushed} pushed, cursor ${this.o.engine.cursor}`);
    for (const c of r.conflicts) this.o.log(`conflict: kept the other version; this device's edit is in ${c}`);
    for (const x of r.rejected) this.o.log(`rejected by the server: ${JSON.stringify(x.op)}: ${x.reason}`);
    this.o.onReport?.(r);
  }
}

function backoff(n: number, max: number): number {
  const base = Math.min(max, 1000 * 2 ** Math.min(n, 16));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
