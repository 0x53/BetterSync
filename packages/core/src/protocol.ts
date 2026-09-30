/**
 * Wire types for the client ↔ server protocol (design doc, "Server" → "API").
 * Draft: settled in M1 alongside the engine and simulator.
 */

/** Server sequence number; a file's version is the seq of its last change. */
export type Seq = number;

/** Lowercase hex SHA-256 of a note's bytes. */
export type BlobHash = string;

export interface FileEntry {
  path: string;
  hash: BlobHash;
  size: number;
  mtime: number;
  version: Seq;
}

/** GET /v1/state */
export interface StateResponse {
  seq: Seq;
  files: FileEntry[];
}

export type ChangeOp = "put" | "delete" | "move";

/** One change-log entry. GET /v1/changes?after=<seq> and WS /v1/live push these. */
export interface Change {
  seq: Seq;
  op: ChangeOp;
  path: string;
  /** For a move, the old path. */
  from?: string;
  /** New content for put and move; null for delete. */
  hash: BlobHash | null;
  baseVersion: Seq | null;
  device: string;
  time: number;
}

/** GET /v1/changes */
export interface ChangesResponse {
  changes: Change[];
  /** Highest seq on the server; equal to the last change's seq when complete. */
  seq: Seq;
}

/** baseVersion null means "I believe this path does not exist yet". */
export type Op =
  | { op: "put"; path: string; hash: BlobHash; size: number; baseVersion: Seq | null }
  | { op: "delete"; path: string; baseVersion: Seq }
  | { op: "move"; from: string; to: string; baseVersion: Seq };

/** POST /v1/ops */
export interface OpsRequest {
  ops: Op[];
}

export type OpResult =
  /** Base was current; applied as sent. */
  | { status: "accepted"; seq: Seq }
  /** Base was stale; merged cleanly with the newer version into `hash`. */
  | { status: "merged"; seq: Seq; hash: BlobHash }
  /** Base was stale and edits overlapped; the server version stays and the sent content was saved at `conflictPath`. */
  | { status: "conflicted"; seq: Seq; conflictPath: string }
  /** A stale delete lost to a newer edit (edit wins); nothing changed. */
  | { status: "superseded"; current: FileEntry }
  | { status: "rejected"; reason: string };

export interface OpsResponse {
  results: OpResult[];
}

/** WS /v1/live messages, server → client. */
export type LiveMessage = { type: "change"; change: Change } | { type: "ping" };

export const DEVICE_HEADER = "X-Device-Name";
