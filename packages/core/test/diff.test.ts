import { describe, expect, test } from "bun:test";
import { applyHunks, diffLines, diffLinesMyers, splitLines } from "../src/diff.ts";
import { FUZZ_TIMEOUT, forSeeds, LineSource, randomDoc, randomEdit, render, type Flavor } from "./gen.ts";

/** Longest common subsequence length by dynamic programming: the oracle for minimality. */
function lcs(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const cur = [0];
    for (let j = 0; j < b.length; j++) cur.push(x === b[j] ? prev[j]! + 1 : Math.max(prev[j + 1]!, cur[j]!));
    prev = cur;
  }
  return prev[b.length]!;
}

test("patience keeps unique lines aligned where Myers may move them", () => {
  // Found by the fuzzer (disjoint/tiny, seed 33938): B's edit ties with an
  // alignment that deletes and re-inserts "# One" and "# Two".
  const base = ["b\n", "b\n", "# One\n", "b\n", "# Two\n", "a\n", "b\n", "# Three\n"];
  const b = ["b\n", "b\n", "b\n", "a\n", "# One\n", "b\n", "# Two\n", "# Three\n"];
  const kept = (hunks: { start: number; end: number }[]) => base.filter((_, i) => !hunks.some((h) => h.start <= i && i < h.end));
  expect(kept(diffLines(base, b))).toContain("# One\n");
  expect(kept(diffLines(base, b))).toContain("# Two\n");
});

test("anchor choice prefers long unique lines over short ones on a tie", () => {
  // Found by the fuzzer (disjoint/tiny, seed 987675367): "a" and a blank line
  // were unique in the gap too, and an unweighted run chose them over the headings.
  const base = ["# Zero", "", "b", "", "b", "a", "a", "a", "", "# One", "b", "# Two", "a", "b", "", "a", "b", "# Three"];
  const b = ["# Zero", "", "b", "", "b", "a", "a", "a", "", "a", "", "# One", "b", "# Two", "a", "b", "# Three"];
  const removed = diffLines(base, b).flatMap((h) => base.slice(h.start, h.end));
  expect(removed).not.toContain("# One");
  expect(removed).not.toContain("# Two");
});

describe("splitLines", () => {
  test("keeps terminators and a final unterminated line", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\n")).toEqual(["a\n"]);
    expect(splitLines("a\r\nb\n\nc")).toEqual(["a\r\n", "b\n", "\n", "c"]);
  });
});

describe("diffLines", () => {
  for (const flavor of ["unique", "markdown", "tiny"] satisfies Flavor[]) {
    test(`reconstructs and is well-formed; Myers is minimal (${flavor})`, () => {
      forSeeds(`diff/${flavor}`, (rng) => {
        const src = new LineSource(rng, flavor);
        const oldDoc = randomDoc(rng, src);
        const newDoc = rng.chance(0.2) ? randomDoc(rng, src) : randomEdit(rng, src, oldDoc);
        const a = splitLines(render(oldDoc));
        const b = splitLines(render(newDoc));
        for (const diff of [diffLines, diffLinesMyers]) {
          const hunks = diff(a, b);
          expect(applyHunks(a, hunks)).toEqual(b);
          for (const [i, h] of hunks.entries()) {
            expect(h.start).toBeLessThanOrEqual(h.end);
            expect(h.end > h.start || h.lines.length > 0).toBe(true);
            if (i > 0) expect(h.start).toBeGreaterThan(hunks[i - 1]!.end);
          }
        }
        // Myers is minimal; patience trades minimality for stable anchors.
        const removed = diffLinesMyers(a, b).reduce((n, h) => n + h.end - h.start, 0);
        expect(a.length - removed).toBe(lcs(a, b));
      });
    }, FUZZ_TIMEOUT);
  }

  test("falls back to one coarse hunk past the edit-distance cap", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `a${i}\n`);
    const b = Array.from({ length: 5000 }, (_, i) => `b${i}\n`);
    expect(diffLines(a, b)).toEqual([{ start: 0, end: 5000, lines: b }]);
  });
});
