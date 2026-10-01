import { timingSafeEqual } from "node:crypto";
import { DEVICE_HEADER, isSha256Hex, MAX_NOTE_BYTES, Vault, VaultError, type LiveMessage, type Op, type Seq } from "@bettersync/core";
import type { Server, ServerWebSocket } from "bun";
import type { SqliteVaultStore } from "./store.ts";

/**
 * The HTTP + WebSocket API (design doc, "Server" → "API"). Plain HTTP on one
 * port; nginx terminates TLS in front of it.
 *
 * Every request but /healthz carries the shared token and a device name. The
 * WebSocket takes them from the Authorization and X-Device-Name headers, or,
 * for browsers (the Obsidian plugin) that cannot set headers, from the
 * subprotocol list ["bettersync", "token.<token>"] and a ?device= parameter.
 */

export const LIVE_PROTOCOL = "bettersync";
const TOKEN_PROTOCOL = "token.";
const TOKEN_META = "token_sha256";
const MAX_OPS = 1000;
const MAX_DEVICE = 64;

export interface ServerOptions {
  store: SqliteVaultStore;
  port: number;
  hostname: string;
  /** Server → client ping interval on /v1/live. */
  heartbeatMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export interface RunningServer {
  server: Server<LiveData>;
  vault: Vault;
  port: number;
  stop(): Promise<void>;
}

interface LiveData {
  device: string;
}

// ---- token ----

export function generateToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

/** Stores only the token's hash, so the database does not hold a usable credential. */
export function setToken(store: SqliteVaultStore, token: string): void {
  store.setMeta(TOKEN_META, sha256(token).toString("hex"));
}

export function hasToken(store: SqliteVaultStore): boolean {
  return store.getMeta(TOKEN_META) !== undefined;
}

/** Constant time: compares fixed-length hashes. Reads the stored hash each time, so a rotation applies at once. */
export function tokenMatches(store: SqliteVaultStore, token: string): boolean {
  const stored = store.getMeta(TOKEN_META);
  if (stored === undefined) return false;
  return timingSafeEqual(sha256(token), Buffer.from(stored, "hex"));
}

function sha256(s: string): Buffer {
  return new Bun.CryptoHasher("sha256").update(s).digest();
}

// ---- server ----

export function startServer(opts: ServerOptions): RunningServer {
  const { store } = opts;
  const log = opts.log ?? (() => {});
  const vault = new Vault(store, { now: opts.now ?? Date.now });
  let broadcastSeq: Seq = store.seq();

  const publish = () => {
    while (broadcastSeq < store.seq()) {
      const page = store.changesAfter(broadcastSeq, 500);
      if (page.length === 0) break;
      for (const change of page) server.publish("live", JSON.stringify({ type: "change", change } satisfies LiveMessage));
      broadcastSeq = page.at(-1)!.seq;
    }
  };

  const server: Server<LiveData> = Bun.serve<LiveData>({
    port: opts.port,
    hostname: opts.hostname,
    maxRequestBodySize: MAX_NOTE_BYTES + 1024 * 1024,
    async fetch(req, srv) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/healthz" && req.method === "GET") return text(200, "ok");
        if (url.pathname === "/v1/live") return upgrade(req, url, srv);

        if (!authorized(bearer(req))) return text(401, "bad token");
        const device = deviceName(req.headers.get(DEVICE_HEADER));
        if (device === null) return text(400, `missing or invalid ${DEVICE_HEADER}`);

        if (url.pathname === "/v1/state" && req.method === "GET") return json(vault.state());
        if (url.pathname === "/v1/changes" && req.method === "GET") {
          const after = intParam(url, "after", 0);
          const limit = intParam(url, "limit", 1000);
          if (after === null || limit === null || limit < 1 || limit > 1000) return text(400, "bad after or limit");
          return json(vault.changes(after, limit));
        }
        if (url.pathname.startsWith("/v1/blobs/")) {
          const hash = url.pathname.slice("/v1/blobs/".length);
          if (!isSha256Hex(hash)) return text(400, "bad blob hash");
          // Never cacheable: a cached GET would answer a later HEAD (Chromium, so the plugin does this),
          // and a client told a blob exists that this server lacks (a restore, a new server at the
          // same URL) would never upload it.
          if (req.method === "HEAD") return new Response(null, { status: vault.hasBlob(hash) ? 200 : 404, headers: { "Cache-Control": "no-store" } });
          if (req.method === "GET") {
            const bytes = vault.blob(hash);
            return bytes ? new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } }) : text(404, "no such blob");
          }
          if (req.method === "PUT") {
            await vault.putBlob(hash, new Uint8Array(await req.arrayBuffer()));
            return new Response(null, { status: 204 });
          }
        }
        if (url.pathname === "/v1/ops" && req.method === "POST") {
          const ops = parseOps(await req.json().catch(() => undefined));
          if (typeof ops === "string") return text(400, ops);
          let res;
          try {
            res = await vault.applyOps(device, ops);
          } finally {
            // Ops before a failure in the batch committed; live clients hear of them now either way.
            publish();
          }
          for (const [i, r] of res.results.entries()) {
            if (r.status !== "accepted" && r.status !== "unchanged") log(`${device}: ${describeOp(ops[i]!)} -> ${r.status}${"conflictPath" in r && r.conflictPath ? ` (${r.conflictPath})` : ""}${r.status === "rejected" ? `: ${r.reason}` : ""}`);
          }
          return json(res);
        }
        return text(404, "not found");
      } catch (e) {
        if (e instanceof VaultError) return text(e.status, e.message);
        log(`error on ${req.method} ${url.pathname}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        return text(500, "internal error");
      }
    },
    websocket: {
      open(ws) {
        ws.subscribe("live");
      },
      message(ws, msg) {
        // Client heartbeats. Anything else is ignored.
        if (msg === "ping") ws.send(JSON.stringify({ type: "ping" } satisfies LiveMessage));
      },
      close(ws: ServerWebSocket<LiveData>) {
        ws.unsubscribe("live");
      },
      idleTimeout: 120,
      sendPings: true,
    },
  });

  function authorized(token: string | null): boolean {
    return token !== null && tokenMatches(store, token);
  }

  function upgrade(req: Request, url: URL, srv: Server<LiveData>): Response | undefined {
    const protocols = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
    const fromProtocol = protocols.find((p) => p.startsWith(TOKEN_PROTOCOL))?.slice(TOKEN_PROTOCOL.length) ?? null;
    if (!authorized(bearer(req) ?? fromProtocol)) return text(401, "bad token");
    // Accepting the token as the subprotocol would echo it back in the handshake response.
    if (bearer(req) === null && !protocols.includes(LIVE_PROTOCOL)) return text(400, `offer the "${LIVE_PROTOCOL}" subprotocol with the token`);
    const device = deviceName(req.headers.get(DEVICE_HEADER) ?? url.searchParams.get("device"));
    if (device === null) return text(400, "missing or invalid device name");
    // Bun refuses an empty headers object, so it is passed only when there is a protocol to accept.
    const ok = protocols.includes(LIVE_PROTOCOL) ? srv.upgrade(req, { data: { device }, headers: { "Sec-WebSocket-Protocol": LIVE_PROTOCOL } }) : srv.upgrade(req, { data: { device } });
    if (ok) return undefined;
    return text(400, "expected a WebSocket upgrade");
  }

  const heartbeat = setInterval(() => server.publish("live", JSON.stringify({ type: "ping" } satisfies LiveMessage)), opts.heartbeatMs ?? 25_000);

  return {
    server,
    vault,
    port: server.port!,
    async stop() {
      clearInterval(heartbeat);
      await server.stop(true);
    },
  };
}

// ---- request parsing ----

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization");
  return h?.startsWith("Bearer ") ? h.slice("Bearer ".length).trim() : null;
}

/** A self-chosen label for history and conflict copies: 1–64 printable characters. */
function deviceName(raw: string | null): string | null {
  if (raw === null) return null;
  const name = raw.trim().normalize("NFC");
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > MAX_DEVICE || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function intParam(url: URL, name: string, fallback: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

/** Checks the shape of a POST /v1/ops body. Path rules are the Vault's job. */
export function parseOps(body: unknown): Op[] | string {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { ops?: unknown }).ops)) return "expected {ops: [...]}";
  const raw = (body as { ops: unknown[] }).ops;
  if (raw.length > MAX_OPS) return `at most ${MAX_OPS} ops per request`;
  const str = (v: unknown) => typeof v === "string";
  const seq = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  const ops: Op[] = [];
  for (const [i, o] of raw.entries()) {
    const x = o as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return `op ${i}: not an object`;
    if (x.op === "put" && str(x.path) && str(x.hash) && isSha256Hex(x.hash as string) && (x.baseVersion === null || seq(x.baseVersion))) {
      ops.push({ op: "put", path: x.path as string, hash: x.hash as string, baseVersion: x.baseVersion as number | null });
    } else if (x.op === "delete" && str(x.path) && seq(x.baseVersion)) {
      ops.push({ op: "delete", path: x.path as string, baseVersion: x.baseVersion as number });
    } else if (x.op === "move" && str(x.from) && str(x.to) && seq(x.baseVersion)) {
      ops.push({ op: "move", from: x.from as string, to: x.to as string, baseVersion: x.baseVersion as number });
    } else {
      return `op ${i}: malformed`;
    }
  }
  return ops;
}

function describeOp(op: Op): string {
  return op.op === "move" ? `move ${op.from} -> ${op.to}` : `${op.op} ${op.path}`;
}

function json(value: unknown): Response {
  // State and changes go stale at once; nothing between here and the client may answer from a cache.
  return Response.json(value, { headers: { "Cache-Control": "no-store" } });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
