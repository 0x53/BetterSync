# BetterSync

Syncs one person's Obsidian vault across their devices and agents through a small self-hosted server. The design doc is the source of truth for scope and decisions.

Status: **M1**. The sync engine and the server's vault logic pass the deterministic simulator: all five invariants hold across 10,000 seeded runs with crashes, partitions and lost messages. Next is M2: the real server (SQLite, blob store, Docker) and the headless client.

## Layout

```
packages/
  core/      protocol types, hashing, path rules, diff + three-way merge,
             sync engine, server vault logic (no I/O)
  sim/       deterministic multi-client simulator             (M1)
  server/    Bun HTTP + WebSocket server, SQLite, blob store  (M2, stub)
  headless/  folder adapter + CLI                             (M2, stub)
  plugin/    Obsidian vault adapter + status UI               (M3, stub)
```

## Commands

Requires [Bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun test              # unit tests, merge fuzz at 2,000 seeds, sim at 300 seeds
bun run fuzz          # merge fuzz at 20,000 seeds per property
bun run sim           # simulator at 5,000 seeds
bun run typecheck
```

Fuzz and sim failures print a seed. Replay a merge fuzz case with `BETTERSYNC_SEED=<seed> FUZZ_ITERS=1 bun test packages/core`, and a sim run with `BETTERSYNC_SEED=<seed> SIM_SEEDS=1 bun test packages/sim`. `FUZZ_ITERS`, `SIM_SEEDS` and `BETTERSYNC_SEED` set the count and starting seed.

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

## Sync engine (`packages/core/src/engine.ts`, `vault.ts`)

`Vault` is the server's write logic over a synchronous `VaultStore` (in memory for the sim; SQLite in M2). `SyncEngine` is the client, written against abstract `LocalFs`, `Remote` and `StateStore` interfaces so the plugin, the headless client and the simulator share it.

- **Pass.** Pull the change log, push local changes as compare-and-swap ops, pull again. Every step is idempotent, so a crash anywhere is repaired by the next pass.
- **The one safety rule.** The engine overwrites or deletes a local file only when the server already has its content: the version last synced, or content the server just acknowledged. Anything else is a local edit; it is pushed and merged, never overwritten. A remote change it cannot apply yet is kept as pending and retried.
- **Server rules.** Current base: accepted. Stale base: three-way merge from the base version, or a conflict copy. Content the path already saw after the base is a replay (or a stale copy from a device that lost its state) and changes nothing. A stale delete loses to the newer edit. An edit to a moved note follows it. A move onto a taken path lands on a conflict name. Paths are keyed case-insensitively.
- **Case.** A case-only rename is a move. The engine finds a note's local file with `LocalFs.variants` at the moment it acts, never from an earlier listing, and never renames onto another file. On a case-sensitive disk, two names for one key are separated (the extra becomes a conflict copy, or is dropped if the server already has it).

## Simulator (`packages/sim`)

A discrete-event world with virtual time: 3–10 clients on case-sensitive and case-insensitive in-memory disks, one in-memory server, and a network that delays, reorders and loses requests and responses. Users create, edit, delete, rename and case-rename notes; faults crash clients (sometimes losing or corrupting their state file), crash the server and partition clients. Then faults stop, clients sync until nothing changes, and `invariants.ts` checks:

1. **Convergence.** Every client's notes equal the server's, byte for byte and name for name.
2. **No silent loss.** Every piece of content the engine overwrote or deleted on any device is in the server's files or history.
3. **No resurrection.** After a delete, no put brings the path back with content it held before, unless a user put it there again.
4. **No stale deletes.** Every delete in the log was based on the version it removed.
5. **Crash safety.** 1–4 hold with the crashes above injected throughout.

Each checker was confirmed to fail when the matching bug is injected (engine overwriting unsynced content, server ignoring delete bases, no replay detection, no pending retry, no acknowledgements).
