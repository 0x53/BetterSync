import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConcurrentChangeError, MemoryVaultStore, SyncEngine, Vault, type LocalFs, type Remote } from "@bettersync/core";
import { DiskFs } from "../src/fs.ts";
import { FileStateStore, FolderLock } from "../src/state.ts";

/**
 * The engine on a real disk, against an in-process server: the race M1
 * could only rule out in the simulator. A user saves an edit after the
 * engine read the note and decided to replace it; the edit must survive.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function remoteFor(vault: Vault, device: string): Remote {
  return {
    state: async () => vault.state(),
    changes: async (after) => vault.changes(after),
    hasBlob: async (h) => vault.hasBlob(h),
    putBlob: (h, b) => vault.putBlob(h, b),
    getBlob: async (h) => vault.blob(h)!,
    ops: (ops) => vault.applyOps(device, ops),
  };
}

/** DiskFs, except that a user saves `edit` to `path` just before the engine's next write or remove there. */
function racing(fs: DiskFs, folder: string, path: string, edit: string): LocalFs & { armed: boolean; fired: boolean } {
  const wrapper = {
    armed: false,
    fired: false,
    list: () => fs.list(),
    stat: (p: string) => fs.stat(p),
    variants: (p: string) => fs.variants(p),
    read: (p: string) => fs.read(p),
    rename: (a: string, b: string) => fs.rename(a, b),
    write: async (p: string, bytes: Uint8Array) => {
      fire(p);
      return fs.write(p, bytes);
    },
    remove: async (p: string) => {
      fire(p);
      return fs.remove(p);
    },
  };
  const fire = (p: string) => {
    if (p !== path || !wrapper.armed || wrapper.fired) return;
    wrapper.fired = true;
    Bun.sleepSync(5); // a later mtime, as a real save would have
    writeFileSync(join(folder, path), edit);
  };
  return wrapper;
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bettersync-engine-"));
  dirs.push(dir);
  const vault = new Vault(new MemoryVaultStore(), { now: Date.now });
  const open = async (name: string, fs?: (d: DiskFs) => LocalFs, remote?: (r: Remote) => Remote) => {
    const folder = join(dir, name);
    mkdirSync(folder, { recursive: true });
    const disk = new DiskFs(folder);
    const r = remoteFor(vault, name);
    return {
      folder,
      engine: await SyncEngine.open({ fs: fs ? fs(disk) : disk, remote: remote ? remote(r) : r, store: new FileStateStore(join(folder, ".bettersync", "state.json")), device: name, now: Date.now }),
    };
  };
  return { dir, vault, open };
}

const serverTexts = (vault: Vault) => vault.state().files.map((f) => new TextDecoder().decode(vault.blob(f.hash)));

describe("engine on DiskFs", () => {
  for (const kind of ["edit", "delete"] as const) {
    test(`a user edit saved while a remote ${kind} is applied survives`, async () => {
      const { vault, open } = await setup();
      const b = await open("b");
      writeFileSync(join(b.folder, "Note.md"), "one\ntwo\n");
      await b.engine.sync();

      let wrapped: ReturnType<typeof racing> | undefined;
      const a = await open("a", (d) => (wrapped = racing(d, d.root, "Note.md", "one\ntwo\nA's unsaved thought\n")));
      await a.engine.sync();
      expect(readFileSync(join(a.folder, "Note.md"), "utf8")).toBe("one\ntwo\n");
      wrapped!.armed = true;

      if (kind === "edit") writeFileSync(join(b.folder, "Note.md"), "ONE\ntwo\n");
      else rmSync(join(b.folder, "Note.md"));
      await b.engine.sync();

      // a applies b's change; the user's save lands between the engine's read and its write.
      await expect(a.engine.sync()).rejects.toBeInstanceOf(ConcurrentChangeError);
      expect(readFileSync(join(a.folder, "Note.md"), "utf8")).toBe("one\ntwo\nA's unsaved thought\n");
      // The next pass pushes the edit; the server merges it or keeps it as a conflict copy.
      await a.engine.sync();
      await a.engine.sync();
      expect(serverTexts(vault).some((t) => t.includes("A's unsaved thought"))).toBe(true);
      expect(wrapped!.fired).toBe(true);
    });
  }

  test("a same-size edit within the engine's mtime tick is not missed (racy stat)", async () => {
    const { vault, open } = await setup();
    const b = await open("b");
    writeFileSync(join(b.folder, "Note.md"), "aaaa\n");
    await b.engine.sync();
    const a = await open("a");
    await a.engine.sync();

    // b edits; a applies it, recording the file's stat.
    writeFileSync(join(b.folder, "Note.md"), "bbbb\n");
    await b.engine.sync();
    await a.engine.sync();
    const note = join(a.folder, "Note.md");
    expect(readFileSync(note, "utf8")).toBe("bbbb\n");
    const st = lstatSync(note);

    // The user saves a same-size edit in the same timestamp tick, as a coarse clock (ext4, FAT) allows.
    writeFileSync(note, "cccc\n");
    utimesSync(note, st.atimeMs / 1000, st.mtimeMs / 1000);
    expect(lstatSync(note).mtimeMs).toBe(st.mtimeMs);

    await a.engine.sync();
    expect(serverTexts(vault)).toEqual(["cccc\n"]);
  });
});

describe("engine guards on DiskFs", () => {
  test("a folder that is a symlink is not written through, and its notes are not deleted on the server", async () => {
    const { dir, vault, open } = await setup();
    const a = await open("a");
    mkdirSync(join(a.folder, "notes"));
    writeFileSync(join(a.folder, "notes", "x.md"), "x\n");
    await a.engine.sync();

    const outside = join(dir, "outside");
    mkdirSync(outside);
    mkdirSync(join(dir, "b"));
    symlinkSync(outside, join(dir, "b", "notes"));
    const b = await open("b");
    await b.engine.sync();
    await b.engine.sync();
    expect(readdirSync(outside)).toEqual([]);
    await a.engine.sync();
    expect(serverTexts(vault)).toEqual(["x\n"]);
    expect(existsSync(join(a.folder, "notes", "x.md"))).toBe(true);
  });

  test("a new note never replaces a file that appears while it is being written", async () => {
    const { dir } = await setup();
    const fs = new DiskFs(dir);
    const big = new Uint8Array(8 * 1024 * 1024).fill(0x61);
    for (let i = 0; i < 5; i++) {
      const path = `daily-${i}.md`;
      expect(await fs.stat(path)).toBeNull();
      setTimeout(() => writeFileSync(join(dir, path), "the user's note\n"), 1);
      const r = await fs.write(path, big).then(() => "written", (e: unknown) => e);
      if (r === "written") {
        // The write finished before the user's file appeared; the user's file then replaced it.
        await Bun.sleep(5);
      } else {
        expect(r).toBeInstanceOf(ConcurrentChangeError);
      }
      expect(readFileSync(join(dir, path), "utf8")).toBe("the user's note\n");
    }
  });

  test("an emptied or missing folder does not delete every note on the server", async () => {
    const { vault, open } = await setup();
    const a = await open("a");
    for (let i = 0; i < 12; i++) writeFileSync(join(a.folder, `n${i}.md`), `${i}\n`);
    await a.engine.sync();
    for (let i = 0; i < 12; i++) rmSync(join(a.folder, `n${i}.md`));
    await expect(a.engine.sync()).rejects.toThrow("refusing to delete");
    renameSync(a.folder, `${a.folder}-moved`);
    await expect(a.engine.sync()).rejects.toThrow("missing");
    expect(vault.state().files.length).toBe(12);
  });

  test("a synced note that grows past the size limit is not deleted on the server", async () => {
    const { vault, open } = await setup();
    const a = await open("a");
    writeFileSync(join(a.folder, "big.md"), "small\n");
    await a.engine.sync();
    writeFileSync(join(a.folder, "big.md"), new Uint8Array(10 * 1024 * 1024 + 1).fill(0x61));
    await a.engine.sync();
    expect(serverTexts(vault)).toEqual(["small\n"]);
  });

  test("an edit saved during a push's round trip is not turned into a conflict with itself", async () => {
    const { vault, open } = await setup();
    let during: (() => void) | undefined;
    const a = await open("a", undefined, (r) => ({
      ...r,
      ops: async (ops) => {
        const res = await r.ops(ops);
        during?.();
        during = undefined;
        return res;
      },
    }));
    const note = join(a.folder, "n.md");
    writeFileSync(note, "one\ntwo\n");
    await a.engine.sync();
    writeFileSync(note, "one\ntwo more\n");
    during = () => writeFileSync(note, "one\ntwo more and more\n");
    await a.engine.sync();
    await a.engine.sync();
    expect(serverTexts(vault)).toEqual(["one\ntwo more and more\n"]);
  });

  test("a client pointed at another server, or a server restored to an older state, starts over", async () => {
    const { vault, open } = await setup();
    let target = vault;
    const a = await open("a", undefined, () => remoteFor(new Proxy({} as Vault, { get: (_, k) => (target as never)[k] && (target[k as keyof Vault] as (...x: unknown[]) => unknown).bind(target) }), "a"));
    writeFileSync(join(a.folder, "mine.md"), "mine\n");
    writeFileSync(join(a.folder, "n.md"), "old note\n");
    await a.engine.sync();

    // Another server, where n.md is a different note at the same version.
    const other = new Vault(new MemoryVaultStore("other"), { now: Date.now });
    const theirs = new TextEncoder().encode("their note\n");
    const h = await (await import("@bettersync/core")).sha256Hex(theirs);
    await other.putBlob(h, theirs);
    await other.applyOps("b", [{ op: "put", path: "n.md", hash: h, baseVersion: null }]);
    target = other;
    rmSync(join(a.folder, "n.md"));
    await a.engine.sync();
    await a.engine.sync();
    const texts = other.state().files.map((f) => `${f.path}=${new TextDecoder().decode(other.blob(f.hash))}`);
    expect(texts).toContain("n.md=their note\n");
    expect(texts).toContain("mine.md=mine\n");
  });

  test("a server restored from a backup of itself, then written past the client's cursor, is noticed", async () => {
    const { vault, open } = await setup();
    let target = vault;
    const a = await open("a", undefined, () => remoteFor(new Proxy({} as Vault, { get: (_, k) => (target[k as keyof Vault] as (...x: unknown[]) => unknown).bind(target) }), "a"));
    for (const n of ["a", "b", "c"]) writeFileSync(join(a.folder, `${n}.md`), `${n} from a\n`);
    await a.engine.sync();
    expect(a.engine.cursor).toBe(3);

    // The restored copy has the same vault id, and another device writes to it first.
    const restored = new Vault(new MemoryVaultStore(), { now: Date.now });
    const { sha256Hex } = await import("@bettersync/core");
    for (const [path, text] of [["a.md", "a from b\n"], ["b.md", "b from b\n"], ["x.md", "x\n"], ["y.md", "y\n"]] as const) {
      const bytes = new TextEncoder().encode(text);
      const h = await sha256Hex(bytes);
      await restored.putBlob(h, bytes);
      await restored.applyOps("b", [{ op: "put", path, hash: h, baseVersion: null }]);
    }
    target = restored;
    // a's state says a.md is at version 1, which on the restored server is b's note.
    rmSync(join(a.folder, "a.md"));
    await a.engine.sync();
    await a.engine.sync();
    const texts = new Map(restored.state().files.map((f) => [f.path, new TextDecoder().decode(restored.blob(f.hash))]));
    expect(texts.get("a.md")).toBe("a from b\n");
    expect(texts.get("c.md")).toBe("c from a\n");
  });

  test("only one process may sync a folder", async () => {
    const { dir } = await setup();
    const lock = await FolderLock.acquire(dir);
    await expect(FolderLock.acquire(dir)).rejects.toThrow("already being synced");
    lock.releaseSync();
    (await FolderLock.acquire(dir)).releaseSync();
  });
});
