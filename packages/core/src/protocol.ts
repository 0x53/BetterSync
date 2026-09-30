/**
 * Wire types for the client ↔ server protocol (design doc, "Server" → "API").
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

/**
 * The server's current state of one path key: a live file, or `hash: null`
 * when the key is deleted (version = the delete's seq) or never existed
 * (version 0).
 */
export interface PathState {
  path: string;
  version: Seq;
  hash: BlobHash | null;
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
  /** The content a client sent when the server merged it into `hash`. Kept in history. */
  submitted?: BlobHash;
  /** Set on a conflict copy: the note whose edit it preserves. */
  conflictOf?: string;
}

/** GET /v1/changes */
export interface ChangesResponse {
  changes: Change[];
  /** Highest seq on the server; equal to the last change's seq when complete. */
  seq: Seq;
}

/** baseVersion null means "I believe this path does not exist yet". */
export type Op =
  | { op: "put"; path: string; hash: BlobHash; baseVersion: Seq | null }
  | { op: "delete"; path: string; baseVersion: Seq }
  | { op: "move"; from: string; to: string; baseVersion: Seq };

/** POST /v1/ops */
export interface OpsRequest {
  ops: Op[];
}

export type OpStatus =
  /** Base was current (or a stale move/restore that still applies); applied as sent. */
  | "accepted"
  /** Base was stale; merged cleanly with the newer version. */
  | "merged"
  /** Base was stale and edits overlapped; the server version stays and the sent content became a conflict copy. */
  | "conflicted"
  /** Nothing to do: the content is already current or already in this path's history, or the source is gone. */
  | "unchanged"
  /** A stale delete lost to a newer edit (edit wins); nothing changed. */
  | "superseded";

export type OpResult =
  | {
      status: OpStatus;
      /** Current state of every path key the op touched, so the client can adopt it. */
      files: PathState[];
      conflictPath?: string;
    }
  | { status: "rejected"; reason: string };

export interface OpsResponse {
  results: OpResult[];
}

/** WS /v1/live messages, server → client. */
export type LiveMessage = { type: "change"; change: Change } | { type: "ping" };

export const DEVICE_HEADER = "X-Device-Name";
