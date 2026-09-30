# BetterSync

Syncs one person's Obsidian vault across their devices and agents through a small self-hosted server. The design doc is the source of truth for scope and decisions.

Status: **M2**. The real server (SQLite, blob store, Docker image, admin CLI) and the headless client run as separate processes and converge after kill tests: clients and the server are SIGKILLed at random while a driver edits every folder, and the simulator's invariants hold on the server's real change log. Next is M3: the Obsidian plugin.

## Layout

```
packages/
  core/      protocol types, hashing, path rules, diff + three-way merge,
             sync engine, server vault logic (no I/O)
  sim/       deterministic multi-client simulator             (M1)
  server/    Bun HTTP + WebSocket server, SQLite, blob store,
             admin CLI                                        (M2)
  headless/  folder adapter, HTTP remote, runner, CLI;
             end-to-end and kill tests                        (M2)
  plugin/    Obsidian vault adapter + status UI               (M3, stub)
deploy/      docker-compose, nginx snippet, systemd unit, headless image
Dockerfile   the server image
```

## Commands

Requires [Bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun test              # unit, API, disk and end-to-end tests; merge fuzz at 2,000 seeds;
                      # sim at 300 seeds (+40 on SQLite); one 20 s kill run
bun run fuzz          # merge fuzz at 20,000 seeds per property
bun run sim           # simulator at 5,000 seeds
bun run kill          # kill tests: 10 runs of 60 s
bun run typecheck
bun run build         # single binaries: packages/{server,headless}/dist/
```

Fuzz and sim failures print a seed. Replay a merge fuzz case with `BETTERSYNC_SEED=<seed> FUZZ_ITERS=1 bun test packages/core`, and a sim run with `BETTERSYNC_SEED=<seed> SIM_SEEDS=1 bun test packages/sim`. `FUZZ_ITERS`, `SIM_SEEDS` and `BETTERSYNC_SEED` set the count and starting seed. The kill tests take `E2E_SECONDS`, `E2E_RUNS`, `BETTERSYNC_SEED`, and `E2E_VERBOSE=1` to echo every process's log. Set `BETTERSYNC_CI_DIR` to a folder on a case-insensitive disk (macOS, Windows, WSL's `/mnt/c`) to run the disk tests there too.

## Running it

Server, behind nginx (see `deploy/`):

```sh
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs bettersync       # the token, printed once
docker compose -f deploy/docker-compose.yml exec bettersync bettersync rotate-token
```

Without Docker: `bun packages/server/src/cli.ts serve --data ./data` (listens on 127.0.0.1:8787).

Headless client, for agents and scripts:

```sh
export BETTERSYNC_TOKEN=...
bettersync sync ~/vault --server https://notes.example.com --device agent-1   # runs continuously
bettersync once ~/vault --server https://notes.example.com --device cron      # pull, push, exit
```

Settings can also live in `~/.config/bettersync/config.json` (`{"server", "token", "device"}`). The folder's sync state and lock are in `<folder>/.bettersync/`; only one client may sync a folder at a time.

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

## Server (`packages/server`)

- **Store.** `SqliteVaultStore` implements the M1 `VaultStore` on `bun:sqlite` (WAL, `synchronous=FULL`). Each op's changes and rows commit in one transaction. Blobs live in `blobs/ab/cd/<sha256>`, written to a temp file, fsynced and renamed before any change names them. A commit checks the log still ends where this process left it, so a second server on the same data directory fails instead of corrupting it. The simulator runs against this store too, reopening the database after every simulated server crash.
- **API.** The endpoints in the design doc. `/v1/live` takes the token as a bearer header or as the subprotocol `token.<token>` (browsers, so the plugin, cannot set headers), plus the device as `?device=`. It pushes each accepted change and pings every 25 s. Only a SHA-256 of the token is stored; rotation applies at once.
- **Admin CLI.** `serve`, `rotate-token`, `healthcheck`. History and restore arrive in M4.

## Headless client (`packages/headless`)

- **DiskFs.** The engine's `LocalFs` on a real folder. Paths resolve folder by folder, so NFD names (copied from a Mac onto Linux) and other-case names on case-insensitive disks map to the actual file. Writes are temp file, fsync, rename. Symlinks are not followed. Folders the engine emptied are removed.
- **Concurrent edits.** M1's check-then-write window is closed here. DiskFs remembers each file's inode, size, mtime and ctime at the engine's last read. It refuses to overwrite, delete or rename a file that changed since, and to write where a file appeared or vanished. The pass stops with `ConcurrentChangeError` and the next one picks the edit up. What remains is the few system calls between that check and the rename.
- **Racy stats.** The engine skips rehashing a file whose mtime and size match what it recorded. Timestamps are coarse (on ext4, half of 50 rapid writes repeated an earlier mtime and size), so a same-size edit saved just after the engine's own write could go unseen forever. As in git, a stat recorded within 2 s of the file's mtime is marked racy and never trusted. The sim missed this because its mtimes are a counter.
- **Folder case.** On a case-insensitive disk, notes in `Projects/` and `projects/` share one folder, so the engine compares folder names ignoring case and file names exactly (`sameNoteName`). Otherwise two devices would move notes back and forth forever.
- **Speed.** Lookups use synchronous `lstat`/`readdir` (Bun's async fs costs several times more per call), with a fast path on case-sensitive disks. At 3,000 notes an idle pass takes about 75 ms, and a first sync of a full folder about 4 s in process. Over HTTP on localhost, uploading 3,000 notes takes about 30 s and downloading them about 22 s, one request per note: fine as a one-time cost, and a candidate for batching later.
- **Runner.** A pass runs 1 s after local writes stop (at most 5 s into a burst), at once when `/v1/live` announces a change or reconnects, every 60 s regardless, and after failures with backoff from 1 s to 60 s.

## Kill tests (`packages/headless/test/kill.test.ts`)

One server, three `sync` daemons and one `once` agent in a loop, all real processes. A driver edits the folders like a person or an agent: in-place writes, editor-style temp-file saves, creates, deletes, renames, case-only renames, and files that must not sync. Every 0.8–2.5 s a client or the server is SIGKILLed and restarted. A killed client sometimes loses or corrupts its state file. With `BETTERSYNC_CI_DIR`, the laptop's folder sits on a case-insensitive disk. Then every folder must match the server, and `checkObserved` (the simulator's invariants) runs on the server's real change log. For no-silent-loss, the driver records every time a file stopped holding what it last wrote there, and the server must have that content.

Each check was confirmed to fail when the matching bug is injected: an engine that overwrites unsynced content (silent loss), a server that ignores delete bases (stale delete), and a store without replay detection (resurrection). DiskFs's concurrent-edit guard and the racy-stat rule each have a deterministic test in `packages/headless/test/engine.test.ts` that fails without them.
