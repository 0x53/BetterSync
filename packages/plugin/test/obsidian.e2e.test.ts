import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientProc, notesIn, ServerProc } from "../../headless/test/harness.ts";
import { ObsidianApp } from "./obsidian-harness.ts";

/**
 * The plugin in a real Obsidian, against a real server, with a headless
 * client as the other device. Opt-in: set OBSIDIAN_CDP to the DevTools URL
 * of an Obsidian started with --remote-debugging-port and a THROWAWAY test
 * vault open (every test wipes it). Build the plugin first (bun run
 * --cwd packages/plugin dev).
 *
 * The server listens on 127.0.0.1:OBSIDIAN_SERVER_PORT (default 8787), and
 * Obsidian reaches it at OBSIDIAN_SERVER_URL (default the same address), so
 * Obsidian may run on another machine with a tunnel between the two.
 */
const CDP = process.env.OBSIDIAN_CDP;
const PORT = Number(process.env.OBSIDIAN_SERVER_PORT ?? 8787);
const SERVER_URL = process.env.OBSIDIAN_SERVER_URL ?? `http://127.0.0.1:${PORT}`;

const dirs: string[] = [];
let obs: ObsidianApp;
let server: ServerProc;
let agent: ClientProc;

beforeAll(async () => {
  if (CDP) obs = await ObsidianApp.connect(CDP);
});

// Resetting a vault of thousands of notes (the scale test) takes a while.
const HOOK_MS = 300_000;

afterAll(async () => {
  await obs?.reset().catch(() => {});
  await obs?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, HOOK_MS);

async function freshServer() {
  const dir = mkdtempSync(join(tmpdir(), "bettersync-obsidian-"));
  dirs.push(dir);
  server = new ServerProc(join(dir, "data"), PORT);
  await server.init();
  await server.start();
  agent = new ClientProc(join(dir, "agent"), "agent-1", server);
  return dir;
}

beforeEach(async () => {
  if (!CDP) return;
  await freshServer();
  await obs.reset();
}, HOOK_MS);

afterEach(async () => {
  if (process.env.OBSIDIAN_LOG === "1" && obs) console.log((await obs.log().catch(() => [])).join("\n"));
  agent?.kill();
  server?.kill();
});

const install = (extra: { token?: string; keepState?: boolean; paused?: boolean } = {}) =>
  obs.installPlugin({ server: SERVER_URL, token: extra.token ?? server.token, device: "obsidian", ...(extra.paused !== undefined && { paused: extra.paused }) }, { keepState: extra.keepState ?? false });

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 10_000): Promise<number> {
  const t0 = performance.now();
  for (;;) {
    if (await fn()) return performance.now() - t0;
    if (performance.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const agentRead = (p: string) => (existsSync(join(agent.folder, p)) ? readFileSync(join(agent.folder, p), "utf8") : null);
const agentWrite = (p: string, text: string) => {
  mkdirSync(join(agent.folder, p, ".."), { recursive: true });
  writeFileSync(join(agent.folder, p), text);
};
const obsRead = async (p: string) => (await obs.notes()).get(p) ?? null;
const serverTexts = async () => {
  const st = await server.state();
  const out = new Map<string, string>();
  for (const f of st.files) {
    const r = await fetch(`${server.url}/v1/blobs/${f.hash}`, { headers: { Authorization: `Bearer ${server.token}`, "X-Device-Name": "test" } });
    out.set(f.path, await r.text());
  }
  return out;
};
const synced = () => until("status synced", async () => ["synced", "conflict"].includes((await obs.status()) ?? ""));

describe.skipIf(!CDP)("Obsidian plugin end to end", () => {
  test("first sync of a non-empty vault: uploads, downloads, and keeps both sides of a difference", async () => {
    agentWrite("Server only.md", "from the server\n");
    agentWrite("Both same.md", "same\n");
    agentWrite("Both differ.md", "server version\n");
    expect(await agent.once()).toBe(0);
    await obs.write("Vault only.md", "from the vault\n");
    await obs.write("Both same.md", "same\n");
    await obs.write("Both differ.md", "vault version\n");

    await install();
    await synced();
    await until("conflict copy", async () => [...(await obs.notes()).keys()].some((p) => p.startsWith("Both differ (conflict")));
    const notes = await obs.notes();
    expect(notes.get("Server only.md")).toBe("from the server\n");
    expect(notes.get("Both same.md")).toBe("same\n");
    expect(notes.get("Both differ.md")).toBe("server version\n");
    expect([...notes.entries()].find(([p]) => p.startsWith("Both differ (conflict"))?.[1]).toBe("vault version\n");
    const onServer = await serverTexts();
    expect(onServer.get("Vault only.md")).toBe("from the vault\n");
    expect(onServer.size).toBe(5);
    expect(await obs.status()).toBe("conflict");
  }, 60_000);

  test("changes reach the other device within 2 s, both ways", async () => {
    agent.start();
    await install();
    await synced();
    const toObs: number[] = [];
    const toAgent: number[] = [];
    for (let i = 0; i < 4; i++) {
      agentWrite("Latency.md", `agent ${i}\n`);
      toObs.push(await until("agent edit in Obsidian", async () => (await obsRead("Latency.md")) === `agent ${i}\n`, 5000));
      await Bun.sleep(300);
      await obs.write("Latency.md", `obsidian ${i}\n`);
      toAgent.push(await until("Obsidian edit at the agent", () => agentRead("Latency.md") === `obsidian ${i}\n`, 5000));
      await Bun.sleep(300);
    }
    console.log(`latency ms, agent → Obsidian: ${toObs.map(Math.round).join(", ")}; Obsidian → agent: ${toAgent.map(Math.round).join(", ")}`);
    for (const t of [...toObs, ...toAgent]) expect(t).toBeLessThan(2000);
  }, 60_000);

  test("typing reaches the other device about 1 s after it stops, without waiting for Obsidian's autosave", async () => {
    agent.start();
    agentWrite("Typing.md", "start\n");
    await install();
    await until("note in Obsidian", async () => (await obsRead("Typing.md")) !== null);
    await obs.open("Typing.md");
    for (const ch of "hello") {
      await obs.typeAt(0, ch);
      await Bun.sleep(150);
    }
    const t = await until("typing at the agent", () => agentRead("Typing.md") === "starthello\n", 5000);
    console.log(`typing → agent: ${Math.round(t)} ms after the last keystroke`);
    expect(t).toBeLessThan(2500);
  }, 30_000);

  test("a remote edit refreshes an open editor", async () => {
    agent.start();
    agentWrite("Open.md", "one\n");
    await install();
    await until("note in Obsidian", async () => (await obsRead("Open.md")) === "one\n");
    await obs.open("Open.md");
    await obs.eval(() => (globalThis as any).app.workspace.activeEditor.editor.setCursor({ line: 0, ch: 2 }));
    agentWrite("Open.md", "one\ntwo\n");
    await until("editor shows the edit", async () => (await obs.editorText()) === "one\ntwo\n", 5000);
    // An edit elsewhere leaves the cursor where it was.
    agentWrite("Open.md", "zero\none\ntwo\nthree\n");
    await until("editor shows the second edit", async () => (await obs.editorText()) === "zero\none\ntwo\nthree\n", 5000);
    expect(await obs.eval(() => (globalThis as any).app.workspace.activeEditor.editor.getCursor())).toEqual({ line: 1, ch: 2 });
  }, 30_000);

  test("unsaved typing survives an overlapping remote edit: the other version stays, the typing becomes a conflict copy", async () => {
    agentWrite("Clash.md", "a\nb\nc\n");
    expect(await agent.once()).toBe(0);
    await install();
    await until("note in Obsidian", async () => (await obsRead("Clash.md")) === "a\nb\nc\n");
    await synced();
    // Pause so the typing stays unsaved while the remote edit lands.
    await obs.eval(() => (globalThis as any).app.plugins.plugins.bettersync.setPaused(true));
    await obs.open("Clash.md");
    await obs.replaceLine(1, "b typed in obsidian");
    agentWrite("Clash.md", "a\nb from the agent\nc\n");
    expect(await agent.once()).toBe(0);
    await obs.eval(() => (globalThis as any).app.plugins.plugins.bettersync.setPaused(false));
    await until("conflict copy on the server", async () => [...(await serverTexts()).keys()].some((p) => p.includes("(conflict")), 10_000);
    const texts = [...(await serverTexts()).values()].join("\n");
    expect(texts).toContain("b typed in obsidian");
    expect(texts).toContain("b from the agent");
    await until("conflict notice", async () => (await obs.notices()).some((n) => n.includes("saved as")), 5000);
    await until("status conflict", async () => (await obs.status()) === "conflict");
  }, 60_000);

  test("unsaved typing and a remote edit elsewhere in the note merge", async () => {
    agentWrite("Merge.md", "a\nb\nc\n");
    expect(await agent.once()).toBe(0);
    await install();
    await until("note in Obsidian", async () => (await obsRead("Merge.md")) === "a\nb\nc\n");
    await synced();
    await obs.eval(() => (globalThis as any).app.plugins.plugins.bettersync.setPaused(true));
    await obs.open("Merge.md");
    await obs.replaceLine(0, "A");
    agentWrite("Merge.md", "a\nb\nC\n");
    expect(await agent.once()).toBe(0);
    await obs.eval(() => (globalThis as any).app.plugins.plugins.bettersync.setPaused(false));
    await until("merged on the server", async () => (await serverTexts()).get("Merge.md") === "A\nb\nC\n", 10_000);
    await until("merged in the editor", async () => (await obs.editorText()) === "A\nb\nC\n", 5000);
    expect([...(await serverTexts()).keys()]).toEqual(["Merge.md"]);
  }, 60_000);

  test("continuous typing while remote edits keep arriving loses nothing", async () => {
    agent.start();
    agentWrite("Busy.md", "typed:\nmiddle\nagent 0\n");
    await install();
    await until("note in Obsidian", async () => (await obsRead("Busy.md")) !== null);
    await obs.open("Busy.md");
    let typed = "";
    let agentN = 0;
    const t0 = Date.now();
    const agentLoop = (async () => {
      while (Date.now() - t0 < 8000) {
        await Bun.sleep(600);
        // The agent edits its own line, reading the current file first as an agent would.
        const cur = agentRead("Busy.md");
        if (cur === null) continue;
        agentWrite("Busy.md", cur.replace(/agent \d+/, `agent ${++agentN}`));
      }
    })();
    while (Date.now() - t0 < 8000) {
      const ch = String.fromCharCode(97 + (typed.length % 26));
      await obs.typeAt(0, ch);
      typed += ch;
      await Bun.sleep(40 + Math.floor(Math.random() * 120));
    }
    await agentLoop;
    const want = `typed:${typed}`;
    try {
      await until("typing at the agent", () => agentRead("Busy.md")?.split("\n")[0] === want, 15_000);
    } finally {
      if (agentRead("Busy.md")?.split("\n")[0] !== want) {
        console.log(`want: ${JSON.stringify(want)}\nagent: ${JSON.stringify(agentRead("Busy.md"))}\neditor: ${JSON.stringify(await obs.editorText())}\nobsidian disk: ${JSON.stringify(await obsRead("Busy.md"))}\nserver: ${JSON.stringify([...(await serverTexts())])}`);
        console.log((await obs.log()).slice(-40).join("\n"));
      }
    }
    const texts = [...(await serverTexts()).entries()];
    // Nothing lost: every keystroke is in the note, and the agent's edits merged beside it.
    expect(texts.find(([p]) => p === "Busy.md")?.[1].split("\n")[0]).toBe(want);
    console.log(`typed ${typed.length} characters while the agent made ${agentN} edits; notes on the server: ${texts.map(([p]) => p).join(", ")}`);
  }, 60_000);

  test("renames and deletes propagate both ways; emptied folders go", async () => {
    agent.start();
    await install();
    await synced();
    await obs.write("Folder/Note.md", "n\n");
    await obs.write("Linker.md", "see [[Note]]\n");
    await until("note at the agent", () => agentRead("Folder/Note.md") === "n\n");
    await obs.rename("Folder/Note.md", "Other/Renamed.md");
    await until("rename at the agent", () => agentRead("Other/Renamed.md") === "n\n" && agentRead("Folder/Note.md") === null);
    await until("folder pruned at the agent", () => !existsSync(join(agent.folder, "Folder")));

    // The other way, with the note open: the editor follows it.
    await obs.open("Other/Renamed.md");
    mkdirSync(join(agent.folder, "Moved"), { recursive: true });
    const { renameSync } = await import("node:fs");
    renameSync(join(agent.folder, "Other", "Renamed.md"), join(agent.folder, "Moved", "Again.md"));
    await until("rename in Obsidian", async () => (await obsRead("Moved/Again.md")) === "n\n" && (await obsRead("Other/Renamed.md")) === null);
    expect(await obs.eval(() => (globalThis as any).app.workspace.activeEditor?.file?.path)).toBe("Moved/Again.md");
    await until("folder pruned in Obsidian", () => obs.eval(() => (globalThis as any).app.vault.getAbstractFileByPath("Other") === null));

    rmSync(join(agent.folder, "Moved", "Again.md"));
    await until("delete in Obsidian", async () => (await obsRead("Moved/Again.md")) === null);
    await obs.remove("Linker.md");
    await until("delete at the agent", () => agentRead("Linker.md") === null);
  }, 60_000);

  test("case: case-only renames both ways, and new notes in a folder that differs only in case", async () => {
    agent.start();
    await install();
    await synced();
    const insensitive = await obs.eval(() => (globalThis as any).app.vault.adapter.exists("NONEXISTENT-PROBE".toLowerCase()).then(async () => {
      const a = (globalThis as any).app.vault.adapter;
      await a.write("case-probe.tmp", "");
      const r = await a.exists("CASE-PROBE.tmp");
      await a.remove("case-probe.tmp");
      return r;
    }));
    const diskNames = (dir: string) => obs.eval(async (dir) => ((await (globalThis as any).app.vault.adapter.list(dir)).files as string[]).map((f) => f.split("/").pop()), dir);

    await obs.write("Note.md", "n\n");
    await until("note at the agent", () => agentRead("Note.md") === "n\n");
    await obs.eval(async () => {
      const app = (globalThis as any).app;
      await app.vault.rename(app.vault.getAbstractFileByPath("Note.md"), "note.md");
    });
    await until("case rename at the agent", () => agentRead("note.md") === "n\n" && !notesIn(agent.folder).has("Note.md"));

    const { renameSync } = await import("node:fs");
    renameSync(join(agent.folder, "note.md"), join(agent.folder, "NOTE.md"));
    await until("case rename in Obsidian's index", async () => (await obsRead("NOTE.md")) === "n\n");
    // And on disk, not only in Obsidian's index.
    await until("case rename on disk", async () => (await diskNames("")).includes("NOTE.md"));

    await obs.write("Projects/a.md", "a\n");
    await until("folder at the agent", () => agentRead("Projects/a.md") === "a\n");
    agentWrite("projects/b.md", "b\n");
    const where = insensitive ? "Projects/b.md" : "projects/b.md";
    await until(`b in ${where}`, async () => (await obsRead(where)) === "b\n");
    await Bun.sleep(1500);
    expect((await serverTexts()).size).toBe(3);
    console.log(`vault disk is case-${insensitive ? "insensitive" : "sensitive"}`);
  }, 60_000);

  test("hidden files and non-notes stay local and untouched", async () => {
    agent.start();
    await install();
    await synced();
    await obs.eval(async () => {
      const a = (globalThis as any).app.vault.adapter;
      if (!(await a.exists(".drafts"))) await a.mkdir(".drafts");
      await a.write(".drafts/secret.md", "hidden\n");
      await a.write("image.png", "png");
    });
    await obs.write("Marker.md", "x\n");
    await until("marker at the agent", () => agentRead("Marker.md") === "x\n");
    expect(existsSync(join(agent.folder, ".drafts"))).toBe(false);
    expect(existsSync(join(agent.folder, "image.png"))).toBe(false);
    expect([...(await serverTexts()).keys()]).toEqual(["Marker.md"]);
  }, 30_000);

  test("pause stops syncing until resumed", async () => {
    agent.start();
    await install({ paused: true });
    await until("status paused", async () => (await obs.status()) === "paused");
    await obs.write("While paused.md", "p\n");
    agentWrite("From agent.md", "a\n");
    await Bun.sleep(2500);
    expect(agentRead("While paused.md")).toBeNull();
    expect(await obsRead("From agent.md")).toBeNull();
    await obs.eval(() => (globalThis as any).app.plugins.plugins.bettersync.setPaused(false));
    await until("both synced", async () => agentRead("While paused.md") === "p\n" && (await obsRead("From agent.md")) === "a\n");
    await synced();
  }, 30_000);

  test("a wrong token shows a notice and the unauthorized status; the right one recovers", async () => {
    await install({ token: "0".repeat(64) });
    await until("status unauthorized", async () => (await obs.status()) === "unauthorized");
    await until("token notice", async () => (await obs.notices()).some((n) => n.includes("rejected the token")));
    await install({ keepState: true });
    await synced();
  }, 30_000);

  test("server down shows offline, and syncing resumes when it returns", async () => {
    await install();
    await synced();
    server.kill();
    await obs.write("Offline.md", "o\n");
    await until("status offline", async () => (await obs.status()) === "offline", 15_000);
    await server.start();
    await until("note reaches the server", async () => (await serverTexts()).get("Offline.md") === "o\n", 70_000);
    await synced();
  }, 120_000);

  test("state survives a restart; lost state is rebuilt without duplicates", async () => {
    agent.start();
    await install();
    await synced();
    for (let i = 0; i < 20; i++) await obs.write(`Bulk/${i}.md`, `note ${i}\n`);
    await until("bulk at the agent", () => agentRead("Bulk/19.md") === "note 19\n");
    const seq = (await server.state()).seq;

    await obs.reload();
    await synced();
    await Bun.sleep(1500);
    expect((await server.state()).seq).toBe(seq);

    await obs.disablePlugin();
    await obs.eval(async () => {
      const a = (globalThis as any).app.vault.adapter;
      await a.remove(`${(globalThis as any).app.vault.configDir}/plugins/bettersync/state.json`);
    });
    agentWrite("After loss.md", "later\n");
    await obs.enablePlugin();
    await until("new note in Obsidian", async () => (await obsRead("After loss.md")) === "later\n");
    await synced();
    await Bun.sleep(1500);
    const st = await server.state();
    expect(st.files.length).toBe(21);
    expect(st.files.some((f) => f.path.includes("conflict"))).toBe(false);
  }, 90_000);

  test.skipIf(process.env.OBSIDIAN_SCALE !== "1")("scale: 3,000 notes down, an idle pass, 3,000 notes up (OBSIDIAN_SCALE=1)", async () => {
    const N = 3000;
    const body = (i: number) => `# Note ${i}\n\n${"Some text here. ".repeat(20)}\n- [ ] todo ${i}\n`;
    for (let i = 0; i < N; i++) agentWrite(`Bulk/${i % 50}/Note ${i}.md`, body(i));
    let t0 = performance.now();
    expect(await agent.once()).toBe(0);
    console.log(`agent uploaded ${N} notes in ${Math.round(performance.now() - t0)} ms`);

    t0 = performance.now();
    await install();
    await until(`${N} notes in Obsidian`, async () => (await obs.eval(() => (globalThis as any).app.vault.getMarkdownFiles().length)) >= N, 300_000);
    await synced();
    const down = performance.now() - t0;

    const idle = await obs.eval(async () => {
      const p = (globalThis as any).app.plugins.plugins.bettersync;
      await p.setPaused(true);
      const engine = p.debug.runner.o.engine;
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        await engine.sync();
        times.push(Math.round(performance.now() - t));
      }
      await p.setPaused(false);
      return times;
    });

    t0 = performance.now();
    await obs.eval(async (n) => {
      const app = (globalThis as any).app;
      if (!app.vault.getAbstractFileByPath("Up")) await app.vault.createFolder("Up");
      for (let i = 0; i < 50; i++) if (!app.vault.getAbstractFileByPath(`Up/${i}`)) await app.vault.createFolder(`Up/${i}`);
      for (let i = 0; i < n; i++) await app.vault.create(`Up/${i % 50}/Up ${i}.md`, `# Up ${i}\n${"More text. ".repeat(20)}\n`);
    }, N);
    const created = performance.now() - t0;
    await until(`${2 * N} notes on the server`, async () => (await server.state()).files.length >= 2 * N, 600_000);
    const up = performance.now() - t0;
    console.log(`Obsidian: first sync of ${N} notes ${Math.round(down)} ms; idle pass over ${N} notes ${idle.join(", ")} ms; created ${N} more in ${Math.round(created)} ms, all on the server after ${Math.round(up)} ms`);
    expect(Math.min(...idle)).toBeLessThan(2000);
  }, 1_200_000);
});
