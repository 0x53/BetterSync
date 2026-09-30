import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, type ChangesResponse, type LiveMessage, type OpsResponse, type StateResponse } from "@bettersync/core";
import { generateToken, setToken, startServer, type RunningServer } from "../src/app.ts";
import { SqliteVaultStore } from "../src/store.ts";

let dir: string;
let store: SqliteVaultStore;
let server: RunningServer;
let base: string;
let token: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bettersync-api-"));
  store = new SqliteVaultStore(dir);
  token = generateToken();
  setToken(store, token);
  server = startServer({ store, port: 0, hostname: "127.0.0.1", heartbeatMs: 100 });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const enc = new TextEncoder();
const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, "X-Device-Name": "laptop", ...extra });
const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...headers(), ...(init.headers as Record<string, string>) } });

async function upload(text: string) {
  const bytes = enc.encode(text);
  const hash = await sha256Hex(bytes);
  const r = await call(`/v1/blobs/${hash}`, { method: "PUT", body: bytes });
  expect(r.status).toBe(204);
  return hash;
}

async function ops(body: unknown): Promise<OpsResponse> {
  const r = await call("/v1/ops", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  expect(r.status).toBe(200);
  return (await r.json()) as OpsResponse;
}

describe("API", () => {
  test("healthz needs no token", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });

  test("rejects a missing or wrong token, and a missing device name", async () => {
    expect((await fetch(`${base}/v1/state`)).status).toBe(401);
    expect((await fetch(`${base}/v1/state`, { headers: { Authorization: "Bearer nope", "X-Device-Name": "x" } })).status).toBe(401);
    expect((await fetch(`${base}/v1/state`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(400);
    expect((await fetch(`${base}/v1/state`, { headers: { Authorization: `Bearer ${token}`, "X-Device-Name": "x".repeat(65) } })).status).toBe(400);
  });

  test("a rotated token applies at once", async () => {
    const old = token;
    token = generateToken();
    setToken(store, token);
    expect((await call("/v1/state")).status).toBe(200);
    expect((await fetch(`${base}/v1/state`, { headers: { Authorization: `Bearer ${old}`, "X-Device-Name": "x" } })).status).toBe(401);
  });

  test("blobs: upload checks the hash; HEAD and GET find it", async () => {
    const bytes = enc.encode("# Note\n");
    const hash = await sha256Hex(bytes);
    expect((await call(`/v1/blobs/${hash}`, { method: "HEAD" })).status).toBe(404);
    expect((await call(`/v1/blobs/${"0".repeat(64)}`, { method: "PUT", body: bytes })).status).toBe(400);
    expect((await call(`/v1/blobs/../../etc`, { method: "GET" })).status).toBe(404);
    expect((await call(`/v1/blobs/NOTAHASH`, { method: "GET" })).status).toBe(400);
    await upload("# Note\n");
    expect((await call(`/v1/blobs/${hash}`, { method: "HEAD" })).status).toBe(200);
    const got = await call(`/v1/blobs/${hash}`);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  test("ops, state and changes", async () => {
    const hash = await upload("one\n");
    const res = await ops({ ops: [{ op: "put", path: "Inbox.md", hash, baseVersion: null }, { op: "put", path: "image.png", hash, baseVersion: null }] });
    expect(res.results[0]).toEqual({ status: "accepted", files: [{ path: "Inbox.md", version: 1, hash }] });
    expect(res.results[1]).toEqual({ status: "rejected", reason: "not a .md note" });

    const state = (await (await call("/v1/state")).json()) as StateResponse;
    expect(state.seq).toBe(1);
    expect(state.files.map((f) => [f.path, f.hash, f.version])).toEqual([["Inbox.md", hash, 1]]);

    const changes = (await (await call("/v1/changes?after=0")).json()) as ChangesResponse;
    expect(changes.seq).toBe(1);
    expect(changes.changes).toMatchObject([{ seq: 1, op: "put", path: "Inbox.md", hash, baseVersion: null, device: "laptop" }]);
    expect(((await (await call("/v1/changes?after=1")).json()) as ChangesResponse).changes).toEqual([]);
    expect((await call("/v1/changes?after=-1")).status).toBe(400);
  });

  test("malformed op bodies are refused", async () => {
    for (const body of ["{", "{}", '{"ops":[{"op":"put","path":"a.md"}]}', '{"ops":[{"op":"delete","path":"a.md","baseVersion":-1}]}', '{"ops":[1]}']) {
      const r = await call("/v1/ops", { method: "POST", body });
      expect(r.status).toBe(400);
    }
  });

  test("put with a missing blob is rejected per op", async () => {
    const res = await ops({ ops: [{ op: "put", path: "A.md", hash: "a".repeat(64), baseVersion: null }] });
    expect(res.results[0]).toEqual({ status: "rejected", reason: "missing blob" });
  });

  for (const how of ["headers", "subprotocol"] as const) {
    test(`live pushes accepted changes and pings (auth by ${how})`, async () => {
      const ws =
        how === "headers"
          ? new WebSocket(`${base.replace("http", "ws")}/v1/live`, { headers: headers() } as unknown as string[])
          : new WebSocket(`${base.replace("http", "ws")}/v1/live?device=iphone`, ["bettersync", `token.${token}`]);
      const got: LiveMessage[] = [];
      ws.onmessage = (m) => got.push(JSON.parse(String(m.data)) as LiveMessage);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws error"));
      });
      if (how === "subprotocol") expect(ws.protocol).toBe("bettersync");
      const hash = await upload("live\n");
      await ops({ ops: [{ op: "put", path: "Live.md", hash, baseVersion: null }] });
      await Bun.sleep(250);
      ws.close();
      expect(got.find((m) => m.type === "change")).toMatchObject({ type: "change", change: { seq: 1, path: "Live.md", hash } });
      expect(got.some((m) => m.type === "ping")).toBe(true);
    });
  }

  test("live refuses a bad token", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/v1/live?device=x`, ["bettersync", "token.bad"]);
    const outcome = await new Promise<string>((resolve) => {
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("error");
      ws.onclose = () => resolve("closed");
    });
    expect(outcome).not.toBe("open");
  });
});
