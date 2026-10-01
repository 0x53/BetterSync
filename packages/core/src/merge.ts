import { diffLines, splitLines, type Hunk } from "./diff.ts";

/**
 * Three-way line merge (diff3 style) of two edits `a` and `b` of a common
 * ancestor `base`.
 *
 * Each side is diffed against base. Hunks from the two sides that overlap in
 * base are grouped; a group resolves cleanly if both sides produce the same
 * text for it or only one side touches it, and conflicts otherwise. Two
 * insertions at the same point conflict (their order is ambiguous) unless they
 * are identical. Hunks that merely touch (one ends where the other starts)
 * do not conflict and are applied in base order, except that an insertion
 * the other side's touching replacement already holds at that edge is the
 * same change made twice and is applied once (as when a client retries an
 * edit it has since extended, after the server took the first try).
 *
 * The rules depend only on positions, never on which side a hunk came from,
 * so merge(base, a, b) and merge(base, b, a) always agree.
 *
 * There are no conflict markers: on conflict the caller keeps one version and
 * saves the other whole as a conflict copy (design doc, "Conflicts").
 */
export type MergeResult = { clean: true; text: string } | { clean: false; conflicts: Conflict[] };

export interface Conflict {
  /** Line range in base that both sides changed differently. */
  baseStart: number;
  baseEnd: number;
  a: string[];
  b: string[];
}

interface SideHunk extends Hunk {
  side: 0 | 1;
}

export function merge3(base: string, a: string, b: string): MergeResult {
  if (a === b) return { clean: true, text: a };
  if (a === base) return { clean: true, text: b };
  if (b === base) return { clean: true, text: a };

  const baseLines = splitLines(base);
  const hunks: SideHunk[] = absorbRepeats([
    ...diffLines(baseLines, splitLines(a)).map((h) => ({ ...h, side: 0 as const })),
    ...diffLines(baseLines, splitLines(b)).map((h) => ({ ...h, side: 1 as const })),
  ]);
  // By start; at the same start, pure insertions first so they precede a
  // replacement that begins there.
  hunks.sort((x, y) => x.start - y.start || (x.end - x.start === 0 ? 0 : 1) - (y.end - y.start === 0 ? 0 : 1));

  const out: string[] = [];
  const conflicts: Conflict[] = [];
  let pos = 0;
  let i = 0;
  while (i < hunks.length) {
    const first = hunks[i]!;
    const group = [first];
    let start = first.start;
    let end = first.end;
    for (i++; i < hunks.length; i++) {
      const h = hunks[i]!;
      const overlaps = h.start < end;
      const sameInsertionPoint = start === end && h.start === end && h.end === h.start;
      if (!overlaps && !sameInsertionPoint) break;
      group.push(h);
      end = Math.max(end, h.end);
    }

    for (; pos < start; pos++) out.push(baseLines[pos]!);
    pos = end;

    if (group.length === 1) {
      out.push(...first.lines);
      continue;
    }
    const va = sideRegion(baseLines, group, 0, start, end);
    const vb = sideRegion(baseLines, group, 1, start, end);
    if (sameLines(va, vb)) out.push(...va);
    else conflicts.push({ baseStart: start, baseEnd: end, a: va, b: vb });
  }
  for (; pos < baseLines.length; pos++) out.push(baseLines[pos]!);

  // Only a file's last line can lack a newline. If one side's unterminated
  // last line ends up followed by the other side's lines, joining them would
  // fuse two lines into one, so that is a conflict, not a merge.
  const fused = out.findIndex((l, i) => i < out.length - 1 && !l.endsWith("\n"));
  if (fused !== -1) conflicts.push({ baseStart: baseLines.length, baseEnd: baseLines.length, a: splitLines(a).slice(-1), b: splitLines(b).slice(-1) });

  if (conflicts.length > 0) return { clean: false, conflicts };
  return { clean: true, text: out.join("") };
}

/**
 * Drops each pure insertion whose lines the other side's replacement touching
 * it already contains, at the start (insertion at its start) or at the end
 * (insertion at its end). Applying both would repeat those lines.
 */
function absorbRepeats(hunks: SideHunk[]): SideHunk[] {
  const replacements = hunks.filter((h) => h.end > h.start);
  return hunks.filter((ins) => {
    if (ins.end !== ins.start) return true;
    const p = ins.start;
    const n = ins.lines.length;
    return !replacements.some(
      (r) =>
        r.side !== ins.side &&
        r.lines.length > n &&
        ((r.start === p && sameLines(r.lines.slice(0, n), ins.lines)) || (r.end === p && sameLines(r.lines.slice(-n), ins.lines))),
    );
  });
}

/** One side's version of base[start, end), applying that side's hunks in the group. */
function sideRegion(baseLines: readonly string[], group: readonly SideHunk[], side: 0 | 1, start: number, end: number) {
  const out: string[] = [];
  let pos = start;
  for (const h of group) {
    if (h.side !== side) continue;
    for (; pos < h.start; pos++) out.push(baseLines[pos]!);
    out.push(...h.lines);
    pos = h.end;
  }
  for (; pos < end; pos++) out.push(baseLines[pos]!);
  return out;
}

function sameLines(x: readonly string[], y: readonly string[]) {
  return x.length === y.length && x.every((l, i) => l === y[i]);
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/**
 * Byte-level entry point used by the sync engine. Notes that are not valid
 * UTF-8 are never merged: they always conflict, so no byte is ever altered by
 * a lossy decode. A leading BOM is kept as ordinary content.
 */
export function mergeBytes(base: Uint8Array, a: Uint8Array, b: Uint8Array): { clean: true; bytes: Uint8Array } | { clean: false } {
  if (sameBytes(a, b) || sameBytes(base, b)) return { clean: true, bytes: a };
  if (sameBytes(base, a)) return { clean: true, bytes: b };
  let texts: [string, string, string];
  try {
    texts = [decoder.decode(base), decoder.decode(a), decoder.decode(b)];
  } catch {
    return { clean: false };
  }
  const r = merge3(...texts);
  return r.clean ? { clean: true, bytes: encoder.encode(r.text) } : { clean: false };
}

function sameBytes(x: Uint8Array, y: Uint8Array) {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
