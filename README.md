# BetterSync

Syncs one person's Obsidian vault across their devices and agents through a small self-hosted server. The design doc is the source of truth for scope and decisions.

Status: **M0**. The repo is set up and the three-way merge prototype passes fuzzing. Next is M1: the sync engine and the deterministic simulator.

## Layout

```
packages/
  core/      protocol types, hashing, path rules, diff + three-way merge (no I/O)
  sim/       deterministic multi-client simulator             (M1, stub)
  server/    Bun HTTP + WebSocket server, SQLite, blob store  (M2, stub)
  headless/  folder adapter + CLI                             (M2, stub)
  plugin/    Obsidian vault adapter + status UI               (M3, stub)
```

## Commands

Requires [Bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun test              # unit tests + fuzz at 2,000 seeds per property
bun run fuzz          # merge fuzz at 20,000 seeds per property
bun run typecheck
```

Fuzz failures print a seed. Replay one exactly with `BETTERSYNC_SEED=<seed> FUZZ_ITERS=1 bun test`. Set `FUZZ_ITERS` and `BETTERSYNC_SEED` to run more seeds or a different range.

## Merge (`packages/core/src/merge.ts`)

Line-based three-way merge with no conflict markers. On conflict, the caller keeps the server's version and saves the other version whole as a conflict copy.

- **Diff.** Patience diff: lines unique on both sides are matched first. Ties go to the run with the most characters, so headings and paragraphs anchor the alignment ahead of blank lines. Myers fills the gaps. Above an edit distance of 4,000, a gap becomes one coarse hunk, which is still correct but may conflict more.
- **Clean.** Edits to different lines merge, including adjacent lines. So does an insertion next to the other side's change, and so do identical changes on both sides.
- **Conflict.** Different changes to overlapping lines conflict. So do different insertions at the same point, a delete against an edit of the same line, and an unterminated last line that the other side appended after.
- **Bytes.** `mergeBytes` refuses to merge content that isn't valid UTF-8. It keeps BOMs and CRLF byte for byte.
- **Symmetric.** `merge(base, a, b)` and `merge(base, b, a)` always agree.

Fuzzed properties are in `packages/core/test/merge.fuzz.test.ts`, over unique-line, Markdown-like and two-letter text:

1. Non-overlapping edits survive exactly.
2. The merge is symmetric.
3. Identity cases hold.
4. Overlapping different edits always conflict.
5. A clean merge keeps every line either side added and every line neither side touched.
