/**
 * Small seeded PRNG (mulberry32) so fuzz tests and the simulator replay
 * exactly from a seed. Not for anything security-related.
 */
export class Rng {
  private s: number;

  constructor(readonly seed: number) {
    this.s = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error("pick from empty array");
    return xs[Math.floor(this.next() * xs.length)]!;
  }
}
