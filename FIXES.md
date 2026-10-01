# Fixes from the M3 daily-driver trial

Found while deploying BetterSync `b0d1119` on a home server (server and headless
client in Docker behind nginx at a path prefix) and Obsidian on Windows (`laptop`).
The tests started on 2026-10-01. Ordered by priority.

**Status after upstream `a517f6a` (post-M3 review, deployed 2026-10-01):**

| Item | Status |
|---|---|
| 1. Conflict copy per autosave | Open |
| 2. Symlinked parent folders | **Fixed** (DiskFs no longer writes through symlinked folders) |
| 3. Notice storm | Open |
| 4. Backup command | Open |
| 4. Token in container log | Partly addressed by `rotate-token --init`; the first `serve` still logs it |
| 4. DB created 0644 | Fixed for new files (umask 077); see item 6 for existing data |
| 4. Path-prefix docs, recovering deleted copies | Open |
| 5. Stale replica on join | Open |
| 6. Upgrade-time items | Open |

## 1. Continuous typing on a contested line makes one conflict copy per autosave

**Severity:** high for usability, but nothing is lost. The worst case is clutter, as designed.

**Repro (2026-10-01 21:51, Windows plugin and the headless client):**

1. `BetterSync test.md` is open in Obsidian on Windows. Type `aaaa…` continuously at the
   end of `Line A`.
2. From the headless side, overwrite `Line A` three times, about 4 s apart
   (21:51:40, :44 and :48).
3. Keep typing for about 20 s after the last remote edit.

**Expected:** at most one conflict copy, plus about one more per remote edit. The README
describes this case as "2 conflict copies here" and says that, once Obsidian autosaves,
"the server merges it or keeps it as one conflict copy".

**Observed:** **7 conflict copies**, and 7 notices on Windows. The copies kept coming every
2–5 s for 18 s after the last remote edit and stopped only when typing stopped. Each copy
is a growing snapshot of the same typing (24, 30, 42, 60, 74 … `a`s). The main note
correctly held the remote version, and Windows matched it afterwards.

Server log (`/v1/changes`, local times):

```
257 21:51:38 put  BetterSync test.md            base 256  laptop
258 21:51:40 put  BetterSync test.md            base 257  homeserver
259 21:51:40 put  … (conflict … laptop)         base -    laptop
260 21:51:42 put  … (conflict … 2)              base -    laptop
261 21:51:44 put  BetterSync test.md            base 258  homeserver
262 21:51:48 put  BetterSync test.md            base 261  homeserver   ← last remote edit
263 21:51:48 put  … (conflict … 3)              base -    laptop
264 21:51:53 put  … (conflict … 4)              base -    laptop
265 21:51:59 put  … (conflict … 5)              base -    laptop
266 21:52:04 put  … (conflict … 6)              base -    laptop
267 21:52:06 put  … (conflict … 7)              base -    laptop
```

**Likely mechanism.** `ObsidianFs.writeThroughEditors` marks the note `busy` and throws
`LocalBusyError`. `main.ts:185` then stops force-saving it, but Obsidian's own 2 s
autosave still writes the file. The engine pushes that save as a local edit on the stale
base, and the server keeps it as a conflict copy. The incoming version then still
overlaps the editor's newer typing, so the note becomes busy again. The next autosave
repeats the cycle. Replay detection cannot catch it, because each save has new content.
The result is one copy per autosave for as long as typing continues, even after the
remote side has gone quiet.

**Fix options** (the first is probably smallest and most general):

- **Server: fold repeated stale pushes into one copy.** When a device puts path P on base
  B, and its earlier put on P with the same base B already became conflict copy C, apply
  the new put to C (C's latest version as base, so it fast-forwards) instead of making a
  new copy. Record the conflict copy against `(device, path, base)` in the store.
- **Plugin: once a conflict copy exists for an open note, stop pushing that note.** Wait
  until its editor has been idle for some seconds, then three-way merge the server text
  into the editor once more before pushing. Typing still wins locally until it settles.
- **Plugin: one notice per note per conflict episode,** not one per copy (see item 3).

**Test to add:** the fake-vault test "continuous typing on the very line another device
edits" should also keep typing for N seconds after the remote side stops, and assert that
the number of copies does not grow during that tail. The real-Obsidian end-to-end test
should do the same. The trial suggests the fake vault's autosave timing does not match
Windows Obsidian 1.x.

## 2. DiskFs follows symlinked parent folders (security)

**Severity:** high wherever another program can write into the synced folder. That is the
agent use case the headless client exists for.

`DiskFs.resolve`'s fast path, `write` (`mkdir -p`, temp file, `rename`), `remove` (`rm`)
and `rename` all use `join(root, path)`. `lstat` and `rm` only refuse to follow a symlink
in the **last** component, so a symlinked parent folder is still followed. An agent that
can write inside the vault can replace `notes/` with a symlink to `/somewhere/else`. A
later remote change to `notes/x.md` is then written, renamed or deleted outside the vault
under the client's user. `list()` correctly skips symlinks, but the write paths do not.
The README's "Symlinks are not followed" holds only for the final component.

**Workaround in use:** the headless client runs in a container that mounts only the vault,
with a read-only root and all capabilities dropped. A planted link can then reach nothing
outside the vault.

**Fix:** before acting, `lstat` every component from `root` to the parent and refuse any
symlink (`ConcurrentChangeError` or a dedicated error), checking again after the temp-file
write and before `rename`. Better still, keep a directory file descriptor and use
`openat`/`renameat` with `O_NOFOLLOW` (Bun FFI or a small native helper), which removes
the race between the check and the action. Add a test: plant a symlinked folder, push a
remote change under it, and assert that nothing outside the root changed.

## 3. Notice storm

Each conflict copy made from this device's edit raises a 20 s notice, so item 1 produced
7 stacked notices. Coalesce them: one notice per note, updated in place with a count,
for example "3 conflict copies of BetterSync test.md".

## 4. Smaller items

- **No consistent backup command.** Copying `data/` while the server runs gives an
  inconsistent SQLite snapshot. Add `bettersync backup <dest>`, using `VACUUM INTO` or the
  backup API plus a manifest of referenced blobs, so a nightly cron job can take a
  consistent copy.
- **The first-start token goes to the container log,** where `docker logs` keeps it. Two
  options: `serve` could write the first token to a 0600 file instead, or `init --token-file`
  could exist. (The trial deployment avoided this by running `rotate-token`, with stdout
  captured, before the first `serve`.)
- **`bettersync.db` is created 0644.** It holds the token hash and every note's content,
  so create the data directory 0700 and the files 0600.
- **Document path-prefix deployments.** `https://host/bettersync` works, because the
  plugin trims trailing slashes and nginx strips the prefix with
  `location /bettersync/ { proxy_pass http://127.0.0.1:8787/; … }`. It is worth a line in
  `deploy/nginx.conf`.
- **Recovering a deleted conflict copy.** In the trial, all 7 copies were deleted,
  including the newest. Until M4's history/restore exists, document how to get a deleted
  version back from the change log and the blob store.

## 5. Joining a device that holds a stale replica makes conflict copies

**Severity:** medium. It happens once per device at migration, but it is the first thing a
new user sees. No data was lost.

**What happened (2026-10-01 22:25):** the iPhone joined with the vault LiveSync had left
on it. iOS LiveSync only syncs in the foreground, so the phone was days behind CouchDB
on 4 notes. Its first pass pushed all 4 with no base, and the server kept each as
`(conflict … iphone)` (changes 284–287). Every copy was an **older** version:

- `plans/2026-09-28`: the phone had the 09-27 version, and the server had the 09-29 update.
- `food/Shopping List`: the 09-27 list, superseded on 09-29.
- `travel/VW …`: the version from before the flights were booked.
- `travel/In-Laws …`: the agent's 09-26 08:43 text, which the laptop edited at 22:27 that day.

CouchDB held the newer text for all 4, so the phone had not pulled it. This was not a
server-side LiveSync drop.

**Why it can't fast-forward:** a device with no state has no base, and the server's replay
detection only knows versions it has seen. History starts at the server's initial upload,
so pre-migration versions are unknown. Choosing the newer side would mean trusting mtimes,
which the design rightly does not. The conflict copy is the correct safe outcome.

**Fixes:**

- **Docs (cheapest):** under migration, say "join each existing device from an **empty**
  vault (or a fresh copy), not from the old sync's replica". Alternatively, fully sync the
  old system on that device right before switching.
- **Plugin: offer "This device's copy may be out of date" on first connect.** Choosing
  it takes the server version for differing notes. The local versions are pushed as
  **history-only** entries rather than visible conflict copies, so nothing is lost and the
  vault stays clean. This needs M4's history; until then, conflict copies are the safe default.
- **Migration import:** optionally seed the server's history with known prior versions
  (git history, or the old sync's replica) so replay detection recognises them.

## 6. Upgrade-time items (found upgrading `b0d1119` → `a517f6a`)

- **Existing data files keep their old modes.** umask 077 only applies to files created
  from now on. After the upgrade, `bettersync.db` and `-shm` were still 0644. `serve`
  should `chmod` the data directory's files to owner-only at startup.
- **The plugin version did not change (0.3.0)** across a data-loss fix release. Obsidian
  and BRAT therefore cannot tell a device is out of date, and the only way to check is
  comparing `main.js` hashes by hand. Bump `manifest.json`'s `version` on every release.
  Possibly also send the client version in a header and log it on the server.
- **`bun run build` leaves the tree dirty.** It changes `packages/server/src/cli.ts`
  to mode 0755. Either commit the executable bit or stop the build from setting it.

## Not a bug, but trial feedback

- Only `.md` syncs. The trial vault has 9 non-note files (images, a `.base`, an `.html`).
  New pasted images not reaching other devices will be the first thing a daily user notices.
  Consider whether attachments belong in M4 or later.

## What worked

- Initial upload of 240 notes; a throwaway client's full pull through nginx with live push.
- Box → Windows within about 1 s.
- **Typing on Line B on Windows while the box edited Line C four times:** merged cleanly,
  including one stale-base push that the server merged three ways (changes 250–256). No
  copies, and the cursor stayed put.
- Deleting 7 notes and moving one into a new folder on Windows propagated. The box and
  server then matched exactly: 241/241 notes, every hash equal.
