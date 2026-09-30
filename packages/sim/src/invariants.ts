import { pathKey, type FileRow } from "@bettersync/core";
import { hashSync } from "./hash.ts";
import type { World } from "./world.ts";

/**
 * The design doc's invariants, checked once every client is online and idle.
 * The fifth, crash safety, is that these still hold with crashes injected
 * during the run.
 */
export function checkInvariants(w: World): string[] {
  const out: string[] = [];
  const changes = w.store.allChanges();

  // 1. Convergence: every client's syncable files equal the server's, byte for byte, names included.
  const server = new Map(w.store.liveRows().map((r) => [r.path, r.hash!]));
  for (const c of w.clients) {
    const local = new Map([...c.fs.syncable()].map(([p, b]) => [p, hashSync(b)]));
    const diffs: string[] = [];
    for (const [p, h] of server) if (local.get(p) !== h) diffs.push(`${p}: server ${h.slice(0, 8)}, local ${local.get(p)?.slice(0, 8) ?? "missing"}`);
    for (const p of local.keys()) if (!server.has(p)) diffs.push(`${p}: only local`);
    if (diffs.length > 0) out.push(`convergence: ${c.device} differs from server: ${diffs.slice(0, 5).join("; ")}`);
  }

  // 2. No silent loss: whatever the engine overwrote or deleted on a device is on the server.
  const kept = new Set<string>(server.values());
  for (const c of changes) {
    if (c.hash) kept.add(c.hash);
    if (c.submitted) kept.add(c.submitted);
  }
  for (const x of w.clobbered) {
    if (!kept.has(x.hash)) out.push(`silent loss: ${x.device} replaced ${x.path} (${x.hash.slice(0, 8)}) at t=${x.time}, and the server never had it`);
  }

  // 3 + 4, from the change log. History per key is every content it held or was sent.
  const version = new Map<string, number>();
  const history = new Map<string, Set<string>>();
  const deletedWith = new Map<string, { time: number; hashes: Set<string> }>();
  const remember = (key: string, h: string | null | undefined) => {
    if (!h) return;
    let s = history.get(key);
    if (!s) history.set(key, (s = new Set()));
    s.add(h);
  };
  for (const c of changes) {
    const key = pathKey(c.path);
    if (c.op === "delete") {
      // 4. No stale deletes: a delete applies only on top of the version it was based on.
      if (version.get(key) !== c.baseVersion) out.push(`stale delete: seq ${c.seq} deleted ${c.path} based on ${c.baseVersion}, current was ${version.get(key)}`);
      deletedWith.set(key, { time: c.time, hashes: new Set(history.get(key)) });
    } else if (c.op === "put") {
      // 3. No resurrection: after a delete, a put never brings the key back with content it held
      // before. (A move carries its source note, whatever that holds, so it cannot resurrect.)
      // Exempt: a user put that content there again after the delete, or a user moved it onto
      // another path (acting on the note, so it survives, like an edit) and the server followed
      // a concurrent move of that path back here.
      const gone = deletedWith.get(key);
      for (const h of [c.hash, c.submitted]) {
        if (!h || !gone?.hashes.has(h)) continue;
        if (w.placed.some((p) => p.hash === h && (p.key === key ? p.time >= gone.time : p.moved))) continue;
        out.push(`resurrection: seq ${c.seq} brought back ${c.path} (${h.slice(0, 8)}) after it was deleted`);
      }
    }
    remember(key, c.hash);
    remember(key, c.submitted);
    version.set(key, c.seq);
    if (c.op === "move" && c.from !== undefined) version.set(pathKey(c.from), c.seq);
  }

  // The server's rows are exactly what its log says.
  const replay = new Map<string, Pick<FileRow, "path" | "hash" | "version">>();
  for (const c of changes) {
    if (c.op === "move" && c.from !== undefined && pathKey(c.from) !== pathKey(c.path)) replay.delete(pathKey(c.from));
    if (c.hash === null) replay.delete(pathKey(c.path));
    else replay.set(pathKey(c.path), { path: c.path, hash: c.hash, version: c.seq });
  }
  const rows = w.store.liveRows();
  const same = rows.length === replay.size && rows.every((r) => {
    const x = replay.get(pathKey(r.path));
    return x && x.path === r.path && x.hash === r.hash && x.version === r.version;
  });
  if (!same) out.push("server rows do not match a replay of its change log");

  return out;
}
