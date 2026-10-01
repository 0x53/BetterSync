import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConcurrentChangeError, MemoryVaultStore, SyncEngine, Vault, type LocalFs, type Remote } from "@bettersync/core";
import { DiskFs } from "../src/fs.ts";
import { FileStateStore } from "../src/state.ts";

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
  const open = async (name: string, fs?: (d: DiskFs) => LocalFs) => {
    const folder = join(dir, name);
    mkdirSync(folder);
    const disk = new DiskFs(folder);
    return {
      folder,
      engine: await SyncEngine.open({ fs: fs ? fs(disk) : disk, remote: remoteFor(vault, name), store: new FileStateStore(join(folder, ".bettersync", "state.json")), device: name, now: Date.now }),
    };
  };
  return { vault, open };
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
