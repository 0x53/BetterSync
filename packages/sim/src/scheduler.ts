/**
 * Discrete-event scheduler with virtual time. Every source of concurrency in
 * the simulation (network deliveries, timers, user actions, crashes) is an
 * event here, so a run replays exactly from its seed.
 *
 * After each event the scheduler lets all pending microtasks run, so the
 * engine advances until it next waits on something the scheduler controls.
 * That requires everything else to be synchronous underneath: in-memory
 * filesystems and a synchronous hash.
 */
export class Scheduler {
  now = 0;
  private heap: { t: number; n: number; fn: () => void }[] = [];
  private n = 0;

  /** Runs `fn` after `delay` virtual ms. Ties run in scheduling order. */
  at(delay: number, fn: () => void): void {
    const e = { t: this.now + Math.max(0, delay), n: this.n++, fn };
    const h = this.heap;
    h.push(e);
    for (let i = h.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!before(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }

  sleep(delay: number): Promise<void> {
    return new Promise((resolve) => this.at(delay, resolve));
  }

  get idle(): boolean {
    return this.heap.length === 0;
  }

  /** Runs the next event and everything it sets off. Returns false if none is left. */
  async step(): Promise<boolean> {
    const e = this.pop();
    if (!e) return false;
    this.now = e.t;
    e.fn();
    await drain();
    return true;
  }

  /** Runs events up to virtual time `t`. */
  async runUntil(t: number): Promise<void> {
    while (this.heap.length > 0 && this.heap[0]!.t <= t) await this.step();
    this.now = Math.max(this.now, t);
  }

  /** Runs events until `p` settles; throws if the simulation runs dry or past `limit` events first. */
  async settle<T>(p: Promise<T>, limit = 1_000_000): Promise<T> {
    let done = false;
    const watched = p.finally(() => {
      done = true;
    });
    watched.catch(() => {});
    await drain();
    for (let i = 0; !done; i++) {
      if (i >= limit) throw new Error("simulation did not settle");
      if (!(await this.step())) throw new Error("deadlock: waiting with no events left");
    }
    return watched;
  }

  private pop() {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last) {
      h[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && before(h[l]!, h[m]!)) m = l;
        if (r < h.length && before(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

function before(a: { t: number; n: number }, b: { t: number; n: number }) {
  return a.t < b.t || (a.t === b.t && a.n < b.n);
}

/** Lets every queued microtask (and the ones they queue) run. */
export const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
