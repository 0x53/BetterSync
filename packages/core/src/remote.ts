import type { Remote } from "./engine.ts";
import { DEVICE_HEADER, type BlobHash, type ChangesResponse, type Op, type OpsResponse, type Seq, type StateResponse } from "./protocol.ts";

/**
 * The server API over HTTP (design doc, "API"), shared by the headless client
 * and the plugin. Only the transport differs: the headless client uses
 * fetch, the plugin Obsidian's requestUrl (which is not bound by CORS and
 * works the same on desktop and iOS).
 */
export interface RemoteOptions {
  /** Base URL, e.g. https://notes.example.com */
  server: string;
  token: string;
  device: string;
  transport?: Transport;
  timeoutMs?: number;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
}

/** Sends one request; rejects only on network failure or timeout, never on an HTTP status. */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchTransport: Transport = async (req) => {
  const r = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined && { body: req.body as BodyInit }),
    signal: AbortSignal.timeout(req.timeoutMs),
  });
  return { status: r.status, bytes: async () => new Uint8Array(await r.arrayBuffer()), text: () => r.text() };
};

/** A non-2xx response. 401 means the token is wrong; the runner stops retrying quickly. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class HttpRemote implements Remote {
  private readonly base: string;
  private readonly transport: Transport;

  constructor(private readonly opts: RemoteOptions) {
    this.base = opts.server.replace(/\/+$/, "");
    this.transport = opts.transport ?? fetchTransport;
  }

  state(): Promise<StateResponse> {
    return this.json("GET", "/v1/state");
  }

  changes(after: Seq): Promise<ChangesResponse> {
    return this.json("GET", `/v1/changes?after=${after}`);
  }

  async hasBlob(hash: BlobHash): Promise<boolean> {
    const r = await this.request("HEAD", `/v1/blobs/${hash}`, undefined, [404]);
    return r.status !== 404;
  }

  async putBlob(hash: BlobHash, bytes: Uint8Array): Promise<void> {
    await this.request("PUT", `/v1/blobs/${hash}`, bytes);
  }

  async getBlob(hash: BlobHash): Promise<Uint8Array> {
    return (await this.request("GET", `/v1/blobs/${hash}`)).bytes();
  }

  ops(ops: Op[]): Promise<OpsResponse> {
    return this.json("POST", "/v1/ops", JSON.stringify({ ops }));
  }

  /** Opens WS /v1/live, authenticating the way a browser can: subprotocol and query parameter. */
  live(): WebSocket {
    const url = new URL(`${this.base}/v1/live`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("device", this.opts.device);
    return new WebSocket(url.toString(), ["bettersync", `token.${this.opts.token}`]);
  }

  private async json<T>(method: string, path: string, body?: string): Promise<T> {
    const r = await this.request(method, path, body);
    return JSON.parse(await r.text()) as T;
  }

  private async request(method: string, path: string, body?: string | Uint8Array, allow: number[] = []): Promise<HttpResponse> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.token}`, [DEVICE_HEADER]: this.opts.device };
    if (typeof body === "string") headers["Content-Type"] = "application/json";
    else if (body !== undefined) headers["Content-Type"] = "application/octet-stream";
    const r = await this.transport({ method, url: this.base + path, headers, ...(body !== undefined && { body }), timeoutMs: this.opts.timeoutMs ?? 60_000 });
    if ((r.status < 200 || r.status > 299) && !allow.includes(r.status)) {
      const text = await r.text().catch(() => "");
      throw new HttpError(r.status, `${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
    }
    return r;
  }
}
