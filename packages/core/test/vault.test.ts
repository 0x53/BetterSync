import { beforeEach, describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/hash.ts";
import type { OpResult } from "../src/protocol.ts";
import { MemoryVaultStore, Vault } from "../src/vault.ts";

const enc = new TextEncoder();
let vault: Vault;
let store: MemoryVaultStore;

beforeEach(() => {
  store = new MemoryVaultStore();
  vault = new Vault(store, { now: () => Date.UTC(2026, 8, 30) });
});

async function blob(text: string) {
  const bytes = enc.encode(text);
  const hash = await sha256Hex(bytes);
  await vault.putBlob(hash, bytes);
  return hash;
}

async function put(path: string, text: string, baseVersion: number | null, device = "laptop") {
  const hash = await blob(text);
  const [r] = (await vault.applyOps(device, [{ op: "put", path, hash, baseVersion }])).results;
  return r!;
}

async function op(o: Parameters<Vault["applyOps"]>[1][number], device = "laptop") {
  return (await vault.applyOps(device, [o])).results[0]!;
}

const text = (path: string) => {
  const row = vault.state().files.find((f) => f.path === path);
  return row && new TextDecoder().decode(vault.blob(row.hash));
};
const status = (r: OpResult) => r.status;

describe("Vault", () => {
  test("put with the current base is accepted and bumps the version", async () => {
    const a = await put("Note.md", "one\n", null);
    expect(a).toMatchObject({ status: "accepted", files: [{ path: "Note.md", version: 1 }] });
    expect(status(await put("Note.md", "two\n", 1))).toBe("accepted");
    expect(text("Note.md")).toBe("two\n");
    expect(vault.state().seq).toBe(2);
  });

  test("stale put with separate edits merges; overlapping edits make a conflict copy", async () => {
    await put("Note.md", "a\nb\nc\n", null);
    await put("Note.md", "A\nb\nc\n", 1, "phone");
    expect(status(await put("Note.md", "a\nb\nC\n", 1))).toBe("merged");
    expect(text("Note.md")).toBe("A\nb\nC\n");

    const r = await put("Note.md", "a\nb\nX\n", 1, "agent-1");
    expect(r).toMatchObject({ status: "conflicted", conflictPath: "Note (conflict 2026-09-30 agent-1).md" });
    expect(text("Note.md")).toBe("A\nb\nC\n");
    expect(text("Note (conflict 2026-09-30 agent-1).md")).toBe("a\nb\nX\n");
  });

  test("a replayed put is recognised, not merged twice", async () => {
    await put("Note.md", "a\nb\n", null);
    await put("Note.md", "a\nB\n", 1, "phone");
    expect(status(await put("Note.md", "A\nb\n", 1))).toBe("merged");
    const before = vault.state().seq;
    expect(status(await put("Note.md", "A\nb\n", 1))).toBe("unchanged");
    expect(vault.state().seq).toBe(before);
  });

  test("a stale delete loses to a newer edit; a current one applies", async () => {
    await put("Note.md", "one\n", null);
    await put("Note.md", "two\n", 1, "phone");
    expect(status(await op({ op: "delete", path: "Note.md", baseVersion: 1 }))).toBe("superseded");
    expect(text("Note.md")).toBe("two\n");
    expect(status(await op({ op: "delete", path: "Note.md", baseVersion: 2 }))).toBe("accepted");
    expect(text("Note.md")).toBeUndefined();
  });

  test("an edit based on a deleted note restores it; a stale copy with no base does not", async () => {
    await put("Note.md", "one\n", null);
    await op({ op: "delete", path: "Note.md", baseVersion: 1 });
    // A device that lost its state still holds the old copy: it stays deleted.
    expect(status(await put("Note.md", "one\n", null, "phone"))).toBe("unchanged");
    expect(text("Note.md")).toBeUndefined();
    // A device that edited the note before seeing the delete: edit wins.
    expect(status(await put("Note.md", "one\nmore\n", 1, "phone"))).toBe("accepted");
    expect(text("Note.md")).toBe("one\nmore\n");
  });

  test("an edit follows the note to where it was moved", async () => {
    await put("Old.md", "a\nb\n", null);
    expect(status(await op({ op: "move", from: "Old.md", to: "New.md", baseVersion: 1 }, "phone"))).toBe("accepted");
    const r = await put("Old.md", "a\nB\n", 1);
    expect(r.status).toBe("merged");
    expect(text("New.md")).toBe("a\nB\n");
    expect(text("Old.md")).toBeUndefined();
  });

  test("case-only rename is a move; a second case variant of a path is the same note", async () => {
    await put("Note.md", "a\n", null);
    expect(status(await op({ op: "move", from: "Note.md", to: "note.md", baseVersion: 1 }))).toBe("accepted");
    expect(vault.state().files.map((f) => f.path)).toEqual(["note.md"]);
    const r = await put("NOTE.md", "b\n", null, "agent-1");
    expect(r.status).toBe("conflicted");
    expect(vault.state().files.map((f) => f.path).sort()).toEqual(["NOTE (conflict 2026-09-30 agent-1).md", "note.md"]);
  });

  test("a move onto a taken path lands on a conflict name", async () => {
    await put("A.md", "a\n", null);
    await put("B.md", "b\n", null);
    const r = await op({ op: "move", from: "A.md", to: "B.md", baseVersion: 1 });
    expect(r.status).toBe("accepted");
    expect(vault.state().files.map((f) => f.path).sort()).toEqual(["B (conflict 2026-09-30 laptop).md", "B.md"]);
  });

  test("rejects bad paths and missing blobs; checks blob hashes", async () => {
    const hash = await blob("x\n");
    expect(await op({ op: "put", path: ".obsidian/app.md", hash, baseVersion: null })).toMatchObject({ status: "rejected" });
    expect(await op({ op: "put", path: "image.png", hash, baseVersion: null })).toMatchObject({ status: "rejected" });
    expect(await op({ op: "put", path: "Note.md", hash: "0".repeat(64), baseVersion: null })).toMatchObject({ status: "rejected", reason: "missing blob" });
    expect(vault.putBlob("0".repeat(64), enc.encode("x"))).rejects.toThrow("hash mismatch");
  });
});
