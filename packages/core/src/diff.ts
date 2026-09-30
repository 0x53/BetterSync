/**
 * Line diff (Myers, O((N+M)·D)) producing hunks against the "old" side.
 *
 * A hunk replaces old[start, end) with `lines`. Hunks are sorted, and no two
 * hunks touch: between any two there is at least one unchanged line. An empty
 * range (start === end) is a pure insertion before old[start].
 */
export interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/**
 * Above this edit distance the diff gives up on precision and reports the
 * whole (prefix/suffix-trimmed) middle as one hunk. The result is still a
 * correct diff, just coarser, so a merge may conflict where a finer diff would
 * not. Bounds the stored trace at roughly MAX_D² ints.
 */
export const MAX_D = 4000;

/** Splits text into lines, each keeping its terminator; the last may lack one. */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let from = 0;
  for (;;) {
    const nl = text.indexOf("\n", from);
    if (nl === -1) break;
    lines.push(text.slice(from, nl + 1));
    from = nl + 1;
  }
  if (from < text.length) lines.push(text.slice(from));
  return lines;
}

/**
 * Patience diff: lines that occur exactly once on each side are matched first
 * (longest increasing run of them), then Myers fills the gaps between. This
 * keeps unique lines such as headings aligned, where plain Myers may break a
 * tie by "moving" them, which misplaces the other side's edits in a merge.
 */
export function diffLines(oldLines: readonly string[], newLines: readonly string[]): Hunk[] {
  return diffWith(oldLines, newLines, patience);
}

/** Minimal (shortest edit script) diff. Exported for tests. */
export function diffLinesMyers(oldLines: readonly string[], newLines: readonly string[]): Hunk[] {
  return diffWith(oldLines, newLines, myers);
}

type Matcher = (a: Int32Array, b: Int32Array, keptOld: Uint8Array, keptNew: Uint8Array, weight: (id: number) => number) => void;

function diffWith(oldLines: readonly string[], newLines: readonly string[], match: Matcher): Hunk[] {
  // Intern lines so the inner loops compare small ints, not strings.
  const ids = new Map<string, number>();
  const intern = (l: string) => {
    let id = ids.get(l);
    if (id === undefined) ids.set(l, (id = ids.size));
    return id;
  };
  const a = Int32Array.from(oldLines, intern);
  const b = Int32Array.from(newLines, intern);
  const lengths = Array.from(ids.keys(), (l) => l.trim().length + 1);
  const n = a.length;
  const m = b.length;

  // keptOld[i] / keptNew[j]: the line is part of the common subsequence.
  const keptOld = new Uint8Array(n);
  const keptNew = new Uint8Array(m);
  match(a, b, keptOld, keptNew, (id) => lengths[id]!);

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && keptOld[i] && keptNew[j]) {
      i++;
      j++;
      continue;
    }
    const start = i;
    const lines: string[] = [];
    while (i < n && !keptOld[i]) i++;
    while (j < m && !keptNew[j]) lines.push(newLines[j++]!);
    hunks.push({ start, end: i, lines });
  }
  return hunks;
}

/** Marks the common prefix and suffix; returns their lengths. */
function trim(a: Int32Array, b: Int32Array, keptOld: Uint8Array, keptNew: Uint8Array): [number, number] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  keptOld.fill(1, 0, pre).fill(1, a.length - suf);
  keptNew.fill(1, 0, pre).fill(1, b.length - suf);
  return [pre, suf];
}

function patience(a: Int32Array, b: Int32Array, keptOld: Uint8Array, keptNew: Uint8Array, weight: (id: number) => number): void {
  // Explicit stack of sub-ranges [aLo, aHi) x [bLo, bHi) instead of recursion.
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (stack.length > 0) {
    const [aLo, aHi, bLo, bHi] = stack.pop()!;
    const sa = a.subarray(aLo, aHi);
    const sb = b.subarray(bLo, bHi);
    const ko = keptOld.subarray(aLo, aHi);
    const kn = keptNew.subarray(bLo, bHi);
    const [pre, suf] = trim(sa, sb, ko, kn);
    const n = sa.length - pre - suf;
    const m = sb.length - pre - suf;
    if (n === 0 || m === 0) continue;
    const ma = sa.subarray(pre, pre + n);
    const mb = sb.subarray(pre, pre + m);

    const anchors = uniqueCommonRun(ma, mb, weight);
    if (anchors.length === 0) {
      myers(ma, mb, ko.subarray(pre, pre + n), kn.subarray(pre, pre + m));
      continue;
    }
    let pi = 0;
    let pj = 0;
    for (const [i, j] of anchors) {
      keptOld[aLo + pre + i] = 1;
      keptNew[bLo + pre + j] = 1;
      stack.push([aLo + pre + pi, aLo + pre + i, bLo + pre + pj, bLo + pre + j]);
      pi = i + 1;
      pj = j + 1;
    }
    stack.push([aLo + pre + pi, aLo + pre + n, bLo + pre + pj, bLo + pre + m]);
  }
}

/**
 * Pairs (i, j) of lines occurring exactly once in a and once in b, reduced to
 * the run increasing in both i and j with the most matched characters. Weighting
 * by length lets headings and paragraphs win over a blank line or a lone "-"
 * that happens to be unique within a small gap.
 */
function uniqueCommonRun(a: Int32Array, b: Int32Array, weight: (id: number) => number): [number, number][] {
  // Position of each line if it occurs exactly once, else -1.
  const inA = new Map<number, number>();
  for (let i = 0; i < a.length; i++) inA.set(a[i]!, inA.has(a[i]!) ? -1 : i);
  const inB = new Map<number, number>();
  for (let j = 0; j < b.length; j++) inB.set(b[j]!, inB.has(b[j]!) ? -1 : j);
  const pairs: [number, number][] = [];
  for (let i = 0; i < a.length; i++) {
    if (inA.get(a[i]!) !== i) continue;
    const j = inB.get(a[i]!);
    if (j !== undefined && j >= 0) pairs.push([i, j]);
  }
  if (pairs.length === 0) return pairs;

  // Max-weight increasing subsequence in j (pairs are sorted by i), using a
  // Fenwick tree over j of the best chain ending below each position.
  const size = b.length + 1;
  const treeW = new Float64Array(size + 1);
  const treeP = new Int32Array(size + 1).fill(-1);
  const prev = new Int32Array(pairs.length).fill(-1);
  const best = new Float64Array(pairs.length);
  let top = 0;
  for (let p = 0; p < pairs.length; p++) {
    const [i, j] = pairs[p]!;
    let w = 0;
    let from = -1;
    for (let x = j; x > 0; x -= x & -x) {
      if (treeW[x]! > w) (w = treeW[x]!), (from = treeP[x]!);
    }
    best[p] = w + weight(a[i]!);
    prev[p] = from;
    for (let x = j + 1; x <= size; x += x & -x) {
      if (best[p]! > treeW[x]!) (treeW[x] = best[p]!), (treeP[x] = p);
    }
    if (best[p]! > best[top]!) top = p;
  }
  const run: [number, number][] = [];
  for (let p = top; p >= 0; p = prev[p]!) run.push(pairs[p]!);
  return run.reverse();
}

/**
 * Greedy Myers with a stored trace, then backtrack to mark kept lines.
 * Leaves everything unmarked (one big hunk) if the distance exceeds MAX_D.
 */
function myers(a: Int32Array, b: Int32Array, keptOld: Uint8Array, keptNew: Uint8Array): void {
  const [pre, suf] = trim(a, b, keptOld, keptNew);
  if (pre > 0 || suf > 0) {
    const end = (x: { length: number }) => x.length - suf;
    return myers(a.subarray(pre, end(a)), b.subarray(pre, end(b)), keptOld.subarray(pre, end(a)), keptNew.subarray(pre, end(b)));
  }
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return;
  const max = Math.min(n + m, MAX_D);
  const v = new Int32Array(2 * max + 2);
  // trace[d] = v at the start of round d, diagonals -d..d stored at index k+d.
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(max - d, max + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!) ? v[max + k + 1]! : v[max + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return;

  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!;
    const at = (k: number) => prev[k + d]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    // The edit lands at (midX, midY); everything after it on this diagonal is a snake.
    const midX = down ? px : px + 1;
    const midY = down ? py + 1 : py;
    while (x > midX && y > midY) {
      x--;
      y--;
      keptOld[x] = 1;
      keptNew[y] = 1;
    }
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    keptOld[x] = 1;
    keptNew[y] = 1;
  }
}

/** Applies hunks (from diffLines(old, _)) to old. Used by tests and the merge. */
export function applyHunks(oldLines: readonly string[], hunks: readonly Hunk[]): string[] {
  const out: string[] = [];
  let pos = 0;
  for (const h of hunks) {
    for (; pos < h.start; pos++) out.push(oldLines[pos]!);
    out.push(...h.lines);
    pos = h.end;
  }
  for (; pos < oldLines.length; pos++) out.push(oldLines[pos]!);
  return out;
}
