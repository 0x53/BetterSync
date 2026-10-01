import { describe, expect, test } from "bun:test";
import { ConcurrentChangeError, LocalBusyError, MemoryVaultStore, SyncEngine, Vault, type LocalFs, type Remote } from "@bettersync/core";
import { SimFs, type Clobber } from "@bettersync/sim";
import { ObsidianFs } from "../src/obsidian-fs.ts";
import { FakeVault, obsidianFs } from "./fake-vault.ts";

/**
 * ObsidianFs on a fake vault that behaves like Obsidian's (see fake-vault.ts),
 * with the engine and an in-process server where it matters.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

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

let tick = Date.now() - 60_000;
const clock = () => (tick += 10);

function disk(caseInsensitive: boolean) {
  const clobbered: Clobber[] = [];
  const fs = new SimFs(caseInsensitive, clock);
  return { fs, clobbered, view: fs.engineView("test", clobbered, () => 0) };
}

async function world(opts: { guard?: boolean } = {}) {
  const server = new Vault(new MemoryVaultStore(), { now: Date.now });
  const phone = disk(true);
  const { fs, vault } = obsidianFs(phone.fs, phone.view);
  const phoneFs: LocalFs = opts.guard === false ? new ObsidianFs(vault, () => [], true) : fs;
  if (opts.guard === false) vault.on((k, e, o) => (phoneFs as ObsidianFs).noteEvent(k, e, o));
  const agent = disk(false);
  const open = (device: string, local: LocalFs) => {
    let saved: string | null = null;
    return SyncEngine.open({ fs: local, remote: remoteFor(server, device), store: { load: async () => saved, save: async (j) => void (saved = j) }, device, now: Date.now });
  };
  return { server, phone, vault, agent, phoneEngine: await open("phone", phoneFs), agentEngine: await open("agent", agent.view) };
}

const serverTexts = (v: Vault) => new Map(v.state().files.map((f) => [f.path, dec.decode(v.blob(f.hash))]));

/** Syncs until a pass goes through, as the runner would after ConcurrentChangeError. */
async function settle(engine: SyncEngine) {
  for (let i = 0; i < 5; i++) {
    try {
      return await engine.sync();
    } catch (e) {
      if (!(e instanceof ConcurrentChangeError)) throw e;
      await Promise.resolve();
    }
  }
  throw new Error("did not settle");
}

describe("unsaved typing in an open editor", () => {
  async function scenario(guard: boolean, agentLines: string[], phoneLines: string[]) {
    const w = await world({ guard });
    w.agent.fs.userWrite("Note.md", enc.encode("a\nb\nc\n"));
    await w.agentEngine.sync();
    await w.phoneEngine.sync();
    const ed = w.vault.open("Note.md");
    ed.type(phoneLines.join("\n"));
    w.agent.fs.userWrite("Note.md", enc.encode(agentLines.join("\n")));
    await w.agentEngine.sync();
    await settle(w.phoneEngine);
    await ed.save();
    await settle(w.phoneEngine);
    await settle(w.agentEngine);
    return { w, ed, texts: [...serverTexts(w.server).values()].join("\n---\n") };
  }

  test("an overlapping remote edit does not erase it: it reaches the server as a conflict copy", async () => {
    const { w, texts } = await scenario(true, ["a", "b-agent", "c", ""], ["a", "b-phone", "c", ""]);
    expect(texts).toContain("b-phone");
    expect(texts).toContain("b-agent");
    expect([...serverTexts(w.server).keys()].some((p) => p.includes("(conflict"))).toBe(true);
  });

  test("without the guard, Obsidian's own merge would drop it (why the guard exists)", async () => {
    const { texts } = await scenario(false, ["a", "b-agent", "c", ""], ["a", "b-phone", "c", ""]);
    expect(texts).not.toContain("b-phone");
  });

  test("a remote edit elsewhere in the note merges with it on the server", async () => {
    const { w, ed } = await scenario(true, ["a", "b", "c-agent", ""], ["a-phone", "b", "c", ""]);
    expect(serverTexts(w.server).get("Note.md")).toBe("a-phone\nb\nc-agent\n");
    expect(ed.buffer).toBe("a-phone\nb\nc-agent\n");
    expect(ed.dirty).toBe(false);
  });

  test("a remote delete waits for the typing, which then brings the note back", async () => {
    const w = await world();
    w.agent.fs.userWrite("Note.md", enc.encode("a\n"));
    await w.agentEngine.sync();
    await w.phoneEngine.sync();
    const ed = w.vault.open("Note.md");
    ed.type("a\nmore\n");
    w.agent.fs.userRemove("Note.md");
    await w.agentEngine.sync();
    await w.phoneEngine.sync();
    expect(ed.buffer).toBe("a\nmore\n");
    expect(w.phone.fs.get("Note.md")).toBeDefined();
    await ed.save();
    await settle(w.phoneEngine);
    expect(serverTexts(w.server).get("Note.md")).toBe("a\nmore\n");
  });

  /** Typing on one line without a pause while remote edits keep landing: a pass between every keystroke or two. */
  async function busyTyping(agentLine: number, agentEvery: number) {
    const w = await world();
    w.agent.fs.userWrite("Busy.md", enc.encode("typed:\nmiddle\nagent 0\n"));
    await w.agentEngine.sync();
    await w.phoneEngine.sync();
    const ed = w.vault.open("Busy.md");
    const phoneFs = w.phoneEngine as unknown as { deps: { fs: ObsidianFs } };
    let typed = "";
    for (let i = 1; i <= 30; i++) {
      // The plugin saves editors before a pass, except a busy note's; the next keystroke lands before the pass runs.
      if (i % 2 === 0 && !phoneFs.deps.fs.isBusy("Busy.md")) await ed.save();
      typed += String.fromCharCode(97 + (i % 26));
      const lines = ed.buffer.split("\n");
      lines[0] = `${lines[0]}${typed.at(-1)}`;
      ed.type(lines.join("\n"));
      if (i % agentEvery === 0) {
        // The agent is up to date when it edits, so its edit lands first and the phone's typing is the one that clashes.
        await settle(w.agentEngine);
        const cur = dec.decode(w.agent.fs.get("Busy.md")!.bytes).split("\n");
        cur[agentLine] = `agent ${i}`;
        w.agent.fs.userWrite("Busy.md", enc.encode(cur.join("\n")));
        await settle(w.agentEngine);
      }
      await settle(w.phoneEngine);
    }
    // Typing stops; Obsidian's autosave; everyone settles.
    await ed.save();
    for (let i = 0; i < 3; i++) {
      await settle(w.phoneEngine);
      await settle(w.agentEngine);
    }
    return { w, ed, typed, texts: serverTexts(w.server) };
  }

  test("continuous typing beside remote edits merges every time: no conflict copies, nothing lost", async () => {
    const { ed, typed, texts } = await busyTyping(2, 3);
    expect([...texts.keys()]).toEqual(["Busy.md"]);
    expect(texts.get("Busy.md")).toBe(`typed:${typed}\nmiddle\nagent 30\n`);
    expect(ed.buffer).toBe(texts.get("Busy.md")!);
  });

  test("a remote edit to the very line being typed makes one conflict copy, not one per pass, and loses no keystroke", async () => {
    const { w, texts } = await busyTyping(0, 10);
    const copies = [...texts.keys()].filter((p) => p.includes("(conflict"));
    // Three overlapping remote edits (after keystrokes 10, 20 and 30): at most one copy each.
    expect(copies.length).toBeLessThanOrEqual(3);
    // Every keystroke is in some version on the server: the last line-0 text of each typing run survives.
    const all = [...texts.values()].map((t) => t.split("\n")[0]!);
    expect(all.some((l) => l.endsWith("e"))).toBe(true);
    expect(dec.decode(w.phone.fs.get("Busy.md")!.bytes)).toBe(texts.get("Busy.md")!);
  });
});

describe("ObsidianFs", () => {
  test("new notes land in existing folders on a case-insensitive disk", async () => {
    const d = disk(true);
    const { fs } = obsidianFs(d.fs, d.view);
    d.fs.userWrite("Projects/a.md", enc.encode("a"));
    const st = await fs.write("projects/b.md", enc.encode("b"));
    expect(st.path).toBe("Projects/b.md");
    expect(d.fs.all().map((e) => e.name)).toEqual(["Projects/a.md", "Projects/b.md"]);
  });

  test("on a case-sensitive disk, other-case names are other files", async () => {
    const d = disk(false);
    const { fs } = obsidianFs(d.fs, d.view);
    d.fs.userWrite("Note.md", enc.encode("a"));
    expect(await fs.stat("note.md")).toBeNull();
    expect(await fs.variants("NOTE.md")).toEqual(["Note.md"]);
    await fs.write("note.md", enc.encode("b"));
    expect(await fs.variants("NOTE.md")).toEqual(["Note.md", "note.md"]);
  });

  test("creates nested folders and removes the ones its deletes and moves empty", async () => {
    const d = disk(true);
    const { fs, vault } = obsidianFs(d.fs, d.view);
    await fs.write("A/B/C/n.md", enc.encode("n"));
    expect(vault.getAbstractFileByPath("A/B/C")).not.toBeNull();
    await fs.read("A/B/C/n.md");
    await fs.rename("A/B/C/n.md", "D/n.md");
    expect(vault.getAbstractFileByPath("A")).toBeNull();
    await fs.read("D/n.md");
    await fs.remove("D/n.md");
    expect(vault.getAbstractFileByPath("D")).toBeNull();
  });

  test("a case-only rename on a case-insensitive disk", async () => {
    const d = disk(true);
    const { fs } = obsidianFs(d.fs, d.view);
    d.fs.userWrite("Note.md", enc.encode("x"));
    await fs.read("Note.md");
    await fs.rename("Note.md", "note.md");
    expect(await fs.variants("NOTE.md")).toEqual(["note.md"]);
    expect(d.fs.all().map((e) => e.name)).toEqual(["note.md"]);
  });

  test("hidden paths are not listed", async () => {
    const d = disk(false);
    const { fs } = obsidianFs(d.fs, d.view);
    d.fs.userWrite(".obsidian/app.json", enc.encode("{}"));
    d.fs.userWrite(".drafts/x.md", enc.encode("x"));
    d.fs.userWrite("Note.md", enc.encode("x"));
    expect((await fs.list()).map((s) => s.path)).toEqual(["Note.md"]);
  });

  test("NFD names are reported and found as NFC, and keep their name on disk", async () => {
    const d = disk(false);
    // The simulator's engine view only takes NFC names; Obsidian writes the name on disk as it is.
    const raw: LocalFs = { ...d.view, write: async (p, b) => (d.fs.userWrite(p, b), { path: p, mtime: 0, size: b.length }) };
    const { fs } = obsidianFs(d.fs, raw);
    const nfd = "Notes/Émigré.md".normalize("NFD");
    d.fs.userWrite(nfd, enc.encode("x"));
    const nfc = "Notes/Émigré.md";
    expect((await fs.list()).map((s) => s.path)).toEqual([nfc]);
    expect(await fs.variants(nfc)).toEqual([nfc]);
    expect(dec.decode((await fs.read(nfc))!)).toBe("x");
    await fs.write(nfc, enc.encode("y"));
    expect(d.fs.all().map((e) => e.name)).toEqual([nfd]);
  });

  test("refuses to replace, delete or rename a note saved since it was read", async () => {
    for (const act of ["write", "remove", "rename"] as const) {
      const d = disk(true);
      const { fs } = obsidianFs(d.fs, d.view);
      d.fs.userWrite("Note.md", enc.encode("old"));
      await fs.read("Note.md");
      d.fs.userWrite("Note.md", enc.encode("new edit"));
      const go = act === "write" ? fs.write("Note.md", enc.encode("remote")) : act === "remove" ? fs.remove("Note.md") : fs.rename("Note.md", "Other.md");
      await expect(go).rejects.toBeInstanceOf(ConcurrentChangeError);
      expect(dec.decode(d.fs.get("Note.md")!.bytes)).toBe("new edit");
    }
  });

  test("refuses to write where a note appeared, or to recreate one deleted, since it looked", async () => {
    const d = disk(true);
    const { fs } = obsidianFs(d.fs, d.view);
    expect(await fs.stat("New.md")).toBeNull();
    d.fs.userWrite("New.md", enc.encode("user"));
    await expect(fs.write("New.md", enc.encode("remote"))).rejects.toBeInstanceOf(ConcurrentChangeError);

    d.fs.userWrite("Gone.md", enc.encode("x"));
    await fs.read("Gone.md");
    d.fs.userRemove("Gone.md");
    await expect(fs.write("Gone.md", enc.encode("remote"))).rejects.toBeInstanceOf(ConcurrentChangeError);
  });

  test("the key index follows vault events between listings", async () => {
    const d = disk(true);
    const { fs } = obsidianFs(d.fs, d.view);
    await fs.list();
    d.fs.userWrite("Later.md", enc.encode("x"));
    expect(await fs.variants("later.md")).toEqual(["Later.md"]);
    d.fs.userRename("Later.md", "Moved.md");
    expect(await fs.variants("later.md")).toEqual([]);
    expect(await fs.variants("MOVED.md")).toEqual(["Moved.md"]);
  });
});

// Keep the fake honest about the one behaviour the guard depends on.
test("fake editor: overlapping typing is dropped on reload, other typing kept", () => {
  const d = disk(true);
  const v = new FakeVault(d.fs, d.view);
  d.fs.userWrite("N.md", enc.encode("a\nb\n"));
  const ed = v.open("N.md");
  ed.type("A\nB\n");
  d.fs.userWrite("N.md", enc.encode("a\nremote\n"));
  expect(ed.buffer).toBe("A\nremote\n");
});

// Chromium answered hasBlob from a cached GET of a blob that a fresh server lacked; the put was then refused forever.
test("engine: a server that lacks a blob it was said to have still gets it", async () => {
  const server = new Vault(new MemoryVaultStore(), { now: Date.now });
  const d = disk(false);
  let saved: string | null = null;
  const lying: Remote = { ...remoteFor(server, "phone"), hasBlob: async () => true };
  const engine = await SyncEngine.open({ fs: d.view, remote: lying, store: { load: async () => saved, save: async (j) => void (saved = j) }, device: "phone", now: Date.now });
  d.fs.userWrite("Note.md", enc.encode("x\n"));
  const r = await engine.sync();
  expect(r.rejected).toEqual([]);
  expect(serverTexts(server).get("Note.md")).toBe("x\n");
});

describe("adapter safety nets", () => {
  test("creating a note never replaces a file on disk the vault index does not list yet", async () => {
    const d = disk(false);
    const { fs, vault } = obsidianFs(d.fs, d.view);
    d.fs.userWrite("X.md", enc.encode("written by another app\n"));
    // Obsidian's watcher has not caught up: the index does not know the file.
    const real = vault.getAbstractFileByPath.bind(vault);
    vault.getAbstractFileByPath = (p) => (p === "X.md" ? null : real(p));
    const files = vault.getFiles.bind(vault);
    vault.getFiles = () => files().filter((f) => f.path !== "X.md");
    await expect(fs.write("X.md", enc.encode("from the server\n"))).rejects.toBeInstanceOf(ConcurrentChangeError);
    expect(dec.decode(d.fs.get("X.md")!.bytes)).toBe("written by another app\n");
  });

  test("an editor whose saved text Obsidian does not expose is never written through", async () => {
    const d = disk(false);
    const { fs, vault } = obsidianFs(d.fs, d.view);
    d.fs.userWrite("N.md", enc.encode("a\nb\n"));
    await fs.list();
    await fs.read("N.md");
    const ed = vault.open("N.md");
    ed.savedText = () => null as never;
    ed.type("a\nb\ntyping\n");
    await expect(fs.write("N.md", enc.encode("A\nb\n"))).rejects.toBeInstanceOf(LocalBusyError);
    expect(ed.text()).toBe("a\nb\ntyping\n");
    expect(fs.isBusy("N.md")).toBe(true);
    fs.clearBusy("N.md");
    expect(fs.isBusy("N.md")).toBe(false);
  });

  test("a change merged into an editor with typing reports a stat the engine cannot cache", async () => {
    const d = disk(false);
    const { fs, vault } = obsidianFs(d.fs, d.view);
    d.fs.userWrite("N.md", enc.encode("a\nb\nc\n"));
    await fs.list();
    await fs.read("N.md");
    const ed = vault.open("N.md");
    ed.type("a\nb\nc\ntyping\n");
    const st = await fs.write("N.md", enc.encode("A\nb\nc\n"));
    expect(ed.text()).toBe("A\nb\nc\ntyping\n");
    expect(st.mtime).toBe(-1);
  });
});
