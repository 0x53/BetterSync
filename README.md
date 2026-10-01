# BetterSync

Syncs one person's Obsidian vault across their devices and agents through a small self-hosted server. The design doc is the source of truth for scope and decisions.

Status: **M3 built**. The Obsidian plugin runs the shared engine on the vault. It passes the simulator with its adapter, end-to-end tests in a real Obsidian (on case-sensitive and case-insensitive disks), and kill tests in which Obsidian itself is SIGKILLed at random alongside the headless clients and the server. The M3 gate is daily use on all your devices, with LiveSync retired; iOS is checked by hand (see [Plugin on iOS](#plugin-on-ios)). That trial is under way on Windows and iPhone (since 2026-10-01); issues found so far are collected in [FIXES.md](FIXES.md) and fixed in a batch afterwards.

## Layout

```
packages/
  core/      protocol types, hashing, path rules, diff + three-way merge,
             sync engine, server vault logic, HTTP remote, runner (no I/O)
  sim/       deterministic multi-client simulator             (M1)
  server/    Bun HTTP + WebSocket server, SQLite, blob store,
             admin CLI                                        (M2)
  headless/  folder adapter, file watcher, CLI;
             end-to-end and kill tests                        (M2)
  plugin/    Obsidian vault adapter, plugin UI; fake-vault,
             simulator, real-Obsidian and kill tests          (M3)
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
bun run build         # single binaries: packages/{server,headless}/dist/;
                      # the plugin: packages/plugin/dist/{main.js,manifest.json}
bun run obsidian      # the plugin in a real Obsidian (needs OBSIDIAN_CDP; see below)
bun run obsidian:kill # kill tests with Obsidian (needs OBSIDIAN_CDP, _KILL, _START)
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

Obsidian plugin: `bun run build`, then copy `packages/plugin/dist/main.js` and `manifest.json` into `<vault>/.obsidian/plugins/bettersync/`, enable BetterSync under Community plugins, and enter the server URL and token. On iOS, where the Files app hides `.obsidian`, install with the BRAT plugin: "Add beta plugin" → `0x53/BetterSyncReleases`. To publish a version there, commit the two built files (with a new `version` in `manifest.json`) to that repo and run its Release workflow from the Actions tab.

Headless client, for agents and scripts:

```sh
export BETTERSYNC_TOKEN=...
bettersync sync ~/vault --server https://notes.example.com --device agent-1   # runs continuously
bettersync once ~/vault --server https://notes.example.com --device cron      # pull, push, exit
```

Settings can also live in `~/.config/bettersync/config.json` (`{"server", "token", "device"}`). The folder's sync state and lock are in `<folder>/.bettersync/`; only one client may sync a folder at a time (an OS-held lock, released when the process dies, and effective across containers sharing the folder).

## Merge (`packages/core/src/merge.ts`)

Line-based three-way merge with no conflict markers. On conflict, the caller keeps the server's version and saves the other version whole as a conflict copy.

- **Diff.** Patience diff: lines unique on both sides are matched first. Ties go to the run with the most characters, so headings and paragraphs anchor the alignment ahead of blank lines. Myers fills the gaps. Above an edit distance of 4,000, a gap becomes one coarse hunk, which is still correct but may conflict more.
- **Clean.** Edits to different lines merge, including adjacent lines. So does an insertion next to the other side's change, and so do identical changes on both sides. An insertion that the other side's adjacent replacement already contains at that edge is the same change made twice, and is applied once (a client retrying an edit it has since extended, after the server took the first try).
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
- **Transfers.** Blobs move 8 at a time. On a pull, the blobs for the next 64 changes are fetched ahead, but only a cache: each note is still checked just before it is replaced. A put the server refuses as `missing blob` (a cache or proxy answered `hasBlob`) is uploaded and sent once more.
- **Busy notes.** An adapter may refuse to touch one note for now (`LocalBusyError`: the plugin's editor holds typing that would clash). The remote state stays pending, as for unsynced local content, and the pass carries on.
- **Server rules.** Current base: accepted. Stale base: three-way merge from the base version, or a conflict copy. The base is the ancestor only if the note now at the path descends from it: after a delete and a new note, a note created where it moved away, or another note moved in, the merge uses an empty ancestor, so overlapping content becomes a conflict copy instead of being spliced into a stranger. Content the note already saw after the base, at its path or where it moved, is a replay (or a stale copy from a device that lost its state) and changes nothing. A stale delete loses to the newer edit. An edit to a moved note follows it. A move onto a taken path lands on a conflict name. A note and a folder may not share a name. Paths are keyed case-insensitively.
- **Server identity.** `/v1/state` and `/v1/changes` carry the vault's id, fixed when its data directory is created. Each pull also reads back the change at the client's cursor and compares it with the one the client applied there. A client whose state belongs to another vault, or whose cursor change is gone or different (the server was restored from a backup of its data directory, even if new writes have since passed the cursor), drops its state and resyncs as if it were lost: local files are kept and compared, never trusted as synced. So restoring `/data` from a backup is safe for every device.
- **Guards.** A pass that finds no notes at all where 10 or more were synced refuses to delete them (an unmounted or emptied folder) and fails until the folder is back. A note over 10 MB is not sent, and a synced note that outgrows the limit is not read as deleted. When a put is accepted while the file changed again during the round trip, the accepted content becomes the base, so the next put does not make the server merge the device's own two saves.
- **Paths.** Only `.md` notes sync, never hidden paths (a name starting with a dot, which covers `.obsidian/`, `.trash/`, `.git/`; Obsidian never indexes them) and never names some device cannot store (`< > : " | ? *`, a trailing space or dot, `CON`, `NUL`, `COM¹` and the like, or a name over 255 UTF-8 bytes). The server refuses them; clients leave them alone. Conflict copies of long names are shortened to stay valid, and device names are NFC-normalized before they go into one.
- **Case.** A case-only rename is a move. The engine finds a note's local file with `LocalFs.variants` at the moment it acts, never from an earlier listing, and never renames onto another file. On a case-sensitive disk, two names for one key are separated (the extra becomes a conflict copy, or is dropped if the server already has it).

## Simulator (`packages/sim`)

A discrete-event world with virtual time: 3–10 clients on case-sensitive and case-insensitive in-memory disks, one in-memory server, and a network that delays, reorders and loses requests and responses. Users create, edit, delete, rename and case-rename notes; faults crash clients (sometimes losing or corrupting their state file), crash the server and partition clients. Then faults stop, clients sync until nothing changes, and `invariants.ts` checks:

1. **Convergence.** Every client's notes equal the server's, byte for byte and name for name.
2. **No silent loss.** Every piece of content the engine overwrote or deleted on any device is in the server's files or history.
3. **No resurrection.** After a delete, or a move away, no put brings the path back with content it held before, unless a user put it there again (or moved it there concurrently with the delete).
4. **No stale deletes.** Every delete in the log was based on the version it removed.
5. **Crash safety.** 1–4 hold with the crashes above injected throughout.

Each checker was confirmed to fail when the matching bug is injected (engine overwriting unsynced content, server ignoring delete bases, no replay detection, no pending retry, no acknowledgements).

## Server (`packages/server`)

- **Store.** `SqliteVaultStore` implements the M1 `VaultStore` on `bun:sqlite` (WAL, `synchronous=FULL`). Each op's changes and rows commit in one transaction. Blobs live in `blobs/ab/cd/<sha256>`, written to a temp file, fsynced and renamed before any change names them. A commit checks the log still ends where this process left it, so a second server on the same data directory fails instead of corrupting it. The simulator runs against this store too, reopening the database after every simulated server crash.
- **One server per data directory.** `serve` takes an exclusive OS-held lock on `server.lock` before cleaning temp files, so a second server on the same directory refuses to start. Files are created owner-only (umask 077). `rotate-token` refuses a directory with no vault unless given `--init` (a mistyped `--data` would otherwise create an empty vault the running server never sees).
- **API.** The endpoints in the design doc. `/v1/live` takes the token as a bearer header or as the subprotocol `token.<token>` (browsers, so the plugin, cannot set headers), plus the device as `?device=`; a client using the subprotocol must also offer `bettersync`, so the token is never echoed back in the handshake. It pushes each accepted change and pings every 25 s. JSON responses are `no-store`. Only a SHA-256 of the token is stored; rotation applies at once.
- **Admin CLI.** `serve`, `rotate-token [--init]`, `healthcheck`. History and restore arrive in M4.

## Headless client (`packages/headless`)

- **DiskFs.** The engine's `LocalFs` on a real folder. Paths resolve folder by folder, so NFD names (copied from a Mac onto Linux) and other-case names on case-insensitive disks map to the actual file. Writes are temp file, fsync, rename. Symlinks inside the folder are not followed, neither when listing nor when writing: a note that would land in a symlinked folder is busy and stays on the server. A missing folder is an error, never an empty vault. Folders the engine emptied are removed.
- **Concurrent edits.** M1's check-then-write window is closed here. DiskFs remembers each file's inode, size, mtime and ctime at the engine's last read. It refuses to overwrite, delete or rename a file that changed since, and to write where a file appeared or vanished. A new note is published with `link()`, which fails if a file appeared meanwhile. The pass stops with `ConcurrentChangeError` and the next one picks the edit up. What remains, for an existing note, is the few system calls between that check and the rename.
- **Racy stats.** The engine skips rehashing a file whose mtime and size match what it recorded. Timestamps are coarse (on ext4, half of 50 rapid writes repeated an earlier mtime and size), so a same-size edit saved just after the engine's own write could go unseen forever. As in git, a stat recorded within 2 s of the file's mtime is marked racy and never trusted. The sim missed this because its mtimes are a counter.
- **Folder case.** On a case-insensitive disk, notes in `Projects/` and `projects/` share one folder, so the engine compares folder names ignoring case and file names exactly (`sameNoteName`). Otherwise two devices would move notes back and forth forever.
- **Speed.** Lookups use synchronous `lstat`/`readdir` (Bun's async fs costs several times more per call), with a fast path on case-sensitive disks. At 3,000 notes an idle pass takes about 75 ms, and a first sync of a full folder about 4 s in process. Over HTTP on localhost, uploading 3,000 notes takes about 30 s and downloading them about 22 s, one request per note: fine as a one-time cost, and a candidate for batching later.
- **Runner.** Core's `Runner`, shared with the plugin. A pass runs 1 s after local writes stop (at most 5 s into a burst), at once when `/v1/live` announces a change or reconnects, every 60 s regardless, and after failures with backoff from 1 s to 60 s. While offline or with a rejected token, local changes wait out the backoff too; a live message, a reconnect, waking and "sync now" cut it short. The headless client feeds it native file watching.

## Kill tests (`packages/headless/test/kill.test.ts`)

One server, three `sync` daemons and one `once` agent in a loop, all real processes. A driver edits the folders like a person or an agent: in-place writes, editor-style temp-file saves, creates, deletes, renames, case-only renames, and files that must not sync. Every 0.8–2.5 s a client or the server is SIGKILLed and restarted. A killed client sometimes loses or corrupts its state file. With `BETTERSYNC_CI_DIR`, the laptop's folder sits on a case-insensitive disk. Then every folder must match the server, and `checkObserved` (the simulator's invariants) runs on the server's real change log. For no-silent-loss, the driver records every time a file stopped holding what it last wrote there, and the server must have that content.

Each check was confirmed to fail when the matching bug is injected: an engine that overwrites unsynced content (silent loss), a server that ignores delete bases (stale delete), and a store without replay detection (resurrection). DiskFs's concurrent-edit guard and the racy-stat rule each have a deterministic test in `packages/headless/test/engine.test.ts` that fails without them.

## Obsidian plugin (`packages/plugin`)

Settings: server URL, token, device name (pre-filled from the host name, or `iphone`/`ipad`), pause. The status bar icon shows synced, syncing, offline, paused, conflict (some conflict copy exists; clicking opens it) or a rejected token; on mobile, which has no status bar, the same icon sits in the ribbon. Notices appear only for a conflict copy made from this device's edit and for a rejected token. Commands: sync now, pause/resume, show status, copy the recent sync log.

- **ObsidianFs.** The engine's `LocalFs` over the Vault API, so Obsidian's index and open editors stay current. It lists from the vault index (after the layout is ready, when the index is complete), resolves paths through an index by path key kept current from vault events, and reports NFC names. Folder case on case-insensitive disks, pruning of emptied folders and the concurrent-edit guard follow DiskFs: the disk stat at the engine's last read must still hold at a write, delete or rename.
- **Open editors.** Obsidian holds typing up to 2 s before saving. When a note changes on disk it merges the typing in, but drops it where the two overlap, and a keystroke can land between any check and that merge. So for a note open in an editor the plugin never writes the file: it three-way merges the incoming text into the editor itself, as one synchronous CodeMirror transaction of line changes (the cursor stays), and has the editor save. The typing then goes out as an ordinary edit on top of the remote version. If the typing overlaps the change, the change waits (`LocalBusyError`). The note is then busy: the plugin stops force-saving it, since each early save would push a version the server could only keep as another conflict copy. Once Obsidian autosaves, the typing is pushed, and the server merges it or keeps it as one conflict copy. A note with unsaved typing is never deleted.
- **Pushing typing.** Every editor change counts as a local change. Before each pass the plugin saves editors holding typing (except busy ones), so typing reaches other devices about 1 s after it stops rather than after Obsidian's 2 s autosave.
- **Case-only renames on case-folding disks.** On ext4 with casefold (Android's shared storage), renaming `Note.md` to `note.md` is a no-op on disk while Obsidian's index takes the new name. The plugin checks the name on disk after a case-only rename and, if it did not change, renames through a temporary name.
- **Transport.** Obsidian's `requestUrl` (no CORS, same on desktop and iOS); `/v1/live` over the browser WebSocket with the token as a subprotocol. The server marks blobs `no-store`: Chromium answered a HEAD for a blob from a cached GET of the same URL, so a fresh server at the same address was never sent it.
- **State.** `state.json` in the plugin folder; settings in `data.json`. A new server URL starts the state fresh. Starts and stops run one after another, so a runner is fully stopped before the next opens the state.
- **Fail safe.** The editor guard reads Obsidian's `dirty` and `lastSavedData`, which are not public API. If a version lacks them, an open note counts as holding typing and is never written while open. A note created by the engine is checked on disk first, since the vault index can lag a file another app just wrote.

Measured on the Linux test VM (Obsidian 1.13.7, server on the host):

| | |
| --- | --- |
| Change on another device → visible in Obsidian | 0.1–1.1 s (the headless side's 1 s debounce) |
| Change in Obsidian → visible on another device | 1.1–1.3 s |
| Typing → other device, after the last keystroke | about 1.1 s |
| First sync of 3,000 notes into an empty vault | 48 s |
| Idle pass over 3,000 notes | 75–100 ms |
| 3,000 notes created in Obsidian → all on the server | about 40 s after the last was created |

### Plugin tests

- **Fake vault** (`test/fake-vault.ts`): a fake Obsidian vault and editor over the simulator's in-memory disk, behaving the way the real Obsidian did when probed, including dropping overlapping unsaved typing on a reload. `obsidian-fs.test.ts` covers the adapter and the editor cases with the engine and an in-process server. Among them: continuous typing beside remote edits (no conflict copies, nothing lost), and continuous typing on the very line another device edits (2 conflict copies here; 12 without the busy rule).
- **Simulator** (`sim.test.ts`): the M1 simulator with every non-agent device running ObsidianFs on the fake vault, through the same faults and invariants, and the 3,000-note scale run. Replay with `BETTERSYNC_SEED=<seed> SIM_SEEDS=1 bun test packages/plugin/test/sim.test.ts`.
- **Real Obsidian** (`obsidian.e2e.test.ts`, opt-in): the built plugin in a running Obsidian, driven over the Chrome DevTools Protocol through the `app` object plugins use, against a real server and a headless client. Covers first sync of a non-empty vault, latency, typing, editor refresh with the cursor kept, overlapping and non-overlapping unsaved typing, continuous typing during remote edits, renames and deletes both ways, case-only renames (checked on disk), hidden files, pause, a wrong token, server outage, and restart with kept and lost state. `OBSIDIAN_SCALE=1` adds the 3,000-note measurements above.
- **Kill tests with Obsidian** (`obsidian.kill.test.ts`, opt-in): the M2 kill test plus Obsidian as a device. A driver works in the vault through Obsidian (vault edits, renames including case-only, deletes, typing into an open editor). Obsidian itself is SIGKILLed and relaunched at random, sometimes after its state file is deleted or corrupted. The simulator's invariants must hold on the server's change log, and every typed line must be in some server version unless Obsidian was killed within 8 s of it.

Running them needs an Obsidian started with `--remote-debugging-port=9222` and a **throwaway** vault open (every test wipes it):

```sh
OBSIDIAN_CDP=http://127.0.0.1:9222 bun run obsidian
OBSIDIAN_CDP=http://127.0.0.1:9222 OBSIDIAN_KILL='<sigkill obsidian>' OBSIDIAN_START='<start obsidian>' \
  E2E_SECONDS=30 bun run obsidian:kill
```

The server listens on `127.0.0.1:${OBSIDIAN_SERVER_PORT:-8787}` and Obsidian reaches it at `OBSIDIAN_SERVER_URL` (default the same), so Obsidian can run elsewhere with a tunnel between them. They were run against a Linux VM running Obsidian headless under Xvfb, with `ssh -L 9222:127.0.0.1:9222 -R 8787:127.0.0.1:8787`. A second profile there opens a vault on an ext4 filesystem with casefold, for the case-insensitive runs. Results with the final code: all 14 end-to-end tests on both disks; 10 kill-test seeds of 30 s on the case-sensitive disk and 5 on the case-insensitive one, with up to 3 Obsidian kills each; and the M2 gate (10 runs of 60 s) unchanged.

### Plugin on iOS

Plugins cannot run in the background on iOS, so the plugin syncs while Obsidian is open and catches up when it returns to the foreground (and on reconnecting). It uses no Node or Electron API on mobile, and it ran under Obsidian's mobile emulation. Nothing here drives a real iPhone, so check by hand before relying on it:

1. Install (copy `main.js` and `manifest.json`), enter the URL and token; the ribbon icon turns to synced and the vault fills.
2. Edit a note on the phone; it shows on the desktop within a couple of seconds, and the other way round.
3. Leave Obsidian for a few minutes while editing on the desktop, come back: it catches up at once.
4. Type on the phone while the desktop edits the same note on another line: both edits end up in both.
5. Put the token wrong: a notice says so, the icon shows a key.

### Known gaps

- A program or another plugin writing a note in the few milliseconds between the plugin's last check and its own write to that note (a vault write takes a few awaits) can still be overwritten, like the few system calls DiskFs leaves. The same goes for typing that starts in the moment a remote delete removes the open note. Typing merged into an open editor is not exposed: from the check to the merge nothing awaits.
- Android is not a release gate. Its shared storage folds case like the casefold disk tested here, but it has not run on Android.
- Obsidian and the headless client on the same folder at once are not prevented (the headless lock is not checked by the plugin); each would take the other's writes for user edits, which is safe but wasteful.
- Editors that are not workspace leaves (a note edited in a Canvas card or a hover popover) are not seen by the editor guard, so typing there that overlaps a remote change can be dropped by Obsidian's own reload.
- If Obsidian dies between the two renames of a case-only rename on a case-folding disk, the temporary name (`Note.bettersync-<ts>.md`) syncs as a rename.
- Case keys use `toLowerCase`, which is not full case folding: names that differ only as `ς`/`σ`, `ſ`/`s` or `µ`/`μ` get different keys although APFS and NTFS treat them as one. Changing the key needs a migration of the server's rows and the clients' state.
- On a case-sensitive disk, an NFC and an NFD file of the same name map to one path; the second is not synced.
- A device offline for a long time replays every intermediate version of every note, not just the last.

