#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { generateToken, hasToken, setToken, startServer } from "./app.ts";
import { SqliteVaultStore } from "./store.ts";

/**
 * The server's admin CLI (design doc, "Operations"):
 *
 *   bettersync serve [--data DIR] [--port N] [--host ADDR]
 *   bettersync rotate-token [--data DIR]
 *   bettersync healthcheck [--port N]       exit 0 if the server answers /healthz
 *
 * Settings also come from BETTERSYNC_DATA, BETTERSYNC_PORT and
 * BETTERSYNC_HOST. History and restore commands land in M4.
 */

const USAGE = `usage:
  bettersync serve [--data DIR] [--port N] [--host ADDR]
  bettersync rotate-token [--data DIR]
  bettersync healthcheck [--port N]

environment: BETTERSYNC_DATA (default ./data), BETTERSYNC_PORT (default 8787),
BETTERSYNC_HOST (default 127.0.0.1)`;

async function main(argv: string[]): Promise<number | undefined> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      data: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  const command = positionals[0] ?? "serve";
  if (values.help || positionals.length > 1) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const dataDir = values.data ?? process.env.BETTERSYNC_DATA ?? "./data";

  if (command === "rotate-token") {
    const store = new SqliteVaultStore(dataDir);
    const token = generateToken();
    setToken(store, token);
    store.close();
    console.log(token);
    console.error("Token rotated. Enter the new token on every device; the old one stops working now.");
    return 0;
  }
  if (command !== "serve" && command !== "healthcheck") {
    console.error(USAGE);
    return 2;
  }

  const port = Number(values.port ?? process.env.BETTERSYNC_PORT ?? 8787);
  const hostname = values.host ?? process.env.BETTERSYNC_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`bad port: ${values.port ?? process.env.BETTERSYNC_PORT}`);
    return 2;
  }

  if (command === "healthcheck") {
    // For Docker's HEALTHCHECK: the image has no curl.
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
      return r.ok ? 0 : 1;
    } catch {
      return 1;
    }
  }

  const store = new SqliteVaultStore(dataDir);
  const cleaned = store.cleanTemp();
  if (!hasToken(store)) {
    const token = generateToken();
    setToken(store, token);
    console.log(`\nNew vault. Access token (shown once; rotate with \`bettersync rotate-token\`):\n\n  ${token}\n`);
  }
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  const running = startServer({ store, port, hostname, log });
  log(`bettersync server on http://${hostname}:${running.port}, data in ${dataDir}, seq ${store.seq()}${cleaned ? `, removed ${cleaned} temp files` : ""}`);

  const shutdown = async () => {
    await running.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return undefined;
}

const code = await main(process.argv.slice(2));
if (code !== undefined) process.exit(code);
