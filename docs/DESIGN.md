# BetterSync — Design Document

Written 2026-09-30 and updated as milestones land. Implementation details beyond this doc are in the [README](../README.md).

## Summary

BetterSync syncs one person's Obsidian vault across their devices and agents through a small server they host. It has three parts: a server behind nginx, an Obsidian plugin, and a headless client that keeps a plain folder in sync so agents can read and write notes with ordinary file tools. You install the plugin, enter the server URL and the token, and it syncs.

The scope is deliberately narrow: one user, one vault, Markdown notes only, one shared token, no web UI, no API beyond what the clients use. What it must get right is correctness: every device converges to the same files, and no edit is ever silently lost.

**Status:** design decided, M0, M1 and M2 done. The answers behind each decision are in **Decisions** near the end; M3 (the Obsidian plugin) is built and tested; its gate, daily use on all of the author's devices with LiveSync retired, is next.

## Background: Self-hosted LiveSync

[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) is a community Obsidian plugin that syncs vaults through a server you host. Its flexibility is the source of most of its failures: three transports, many modes, and a large settings surface that must match on every device.

**How it works**

- Each device keeps a local PouchDB database that mirrors the vault. Vault events are written into PouchDB, which replicates to a remote CouchDB; other devices watch CouchDB's change feed and write changes back to disk ([tech info](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tech_info.md)).
- Files are split into content chunks stored as separate documents, with a metadata document per file pointing at its chunks.
- Backends: CouchDB, S3-compatible object storage (MinIO, R2), or WebRTC peer-to-peer with a signalling relay.
- Extras: optional end-to-end encryption, path obfuscation, hidden-file sync, "customization sync" for settings, themes and plugins, and setup URIs copied from the first device. A CLI daemon now exists as well.

**Where it hurts**

| Problem | Evidence |
| --- | --- |
| Two databases per device plus the vault means three copies that can disagree | Troubleshooting covers metadata ID mismatches, missing chunks, size mismatches and "could not prove the file was unchanged" ([troubleshooting](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/troubleshooting.md)) |
| Stale or offline devices delete valid files on reconnect | [#800](https://github.com/vrtmrz/obsidian-livesync/issues/800), [#813](https://github.com/vrtmrz/obsidian-livesync/issues/813), [#1143](https://github.com/vrtmrz/obsidian-livesync/issues/1143) |
| Auto-merge loses data | [#994 Auto-Conflict causes lost data](https://github.com/vrtmrz/obsidian-livesync/issues/994) |
| Files arrive empty (metadata synced, chunks not) | [#1065](https://github.com/vrtmrz/obsidian-livesync/issues/1065), [#835](https://github.com/vrtmrz/obsidian-livesync/issues/835) |
| Case-only renames delete folders | [#1168](https://github.com/vrtmrz/obsidian-livesync/issues/1168) |
| Settings must match across devices (encryption, obfuscation, chunking, case handling) | Troubleshooting "configuration mismatches" |
| Recovery means "rebuild", "reset", "recreate chunks" by hand | Troubleshooting; the README warns to back up the vault first |
| Database grows forever; deletes leave tombstones and chunks | Troubleshooting "database bloat"; garbage collection is a manual step |

The lesson for BetterSync: keep one authoritative copy on the server, keep the client state small and rebuildable, never let a device delete something it has not seen, and make repair automatic.

## Goals and non-goals

**Goals**

1. **Zero-config clients.** The plugin needs a server URL and a credential, nothing else. No per-device settings that must match.
2. **No silent data loss.** Every write either lands in the current vault or is preserved as a conflict copy or in server history. A device that was offline for a month cannot delete newer work.
3. **Automatic.** Sync starts on launch, runs continuously, recovers from crashes, restarts and network loss without user action. There is no "rebuild database" button because there is nothing to rebuild.
4. **Converges.** After all devices go quiet and reconnect, every device holds byte-identical vaults.
5. **Headless parity.** The headless client uses the same sync engine as the plugin and behaves identically.
6. **Boring to operate.** One container or binary, one data directory, backups are a copy of that directory.

**Non-goals**

- More than one user or more than one vault per server.
- Syncing anything besides Markdown notes: no attachments, no `.obsidian` settings, themes or plugins.
- TLS termination (nginx does it), end-to-end encryption, per-device credentials.
- A web UI, REST API or MCP server. Agents use the headless client's folder.
- Live co-editing (CRDTs), peer-to-peer sync, alternative backends.
- Git mirroring and migration from LiveSync.
- Tunable knobs: chunk sizes, intervals, batch sizes.
- First-class Android support. It shares the mobile code path with iOS and should work, but is not a release gate.

## Architecture

Hub and spoke: every client talks only to the server, and one sync engine package is shared by the plugin and the headless client. nginx sits in front of the server and terminates TLS (not drawn).

```
                                     ┌────────────── BetterSync server ──────────────┐
┌──────────────────────────┐ HTTPS   │  ┌─────────────────────────────────────────┐  │
│ Obsidian plugin          │◄──WSS──►│  │ HTTPS + WebSocket API                   │  │
│ desktop, iOS (Android    │         │  │ ops, blobs, change push, token auth     │  │
│ best effort)             │         │  └────────────────────┬────────────────────┘  │
│ vault adapter + engine   │         │                       ▼                       │
└──────────────────────────┘         │  ┌─────────────────────────────────────────┐  │
┌──────────────────────────┐ HTTPS   │  │ Vault writer (one per vault)            │  │
│ Headless client          │◄──WSS──►│  │ compare-and-swap, three-way merge       │  │
│ daemon or one-shot CLI   │         │  └──────────┬────────────────────┬─────────┘  │
│ folder adapter + engine  │         │             ▼                    ▼            │
└──────────────────────────┘         │  ┌──────────────────┐  ┌──────────────────┐   │
             ▲ writes files          │  │ SQLite           │  │ Blob store       │   │
┌────────────┴─────────────┐         │  │ change log, files│  │ by SHA-256       │   │
│ Agents and scripts       │         │  └──────────────────┘  └──────────────────┘   │
│ plain Markdown files in  │         └───────────────────────────────────────────────┘
│ the headless folder      │
└──────────────────────────┘
```

Clients never talk to each other. The server's vault writer applies changes one at a time, so there is exactly one history for every device to converge on. The plugin and headless client differ only in their storage adapter (Obsidian vault API vs plain filesystem), which keeps their behaviour identical.

## Sync model and conflict resolution

The server holds the single authoritative vault state and an append-only change log; every client write is a compare-and-swap against the version it last saw. This is the model Git and Dropbox use, and it rules out the stale-device deletions that hurt LiveSync.

**Data model**

- **Blob:** file content, addressed by its SHA-256 hash. Stored once, shared across versions and paths.
- **File entry:** `path → {blob hash, size, mtime, version}`. `version` is the server sequence number of the last change to that path.
- **Change log:** a monotonically increasing sequence per vault. Each entry records `seq, path, op (put | delete | move), blob hash, base version, device, time`.
- **Client state:** a cursor (last seq applied) plus, per file, the version and hash it last synced. This is small and can be rebuilt from the server at any time by rehashing local files.

**Write path**

1. The client sees a local change (vault event or rescan), hashes the file, and uploads the blob if the server lacks it.
2. It sends `put(path, new hash, base version)`.
3. If `base version` equals the server's current version, the server accepts, bumps the sequence and broadcasts the change.
4. If not, another device changed the file first. The server resolves it (below) and returns the result.

**Read path:** clients hold a WebSocket open; the server pushes new change-log entries and the client applies them, then advances its cursor. On reconnect, the client asks for everything after its cursor. Each apply is written to a temp file and renamed, so a crash never leaves a half-written note.

**Conflicts**

- **Non-overlapping edits** to the same note merge cleanly with a three-way merge. The common ancestor is always on the server, because the client sends the version it started from.
- **Overlapping edits:** the note keeps the version the server accepted first. The other device's full version is saved next to it as `Note (conflict 2026-09-30 laptop).md`, which syncs like any note, and the plugin shows a notice.
- **Edit vs delete:** the edit wins and the note is restored. A delete applies only when its base version is current.
- **Moves and renames:** sent as `move(old, new, base version)` so history follows the note. Case-only renames are a first-class move, handled for case-insensitive filesystems (Windows, macOS, iOS).
- **Same path created on two devices:** merged with an empty ancestor; overlapping content becomes a conflict copy as above.

Since only Markdown syncs, there is no binary-file conflict case.

**Device names:** all devices share one token, so each client sends a self-chosen device name (for example `laptop`, `iphone`, `agent-1`) with every request. It is used only to label history and conflict copies, not for access control.

**Deletes and history:** deleting a note writes a tombstone to the log; its content stays in history. Retention: every version for 30 days, then one snapshot per day for a year, then pruned. Clients can never remove history; only the retention job does.

**Rejected: CRDTs (Yjs / Automerge).** Live co-editing is not needed, and CRDTs would force agents writing plain files through a CRDT library and make the on-disk vault a derived artifact.

## Server

One TypeScript process on Bun, shipped as a Docker image, serving one vault from one data directory. It listens on plain HTTP on localhost; nginx terminates TLS in front of it.

**Language and repo layout.** TypeScript everywhere, so the protocol types, merge code and sync engine are written once. Bun runs the server and headless client (built-in SQLite, single-binary builds); the plugin is bundled with esbuild.

```
packages/
  core/      # protocol types, hashing, three-way merge, sync engine (no I/O)
  server/    # Bun HTTP + WebSocket server, SQLite, blob store, admin CLI
  headless/  # folder adapter + CLI, compiled to a single binary
  plugin/    # Obsidian vault adapter + status UI
  sim/       # deterministic multi-client simulator
```

**Storage**

```
/data
  bettersync.db        # SQLite (WAL): file entries, change log, history
  blobs/ab/cd/<sha256>  # immutable note contents
```

Backups are a copy of `/data`. At 11 MB and about 300 notes today, the whole store with a year of history should stay in the tens of megabytes.

**API**

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/state` | Full file list with versions and hashes, for first sync and self-repair |
| `GET /v1/changes?after=<seq>` | Change log since a cursor |
| `WS /v1/live` | Pushes new changes as they are accepted; heartbeats both ways |
| `HEAD/PUT/GET /v1/blobs/<sha256>` | Upload and download note contents; the server checks the hash |
| `POST /v1/ops` | Batch of put / delete / move with base versions; returns accepted, merged or conflicted per op |
| `GET /healthz` | Liveness for Docker and nginx |

Every request carries `Authorization: Bearer <token>` and an `X-Device-Name` header. The server rejects paths that are not `.md`, hidden paths (any name starting with a dot, which covers `.obsidian/` and `.trash/`), names Windows or iOS cannot store (`< > : " | ? *`, a trailing space or dot, `CON`, `NUL` and the like), and notes over 10 MB. Browsers cannot set headers on a WebSocket, so `/v1/live` also takes the token as the subprotocol `token.<token>` and the device name as `?device=`.

**Operations**

- First start generates a random token and prints it once; it can be rotated with the admin CLI (all devices then need the new one).
- All writes go through a single writer, so compare-and-swap is trivially correct.
- No web UI. History and recovery use the admin CLI inside the container: `bettersync history <path>`, `bettersync restore <path> --at <time>`, `bettersync restore-all --at <time>`. A restore is just a new write, so it syncs to every device.
- nginx must pass WebSocket upgrades for `/v1/live`:

```
# http { } block, once:
map $http_upgrade $connection_upgrade { default upgrade; "" ""; }

location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_read_timeout 1h;
  client_max_body_size 11m;
}
```

## Obsidian plugin

A thin TypeScript plugin around the shared sync engine. It uses only Obsidian's vault and `requestUrl` APIs, so the same build runs on desktop and iOS (and Android, untested).

**Setup**

1. Install the plugin.
2. Enter the server URL, the token and a device name (pre-filled from the hostname or platform).
3. First sync: if the local vault is empty, download everything. If it is not, upload notes the server lacks, download notes the device lacks, and treat notes that differ on both as a conflict (conflict copy, never an overwrite). No prompt is needed because nothing is lost either way.
4. Settings beyond that: a pause toggle. Nothing else.

**Runtime**

- Syncs only `.md` files outside hidden folders (`.obsidian/`, `.trash/` and any other name starting with a dot, which Obsidian never indexes). Other files in the vault are ignored and left alone.
- Listens to vault `create`, `modify`, `delete` and `rename` events and pushes about 1 s after typing stops, to meet the 2 s end-to-end target.
- Full rescan on startup and on resume from background (mtime and size, then hash on mismatch), which catches edits made while the app was closed.
- Local state (cursor, per-file version and hash) is a small JSON file in the plugin folder. If lost or corrupt, it is rebuilt by rescanning and fetching `/v1/state`; no user action.
- Incoming changes are written through the vault API. A note open in an editor gets the change merged into the editor itself, in one step no keystroke can split, so unsaved typing and the cursor stay. If the typing overlaps the change, the change waits until the editor saves; the typing is then pushed and merged on the server, or kept as a conflict copy.

**Status:** a status-bar icon (synced, syncing, offline, paused, conflict); on mobile, which has no status bar, the same icon sits in the ribbon. A notice appears only when a conflict copy is created or when the token is rejected.

**iOS:** plugins do not run in the background, so iOS syncs while Obsidian is open and catches up on resume. That is a platform limit, not something the plugin can fix.

## Headless client and agent access

A single binary that keeps a plain folder in sync with the server. Agents and scripts read and write Markdown files there with ordinary tools and get full read/write access to the vault; there is no other agent interface.

**Commands**

- `bettersync sync <folder> --server <url> --device agent-1` — runs continuously; token from `BETTERSYNC_TOKEN` or a config file. Ships with a systemd unit and a Docker example.
- `bettersync once <folder> ...` — pull, push, exit. For cron jobs and CI.

**Behaviour**

- Same engine as the plugin, with a filesystem adapter instead of the vault adapter.
- Native file watching plus a periodic rescan, so writes by any program are picked up, including editors that save via temp file and rename.
- Incoming changes are written atomically (temp file + rename), so an agent never reads a half-written note.
- Same rules as the plugin: only `.md` outside hidden folders; everything else in the folder is ignored.
- Agent mistakes are recoverable: every write is in server history under the agent's device name, and `bettersync restore` undoes it.

## Security

One shared bearer token over TLS; no end-to-end encryption. The threat model: an attacker with access to one of your devices already has the vault, and the server's disk has full-disk encryption, so more machinery adds no protection for a single self-hosted user.

- **Transport:** nginx terminates HTTPS and WSS. The server binds to localhost only.
- **Auth:** one random 256-bit token, compared in constant time. Rotating it means re-entering it on each device.
- **At rest:** plaintext on the server, protected by the host's full-disk encryption.
- **Why no E2EE:** it would push merging into every client and add a passphrase that can be lost, which is where many of LiveSync's support issues come from.

## Correctness and testing

"Works correctly" is the product, so correctness is tested as properties, not examples. The sync engine is written against an abstract filesystem, clock and network so it can run in a deterministic simulator.

**Invariants checked after every simulated run**

1. **Convergence:** once all clients are online and idle, every client's files equal the server's, byte for byte.
2. **No silent loss:** every content hash any client ever wrote is present in a current file, a conflict copy, or server history.
3. **No resurrection:** a file deleted on a device that had the latest version stays deleted everywhere.
4. **No stale deletes:** a delete based on an old version never removes newer content.
5. **Crash safety:** killing a client or the server at any point, then restarting, still satisfies 1–4.

**Test layers**

- **Simulation:** N clients (3–10) do random edits, creates, deletes, renames and case-only renames, with random disconnects, message delays, reordering and crashes. Seeded, so any failure replays exactly.
- **Merge fuzzing:** random text edits against the three-way merge, checking both sides' non-conflicting edits survive.
- **Filesystem matrix:** case-insensitive (Windows, macOS), Unicode normalization (macOS NFD vs NFC), long paths, and files edited while being synced.
- **End-to-end:** a real server, headless clients, and the plugin in a real Obsidian driven over its DevTools port, on case-sensitive and case-insensitive disks, including kill tests that SIGKILL Obsidian at random; mobile manually before releases.

Scale targets for tests: 3,000 notes (10× today's vault), 5 simulated devices plus 2 agents, and a change visible on other online devices within 2 s.

## Decisions

Answered 2026-09-30. Each row is reflected in the sections above.

| # | Topic | Decision |
| --- | --- | --- |
| Q1 | Language | TypeScript everywhere; Bun for server and headless client |
| Q2 | TLS | nginx reverse proxy handles it; the server does no TLS |
| Q3 | Users and vaults | One user, one vault; 2–3 devices (phone, laptop, desktop) and 1–2 agents |
| Q4 | End-to-end encryption | No. TLS in transit and full-disk encryption at rest; self-hosted by the user |
| Q5 | Auth | One static token shared by all devices |
| Q6 | Live co-editing | No |
| Q7 | Overlapping edits | Conflict copy next to the note, plus a notice |
| Q8 | What syncs | Markdown notes only |
| Q9 | History | Every version for 30 days, then daily snapshots for 1 year |
| Q10 | File size | Small text files; vault is 11 MB. Limit 10 MB per note |
| Q11 | Agent access | Synced folder only |
| Q12 | Agent permissions | Full read/write |
| Q13 | Platforms | Desktop and iOS required; Android best effort |
| Q14 | Git mirror | No |
| Q15 | Web UI | No; admin CLI for history and restore |
| Q16 | Scale | 11 MB, about 300 notes, 2–3 devices, 1–2 agents |
| Q17 | Latency | Under 2 s between online devices |
| Q18 | Migration from LiveSync | None; the user moves their own files |
| Q19 | Distribution | Private until it proves itself, then open source and publish |
| Q20 | Name | BetterSync as the working name |

## Proposed milestones

Build the sync engine and its simulator first; the server, headless client and plugin are thin layers on a proven core.

| Milestone | Work | Gate to the next phase |
| --- | --- | --- |
| M0 · Decide and spike | Design decided; monorepo set up; three-way merge and protocol types prototyped | Merge prototype passes fuzzing |
| M1 · Sync engine and simulator | Shared engine package with an in-memory server; seeded multi-client simulation with edits, crashes and partitions | All 5 invariants hold in simulation |
| M2 · Server and headless client | SQLite and blob store server, Docker image, admin CLI; headless daemon and one-shot CLI | Converges after kill tests |
| M3 · Obsidian plugin | URL + token setup, status bar, conflict notices; desktop first, then iOS | Daily use on all of the author's devices, replacing LiveSync |
| M4 · Hardening and release | Admin CLI history and restore, retention job; daily use, then open source | v1 release |

The headless client ships before the plugin because it is easier to test end to end and is immediately useful for agents. No durations are set; M0 is done (repo set up, merge prototype passes fuzzing), M1 is done (all 5 invariants hold over 10,000 simulated runs), M2 is done (10 kill-test runs of 60 s, with clients and the server killed at random, converge with every invariant holding), and M3 is built (the plugin passes its end-to-end and kill tests in a real Obsidian; its gate is daily use on all of the author's devices).
