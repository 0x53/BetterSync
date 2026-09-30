import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientProc, freePort, ServerProc } from "./harness.ts";

/**
 * End to end over real processes: a server and two headless daemons.
 * Includes the design doc's latency target: a change is visible on another
 * online device within 2 s.
 */
let dir: string;
let server: ServerProc;
let a: ClientProc;
let b: ClientProc;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "bettersync-e2e-"));
  server = new ServerProc(join(dir, "data"), await freePort());
  await server.init();
  await server.start();
  a = new ClientProc(join(dir, "a"), "laptop", server);
  b = new ClientProc(join(dir, "b"), "agent-1", server);
  a.start();
  b.start();
  // Both connected and synced once.
  writeFileSync(join(a.folder, "Hello.md"), "hi\n");
  await until(() => existsSync(join(b.folder, "Hello.md")), 10_000);
});

afterAll(() => {
  a?.kill();
  b?.kill();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

async function until(ok: () => boolean, ms: number): Promise<number> {
  const t0 = performance.now();
  while (!ok()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out after ${ms} ms`);
    await Bun.sleep(10);
  }
  return performance.now() - t0;
}

const read = (c: ClientProc, p: string) => (existsSync(join(c.folder, p)) ? readFileSync(join(c.folder, p), "utf8") : null);

describe("end to end", () => {
  test("a change reaches the other device within 2 s", async () => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const [from, to] = i % 2 === 0 ? [a, b] : [b, a];
      const text = `edit ${i}\n`;
      writeFileSync(join(from.folder, "Latency.md"), text);
      times.push(await until(() => read(to, "Latency.md") === text, 5000));
      await Bun.sleep(300);
    }
    console.log(`latency ms: ${times.map((t) => Math.round(t)).join(", ")}`);
    for (const t of times) expect(t).toBeLessThan(2000);
  }, 60_000);

  test("edits on both sides merge; deletes and renames propagate", async () => {
    writeFileSync(join(a.folder, "Merge.md"), "one\ntwo\nthree\n");
    await until(() => read(b, "Merge.md") === "one\ntwo\nthree\n", 5000);
    // Wait until b has recorded that version as synced; killed before that, b
    // would see its edit as a new note and the server would keep a conflict copy.
    const seq = (await server.state()).seq;
    await until(() => (JSON.parse(read(b, ".bettersync/state.json") ?? "{}") as { cursor?: number }).cursor! >= seq, 5000);
    // Both edit before either syncs: kill b's daemon while editing, so a's edit lands first.
    b.kill();
    writeFileSync(join(a.folder, "Merge.md"), "ONE\ntwo\nthree\n");
    writeFileSync(join(b.folder, "Merge.md"), "one\ntwo\nTHREE\n");
    await Bun.sleep(1500);
    b.start();
    await until(() => read(a, "Merge.md") === "ONE\ntwo\nTHREE\n" && read(b, "Merge.md") === "ONE\ntwo\nTHREE\n", 10_000);

    rmSync(join(b.folder, "Merge.md"));
    await until(() => read(a, "Merge.md") === null, 5000);

    mkdirSync(join(a.folder, "Folder"), { recursive: true });
    writeFileSync(join(a.folder, "Folder", "Moved.md"), "m\n");
    await until(() => read(b, "Folder/Moved.md") === "m\n", 5000);
    mkdirSync(join(a.folder, "Other"));
    renameSync(join(a.folder, "Folder", "Moved.md"), join(a.folder, "Other", "Moved.md"));
    await until(() => read(b, "Other/Moved.md") === "m\n" && read(b, "Folder/Moved.md") === null, 5000);
    // The emptied folder is pruned on the other device.
    await until(() => !existsSync(join(b.folder, "Folder")), 2000);
  }, 60_000);

  test("files that are not notes stay local and untouched", async () => {
    writeFileSync(join(a.folder, "image.png"), "png");
    mkdirSync(join(a.folder, ".obsidian"), { recursive: true });
    writeFileSync(join(a.folder, ".obsidian", "app.json"), "{}");
    writeFileSync(join(a.folder, "Marker.md"), "x\n");
    await until(() => read(b, "Marker.md") === "x\n", 5000);
    expect(existsSync(join(b.folder, "image.png"))).toBe(false);
    expect(existsSync(join(b.folder, ".obsidian"))).toBe(false);
    expect(readFileSync(join(a.folder, "image.png"), "utf8")).toBe("png");
  }, 20_000);

  test("once: pulls, pushes and exits 0", async () => {
    const c = new ClientProc(join(dir, "c"), "cron", server);
    expect(await c.once()).toBe(0);
    expect(read(c, "Hello.md")).toBe("hi\n");
    writeFileSync(join(c.folder, "FromCron.md"), "cron\n");
    expect(await c.once()).toBe(0);
    await until(() => read(a, "FromCron.md") === "cron\n", 5000);
  }, 30_000);

  test("a second client on the same folder is refused", async () => {
    const twin = new ClientProc(a.folder, "twin", server);
    expect(await twin.once()).toBe(1);
    expect(twin.logs.join("\n")).toContain("already being synced");
  }, 20_000);

  test("a wrong token fails with a clear message", async () => {
    const bad = new ServerProc(server.dataDir, server.port);
    bad.token = "0".repeat(64);
    const c = new ClientProc(join(dir, "d"), "bad", bad);
    expect(await c.once()).toBe(1);
    expect(c.logs.join("\n")).toContain("rejected the token");
  }, 20_000);
});
