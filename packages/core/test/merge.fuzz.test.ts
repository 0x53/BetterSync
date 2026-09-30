import { describe, expect, test } from "bun:test";
import { diffLines, splitLines, type Hunk } from "../src/diff.ts";
import { merge3, type MergeResult } from "../src/merge.ts";
import { disjointEdits, FUZZ_TIMEOUT, forSeeds, LineSource, randomDoc, randomEdit, render, type Flavor } from "./gen.ts";

/**
 * The M0 exit gate: "merge prototype passes fuzzing".
 *
 * Properties, over unique-line, Markdown-like and tiny-alphabet text:
 *  1. Non-overlapping edits survive: when the two sides edit separate regions
 *     of a note, the merge is clean and equals both edits applied to base.
 *  2. Symmetric: merge(base, a, b) and merge(base, b, a) agree exactly.
 *  3. Identities: merge(base, x, x), merge(base, base, x) and
 *     merge(base, x, base) are clean and equal x.
 *  4. Overlapping different edits conflict: two sides that replace the same
 *     unique lines with different content never merge silently.
 *  5. A clean merge loses nothing: for each side, the lines it added plus the
 *     base lines neither side touched appear in the result, in order.
 */
/** merge3 with the sides swapped, conflicts swapped back so results compare directly. */
function mergeSwapped(base: string, a: string, b: string): MergeResult {
  const r = merge3(base, b, a);
  return r.clean ? r : { clean: false, conflicts: r.conflicts.map((c) => ({ ...c, a: c.b, b: c.a })) };
}

/**
 * What side `mine` must contribute to any clean merge with `theirs`: its own
 * hunks' lines, plus base lines that neither side's hunks cover, in base order.
 */
function mustSurvive(base: string[], mine: Hunk[], theirs: Hunk[]): string[] {
  const touched = new Uint8Array(base.length);
  for (const h of [...mine, ...theirs]) touched.fill(1, h.start, h.end);
  const out: string[] = [];
  let hi = 0;
  for (let pos = 0; pos <= base.length; pos++) {
    while (hi < mine.length && mine[hi]!.start === pos) out.push(...mine[hi++]!.lines);
    if (pos < base.length && !touched[pos]) out.push(base[pos]!);
  }
  return out;
}

function isSubsequence(needle: string[], hay: string[]) {
  let i = 0;
  for (const l of hay) if (i < needle.length && l === needle[i]) i++;
  return i === needle.length;
}

const FLAVORS = ["unique", "markdown", "tiny"] satisfies Flavor[];

describe("merge3 fuzz", () => {
  for (const flavor of FLAVORS) {
    test(`1. non-overlapping edits survive (${flavor})`, () => {
      forSeeds(`disjoint/${flavor}`, (rng) => {
        const { base, a, b, expected } = disjointEdits(rng, new LineSource(rng, flavor));
        const r = merge3(render(base), render(a), render(b));
        expect(r).toEqual({ clean: true, text: render(expected) });
      });
    }, FUZZ_TIMEOUT);

    test(`2+3. symmetric, identities (${flavor})`, () => {
      forSeeds(`symmetry/${flavor}`, (rng) => {
        const src = new LineSource(rng, flavor);
        const base = render(randomDoc(rng, src));
        const baseDoc = { lines: [], finalNewline: true };
        const a = render(randomEdit(rng, src, rng.chance(0.5) ? randomDoc(rng, src) : baseDoc));
        const b = render(randomEdit(rng, src, rng.chance(0.5) ? randomDoc(rng, src) : baseDoc));
        expect(mergeSwapped(base, a, b)).toEqual(merge3(base, a, b));
        expect(merge3(base, a, a)).toEqual({ clean: true, text: a });
        expect(merge3(base, base, a)).toEqual({ clean: true, text: a });
        expect(merge3(base, a, base)).toEqual({ clean: true, text: a });
      });
    }, FUZZ_TIMEOUT);

    test(`2+5. related edits: symmetric, clean results lose nothing (${flavor})`, () => {
      forSeeds(`related/${flavor}`, (rng) => {
        const src = new LineSource(rng, flavor);
        const baseDoc = randomDoc(rng, src);
        const base = render(baseDoc);
        const a = render(randomEdit(rng, src, baseDoc));
        const b = render(randomEdit(rng, src, baseDoc));
        const r = merge3(base, a, b);
        expect(mergeSwapped(base, a, b)).toEqual(r);
        if (r.clean) {
          const bl = splitLines(base);
          const ha = diffLines(bl, splitLines(a));
          const hb = diffLines(bl, splitLines(b));
          const out = splitLines(r.text);
          expect(isSubsequence(mustSurvive(bl, ha, hb), out)).toBe(true);
          expect(isSubsequence(mustSurvive(bl, hb, ha), out)).toBe(true);
        }
      });
    }, FUZZ_TIMEOUT);
  }

  test("4. overlapping different edits conflict", () => {
    forSeeds("overlap", (rng) => {
      const src = new LineSource(rng, "unique");
      const before = src.lines(rng.int(0, 10));
      const target = src.lines(rng.int(1, 4));
      const after = src.lines(rng.int(0, 10));
      const nl = rng.chance(0.8);
      const doc = (mid: string[]) => render({ lines: [...before, ...mid, ...after], finalNewline: nl });
      // Each side rewrites the target lines differently (possibly deleting them on one side only).
      const midA = rng.chance(0.2) ? [] : src.lines(rng.int(1, 4));
      const midB = src.lines(rng.int(1, 4));
      expect(merge3(doc(target), doc(midA), doc(midB)).clean).toBe(false);
    });
  }, FUZZ_TIMEOUT);
});
