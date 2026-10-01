#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConcurrentChangeError, HttpError, HttpRemote, SyncEngine } from "@bettersync/core";
import { DiskFs } from "./fs.ts";
import { FolderRunner } from "./runner.ts";
import { FileStateStore, FolderLock, stateDir } from "./state.ts";

/**
 * The headless client (design doc, "Headless client and agent access"):
 *
 *   bettersync sync <folder> --server <url> --device agent-1   runs continuously
 *   bettersync once <folder> ...                               pull, push, exit
 *
 * The token comes from BETTERSYNC_TOKEN or the config file. Flags override
 * BETTERSYNC_SERVER / BETTERSYNC_DEVICE, which override the config file
 * (--config, BETTERSYNC_CONFIG, or ~/.config/bettersync/config.json):
 *
 *   { "server": "https://notes.example.com", "token": "…", "device": "agent-1" }
 */

const USAGE = `usage:
  bettersync sync <folder> [--server URL] [--device NAME] [--config FILE]
  bettersync once <folder> [--server URL] [--device NAME] [--config FILE]

The token comes from BETTERSYNC_TOKEN or the config file
(default ~/.config/bettersync/config.json: {"server", "token", "device"}).`;

interface Config {
  server?: string;
  token?: string;
  device?: string;
}

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main(argv: string[]): Promise<number | undefined> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      device: { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  const [command, folderArg] = positionals;
  if (values.help || (command !== "sync" && command !== "once") || folderArg === undefined || positionals.length > 2) {
    (values.help ? console.log : console.error)(USAGE);
    return values.help ? 0 : 2;
  }

  const configPath = values.config ?? process.env.BETTERSYNC_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "bettersync", "config.json");
  let file: Config = {};
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, "utf8")) as Config;
    } catch (e) {
      console.error(`cannot read ${configPath}: ${(e as Error).message}`);
      return 2;
    }
  } else if (values.config !== undefined) {
    console.error(`no config file at ${configPath}`);
    return 2;
  }
  const server = values.server ?? process.env.BETTERSYNC_SERVER ?? file.server;
  const token = process.env.BETTERSYNC_TOKEN ?? file.token;
  const device = values.device ?? process.env.BETTERSYNC_DEVICE ?? file.device ?? hostname().split(".")[0]!;
  if (!server) return fail("no server: pass --server or set BETTERSYNC_SERVER");
  if (!token) return fail("no token: set BETTERSYNC_TOKEN or put it in the config file");

  const folder = resolve(folderArg);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return fail(`${folder} is not a folder`);

  const lock = await FolderLock.acquire(folder).catch((e: Error) => e);
  if (lock instanceof Error) return fail(lock.message);
  process.on("exit", () => lock.releaseSync());

  const fs = new DiskFs(folder);
  await fs.cleanTemp();
  const remote = new HttpRemote({ server, token, device });
  const engine = await SyncEngine.open({ fs, remote, store: new FileStateStore(join(stateDir(folder), "state.json")), device, now: Date.now });

  if (command === "once") {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await engine.sync();
        log(`synced ${folder}: ${r.applied} applied, ${r.pushed} pushed, cursor ${engine.cursor}`);
        for (const c of r.conflicts) log(`conflict: kept the other version; this device's edit is in ${c}`);
        for (const x of r.rejected) log(`rejected by the server: ${JSON.stringify(x.op)}: ${x.reason}`);
        return r.rejected.length > 0 ? 1 : 0;
      } catch (e) {
        if (e instanceof ConcurrentChangeError && attempt < 5) {
          await Bun.sleep(500);
          continue;
        }
        if (e instanceof HttpError && e.status === 401) return fail("the server rejected the token");
        return fail(`sync failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const runner = new FolderRunner({ engine, live: () => remote.live(), folder, log: (m) => log(m === "the server rejected the token" ? `${m}; set the current one (BETTERSYNC_TOKEN or the config file)` : m) });
  log(`syncing ${folder} with ${server} as ${device}`);
  runner.start();
  const shutdown = async () => {
    await runner.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return undefined;
}

function fail(message: string): number {
  console.error(`bettersync: ${message}`);
  return 1;
}

const code = await main(process.argv.slice(2));
if (code !== undefined) process.exit(code);
