import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSyncablePath, pathKey, type Change, type ChangesResponse, type StateResponse } from "@bettersync/core";
import { hashSync, type Clobber } from "@bettersync/sim";
import type { Subprocess } from "bun";

/**
 * Real processes for the end-to-end and kill tests: the server CLI and the
 * headless CLI, each run by Bun from source, on localhost.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");
const SERVER_CLI = join(ROOT, "packages", "server", "src", "cli.ts");
const HEADLESS_CLI = join(ROOT, "packages", "headless", "src", "cli.ts");

export async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port!;
  await s.stop(true);
  return port;
}

/** Collects a process's output lines without ever blocking it on a full pipe. */
function drain(stream: ReadableStream<Uint8Array> | undefined, into: string[], prefix: string, echo: boolean): Promise<void> {
  if (!stream) return Promise.resolve();
  return (async () => {
    const dec = new TextDecoder();
    let buf = "";
    const reader = stream.getReader();
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = `${prefix}${buf.slice(0, i)}`;
        into.push(line);
        if (echo) console.log(line);
        buf = buf.slice(i + 1);
      }
    }
  })().catch(() => {});
}

const ECHO = process.env.E2E_VERBOSE === "1";

export class ServerProc {
  proc: Subprocess<"ignore", "pipe", "pipe"> | undefined;
  readonly logs: string[] = [];
  token = "";

  constructor(
    readonly dataDir: string,
    readonly port: number,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Creates the vault and its token through the admin CLI. */
  async init(): Promise<void> {
    const p = Bun.spawn([process.execPath, SERVER_CLI, "rotate-token", "--init", "--data", this.dataDir], { stdout: "pipe", stderr: "pipe" });
    this.token = (await new Response(p.stdout).text()).trim();
    if ((await p.exited) !== 0 || !/^[0-9a-f]{64}$/.test(this.token)) throw new Error(`rotate-token failed: ${this.token}`);
  }

  async start(): Promise<void> {
    this.proc = Bun.spawn([process.execPath, SERVER_CLI, "serve", "--data", this.dataDir, "--port", String(this.port), "--host", "127.0.0.1"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    void drain(this.proc.stdout, this.logs, "server: ", ECHO);
    void drain(this.proc.stderr, this.logs, "server! ", true);
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`${this.url}/healthz`)).ok) return;
      } catch {
        // not up yet
      }
      await Bun.sleep(25);
    }
    throw new Error("server did not start");
  }

  kill(): void {
    this.proc?.kill("SIGKILL");
    this.proc = undefined;
  }

  get running(): boolean {
    return this.proc !== undefined;
  }

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(this.url + path, { headers: { Authorization: `Bearer ${this.token}`, "X-Device-Name": "test" } });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return (await r.json()) as T;
  }

  state(): Promise<StateResponse> {
    return this.get("/v1/state");
  }

  async allChanges(): Promise<Change[]> {
    const out: Change[] = [];
    for (;;) {
      const page = await this.get<ChangesResponse>(`/v1/changes?after=${out.at(-1)?.seq ?? 0}`);
      out.push(...page.changes);
      if (page.changes.length === 0 || out.at(-1)!.seq >= page.seq) return out;
    }
  }
}

export class ClientProc {
  proc: Subprocess<"ignore", "pipe", "pipe"> | undefined;
  readonly logs: string[] = [];
  /** Whether the folder's disk ignores case (then "todo.md" and "Todo.md" are one file). */
  readonly caseInsensitive: boolean;

  constructor(
    readonly folder: string,
    readonly device: string,
    readonly server: ServerProc,
  ) {
    mkdirSync(folder, { recursive: true });
    const probe = `case-probe-${process.pid}`;
    writeFileSync(join(folder, "..", probe), "");
    this.caseInsensitive = existsSync(join(folder, "..", probe.toUpperCase()));
    rmSync(join(folder, "..", probe), { force: true });
  }

  private spawn(command: "sync" | "once") {
    return Bun.spawn([process.execPath, HEADLESS_CLI, command, this.folder, "--server", this.server.url, "--device", this.device], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BETTERSYNC_TOKEN: this.server.token, BETTERSYNC_CONFIG: join(this.folder, "..", "no-config.json") },
    });
  }

  /** Starts the daemon (`bettersync sync`). */
  start(): void {
    this.proc = this.spawn("sync");
    void drain(this.proc.stdout, this.logs, `${this.device}: `, ECHO);
    void drain(this.proc.stderr, this.logs, `${this.device}! `, true);
  }

  /** Runs `bettersync once` to completion; returns its exit code. */
  async once(): Promise<number> {
    const p = this.spawn("once");
    this.proc = p;
    const out = [drain(p.stdout, this.logs, `${this.device}: `, ECHO), drain(p.stderr, this.logs, `${this.device}! `, ECHO)];
    const code = await p.exited;
    await Promise.all(out);
    if (this.proc === p) this.proc = undefined;
    return code;
  }

  kill(): void {
    this.proc?.kill("SIGKILL");
    this.proc = undefined;
  }

  get running(): boolean {
    return this.proc !== undefined;
  }

  /** The folder's syncable notes: actual name → content hash. */
  files(): Map<string, string> {
    return notesIn(this.folder);
  }
}

export function notesIn(folder: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(join(folder, dir), { withFileTypes: true })) {
      const rel = dir === "" ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile() && isSyncablePath(rel.normalize("NFC"))) {
        try {
          out.set(rel.normalize("NFC"), hashSync(readFileSync(join(folder, rel))));
        } catch (err) {
          // Moved or deleted by the client since the listing.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }
  };
  walk("");
  return out;
}

/**
 * The user side of a folder: acts on it with plain file operations, like a
 * person in an editor or an agent with shell tools, and keeps what it last
 * put in each file. When a file no longer holds that, the client replaced it,
 * which is recorded as a clobber: the server must have the lost content.
 */
export class Driver {
  /** Per folder: path → hash of what the user last put there. */
  private readonly model = new Map<string, Map<string, string>>();
  readonly clobbered: Clobber[] = [];
  readonly placed: { key: string; hash: string; time: number; moved: boolean }[] = [];
  private uniq = 0;

  constructor(private readonly rng: { next(): number; int(a: number, b: number): number; pick<T>(xs: readonly T[]): T; chance(p: number): boolean }) {}

  private m(c: ClientProc) {
    let m = this.model.get(c.folder);
    if (!m) this.model.set(c.folder, (m = new Map()));
    return m;
  }

  /** The model's key for a path: on a case-insensitive disk, other cases name the same file. */
  private k(c: ClientProc, path: string): string {
    return c.caseInsensitive ? pathKey(path) : path;
  }

  /** Records a clobber if the client changed what the user last put at `path`. */
  private check(c: ClientProc, path: string): void {
    const m = this.m(c);
    const mine = m.get(this.k(c, path));
    if (mine === undefined) return;
    const cur = existsSync(join(c.folder, path)) ? hashSync(readFileSync(join(c.folder, path))) : null;
    if (cur !== mine) this.clobbered.push({ device: c.device, path, hash: mine, time: Date.now() });
    m.delete(this.k(c, path));
  }

  /** Checks every file the user last wrote, at the end of a run. */
  checkAll(clients: readonly ClientProc[]): void {
    for (const c of clients) for (const p of [...this.m(c).keys()]) this.check(c, p);
  }

  private put(c: ClientProc, path: string, text: string, viaRename: boolean): void {
    this.check(c, path);
    const abs = join(c.folder, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    const bytes = new TextEncoder().encode(text);
    if (viaRename) {
      // How many editors save: write a temp file, rename it over the note.
      const tmp = `${abs}.${++this.uniq}.swp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, abs);
    } else {
      writeFileSync(abs, bytes);
    }
    const h = hashSync(bytes);
    this.m(c).set(this.k(c, path), h);
    this.placed.push({ key: pathKey(path), hash: h, time: Date.now(), moved: false });
  }

  act(c: ClientProc): void {
    const notes = [...notesIn(c.folder).keys()].sort();
    const r = this.rng.next();
    try {
      if (notes.length === 0 || r < 0.2) {
        const path = this.name();
        const old = existsSync(join(c.folder, path)) ? readFileSync(join(c.folder, path), "utf8") : null;
        this.put(c, path, old === null ? this.text(c) : this.edit(c, old), this.rng.chance(0.3));
        return;
      }
      const path = this.rng.pick(notes);
      if (r < 0.65) {
        this.put(c, path, this.edit(c, readFileSync(join(c.folder, path), "utf8")), this.rng.chance(0.3));
      } else if (r < 0.77) {
        this.check(c, path);
        rmSync(join(c.folder, path), { force: true });
      } else if (r < 0.9) {
        const to = this.rng.chance(0.3) ? flipCase(this.rng, path) : this.name();
        const caseOnly = c.caseInsensitive && pathKey(to) === pathKey(path);
        if (to === path || (existsSync(join(c.folder, to)) && !caseOnly)) return;
        this.check(c, path);
        this.check(c, to);
        const bytes = readFileSync(join(c.folder, path));
        mkdirSync(join(c.folder, to, ".."), { recursive: true });
        renameSync(join(c.folder, path), join(c.folder, to));
        const h = hashSync(bytes);
        this.m(c).set(this.k(c, to), h);
        if (pathKey(path) !== pathKey(to)) this.placed.push({ key: pathKey(to), hash: h, time: Date.now(), moved: true });
      } else {
        // Files that must never sync, and must be left alone.
        const junk = join(c.folder, this.rng.pick(["image.png", "Projects/diagram.canvas", ".obsidian/app.json", ".trash/Gone.md"]));
        mkdirSync(join(junk, ".."), { recursive: true });
        writeFileSync(junk, this.text(c));
      }
    } catch (e) {
      // The client moved or removed the file between listing and acting: a normal race.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  private name(): string {
    const n = this.rng.pick(NAMES);
    return this.rng.chance(0.1) ? flipCase(this.rng, n) : n;
  }

  private text(c: ClientProc): string {
    const lines = Array.from({ length: this.rng.int(0, 10) }, () => this.rng.pick(LINES));
    lines.splice(this.rng.int(0, lines.length), 0, `${c.device} wrote ${++this.uniq}`);
    return lines.join("\n") + "\n";
  }

  private edit(c: ClientProc, text: string): string {
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    for (let i = this.rng.int(0, 2); i > 0 && lines.length > 0; i--) {
      const at = this.rng.int(0, lines.length - 1);
      if (this.rng.chance(0.5)) lines.splice(at, 1);
      else lines[at] = this.rng.pick(LINES);
    }
    lines.splice(this.rng.int(0, lines.length), 0, `${c.device} wrote ${++this.uniq}`);
    return lines.join("\n") + "\n";
  }
}

const NAMES = ["Inbox.md", "Todo.md", "Ideas.md", "Journal.md", "Projects/Alpha.md", "Projects/Beta.md", "Daily/2026-09-30.md", "Notes/Émigré.md", "Notes/Long name with spaces.md", "Archive/Old.md"];
const LINES = ["", "---", "# Heading", "## Section", "- [ ] todo", "- [x] done", "- item", "> quote", "Some text here.", "émoji 🙂", "[[Link]]"];

function flipCase(rng: { int(a: number, b: number): number }, path: string): string {
  const slash = path.lastIndexOf("/");
  const i = rng.int(slash + 1, path.length - 4);
  const ch = path[i]!;
  const flipped = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  return path.slice(0, i) + flipped + path.slice(i + 1);
}

/** Messes with a killed client's state file the way a crash or a user might. */
export function damageState(folder: string, how: "delete" | "corrupt"): void {
  const p = join(folder, ".bettersync", "state.json");
  if (!existsSync(p) || !statSync(p).isFile()) return;
  if (how === "delete") rmSync(p);
  else writeFileSync(p, "{corrupt");
}
