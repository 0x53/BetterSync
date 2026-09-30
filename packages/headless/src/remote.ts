import { DEVICE_HEADER, type BlobHash, type ChangesResponse, type Op, type OpsResponse, type Remote, type Seq, type StateResponse } from "@bettersync/core";

/** The server API over HTTP (design doc, "API"). */
export interface RemoteOptions {
  /** Base URL, e.g. https://notes.example.com */
  server: string;
  token: string;
  device: string;
  timeoutMs?: number;
}

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

  constructor(private readonly opts: RemoteOptions) {
    this.base = opts.server.replace(/\/+$/, "");
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
    await this.request("PUT", `/v1/blobs/${hash}`, bytes as Uint8Array<ArrayBuffer>);
  }

  async getBlob(hash: BlobHash): Promise<Uint8Array> {
    const r = await this.request("GET", `/v1/blobs/${hash}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  ops(ops: Op[]): Promise<OpsResponse> {
    return this.json("POST", "/v1/ops", JSON.stringify({ ops }));
  }

  /** Opens WS /v1/live, authenticating the way a browser can (subprotocol), like the plugin will. */
  live(): WebSocket {
    const url = new URL(`${this.base}/v1/live`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("device", this.opts.device);
    return new WebSocket(url.toString(), ["bettersync", `token.${this.opts.token}`]);
  }

  private async json<T>(method: string, path: string, body?: string): Promise<T> {
    const r = await this.request(method, path, body);
    return (await r.json()) as T;
  }

  private async request(method: string, path: string, body?: BodyInit, allow: number[] = []): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.token}`, [DEVICE_HEADER]: this.opts.device };
    if (typeof body === "string") headers["Content-Type"] = "application/json";
    const r = await fetch(this.base + path, {
      method,
      headers,
      ...(body !== undefined && { body }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
    });
    if (!r.ok && !allow.includes(r.status)) {
      const text = await r.text().catch(() => "");
      throw new HttpError(r.status, `${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
    }
    return r;
  }
}
