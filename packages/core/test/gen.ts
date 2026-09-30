import { Rng } from "../src/prng.ts";

/** Iterations per fuzz property; `bun run fuzz` raises it. */
export const ITERS = Number(process.env.FUZZ_ITERS ?? 2000);

/** Fuzz tests run long at high ITERS; bun's default per-test timeout is 5 s. */
export const FUZZ_TIMEOUT = 30 * 60 * 1000;

/** Base seed; set BETTERSYNC_SEED to replay a failure. */
export const BASE_SEED = Number(process.env.BETTERSYNC_SEED ?? 0x5eed);

/**
 * Runs `body` once per seed. On failure, rethrows with the seed so the case
 * replays with BETTERSYNC_SEED=<seed> FUZZ_ITERS=1.
 */
export function forSeeds(name: string, body: (rng: Rng) => void, iters = ITERS) {
  for (let i = 0; i < iters; i++) {
    const seed = (BASE_SEED + i) >>> 0;
    try {
      body(new Rng(seed));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${name} failed; replay with BETTERSYNC_SEED=${seed} FUZZ_ITERS=1\n${msg}`, { cause: e });
    }
  }
}

/** A note as content lines (no terminators) plus whether it ends in a newline. */
export interface Doc {
  lines: string[];
  finalNewline: boolean;
}

export function render(d: Doc): string {
  if (d.lines.length === 0) return "";
  return d.lines.join("\n") + (d.finalNewline ? "\n" : "");
}

/** Line sources. "unique" makes every line distinct; the others repeat a lot, like real Markdown. */
export type Flavor = "unique" | "markdown" | "tiny";

const MARKDOWN_POOL = ["", "", "", "---", "# Title", "## Notes", "- [ ] todo", "- [x] done", "- item", "  - nested", "> quote", "```", "text", "Some text here.", "\tindented", "trailing space ", "crlf\r", "émoji 🙂", "[[Link]]"];
const TINY_POOL = ["", "a", "b"];

export class LineSource {
  private n = 0;
  constructor(
    private readonly rng: Rng,
    readonly flavor: Flavor,
  ) {}

  line(): string {
    switch (this.flavor) {
      case "unique":
        return `line ${this.n++} ${this.rng.int(0, 1e6)}`;
      case "markdown":
        return this.rng.chance(0.15) ? `para ${this.rng.int(0, 20)}` : this.rng.pick(MARKDOWN_POOL);
      case "tiny":
        return this.rng.pick(TINY_POOL);
    }
  }

  lines(count: number): string[] {
    return Array.from({ length: count }, () => this.line());
  }

  /** A line no other source call ever returns. */
  anchor(): string {
    return `@@anchor ${this.n++}@@`;
  }
}

export function randomDoc(rng: Rng, src: LineSource, maxLines = 40): Doc {
  return { lines: src.lines(rng.int(0, maxLines)), finalNewline: rng.chance(0.8) };
}

/**
 * Random unconstrained edits of a doc: a few spans replaced, deleted or
 * inserted, sometimes a character-level tweak inside a line, sometimes the
 * final newline toggled.
 */
export function randomEdit(rng: Rng, src: LineSource, d: Doc): Doc {
  const lines = [...d.lines];
  const edits = rng.int(1, 4);
  for (let e = 0; e < edits; e++) {
    const at = rng.int(0, lines.length);
    switch (rng.int(0, 3)) {
      case 0:
        lines.splice(at, rng.int(1, 3), ...src.lines(rng.int(0, 3)));
        break;
      case 1:
        lines.splice(at, rng.int(1, 4));
        break;
      case 2:
        lines.splice(at, 0, ...src.lines(rng.int(1, 3)));
        break;
      case 3:
        if (at < lines.length) lines[at] = tweak(rng, lines[at]!);
        break;
    }
  }
  const finalNewline = rng.chance(0.1) ? !d.finalNewline : d.finalNewline;
  return { lines, finalNewline };
}

function tweak(rng: Rng, s: string): string {
  const i = rng.int(0, s.length);
  return s.slice(0, i) + rng.pick(["x", "", "🙂", " "]) + s.slice(i + rng.int(0, 2));
}

/**
 * Edits that the two sides make to *separate* parts of a note.
 *
 * The base is split into regions, each owned by side A, side B or nobody.
 * Every owned region is followed by an unchanged unique anchor line, so no two
 * owned regions touch. Returns both sides and the expected clean merge, built
 * directly from the region edits (not from any diff).
 */
export function disjointEdits(rng: Rng, src: LineSource) {
  type Region = { owner: "a" | "b" | null; base: string[]; edited: string[] };
  const regions: Region[] = [];
  const count = rng.int(1, 6);
  for (let r = 0; r < count; r++) {
    const base = src.lines(rng.int(0, 5));
    const owner = rng.pick(["a", "b", null] as const);
    regions.push({ owner, base, edited: owner ? editRegion(rng, src, base) : base });
    if (owner) {
      const anchor = [src.anchor()];
      regions.push({ owner: null, base: anchor, edited: anchor });
    }
  }
  const version = (side: "a" | "b" | "both") =>
    regions.flatMap((r) => (r.owner && (side === "both" || side === r.owner) ? r.edited : r.base));

  // Toggling the final newline changes the last line, so only the owner of
  // the last region (via its trailing anchor) may do it.
  const baseNL = rng.chance(0.8);
  const lastOwner = regions.at(-2)?.owner ?? null;
  const toggler = regions.at(-1)?.owner === null && lastOwner && rng.chance(0.3) ? lastOwner : null;
  const nl = (side: "a" | "b") => (toggler === side ? !baseNL : baseNL);

  return {
    base: { lines: regions.flatMap((r) => r.base), finalNewline: baseNL } as Doc,
    a: { lines: version("a"), finalNewline: nl("a") } as Doc,
    b: { lines: version("b"), finalNewline: nl("b") } as Doc,
    expected: { lines: version("both"), finalNewline: toggler ? !baseNL : baseNL } as Doc,
  };
}

/** A non-empty change to a region (so the owner really edited it). */
function editRegion(rng: Rng, src: LineSource, base: string[]): string[] {
  for (;;) {
    const out = [...base];
    switch (rng.int(0, 3)) {
      case 0:
        out.splice(rng.int(0, out.length), 0, ...src.lines(rng.int(1, 3)));
        break;
      case 1:
        out.splice(rng.int(0, out.length), rng.int(1, 3));
        break;
      case 2:
        out.splice(rng.int(0, out.length), rng.int(1, 2), ...src.lines(rng.int(1, 3)));
        break;
      case 3:
        if (out.length) {
          const i = rng.int(0, out.length - 1);
          out[i] = tweak(rng, out[i]!);
        }
        break;
    }
    if (out.length !== base.length || out.some((l, i) => l !== base[i])) return out;
  }
}
