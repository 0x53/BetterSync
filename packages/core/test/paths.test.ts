import { describe, expect, test } from "bun:test";
import { invalidPathReason, isSyncablePath } from "../src/paths.ts";

describe("path rules", () => {
  test("syncs Markdown notes anywhere a person would keep them", () => {
    for (const p of ["Note.md", "Projects/Alpha.md", "Notes/Émigré.md", "Daily/2026-09-30.md", "a b/c d.md", "Con game.md", "Com10.md", "v1.2 notes.md", "#tag [x].md"]) {
      expect([p, invalidPathReason(p)]).toEqual([p, null]);
    }
  });

  test("skips hidden paths, which Obsidian never indexes", () => {
    for (const p of [".obsidian/app.md", ".trash/Gone.md", ".git/notes.md", "Projects/.drafts/a.md", ".hidden.md", ".md"]) expect(isSyncablePath(p)).toBe(false);
  });

  test("rejects names some device cannot store", () => {
    for (const p of ["Meeting: notes.md", 'say "hi".md', "a|b.md", "what?.md", "star*.md", "<x>.md", "Trailing /a.md", "Dot./a.md", "con.md", "NUL.md", "Folder/lpt1.md", "aux/a.md"]) {
      expect([p, isSyncablePath(p)]).toEqual([p, false]);
    }
  });

  test("rejects malformed paths", () => {
    for (const p of ["", "a.txt", "a/../b.md", "/a.md", "a//b.md", "a\\b.md", "tab\t.md", "Note.MD", "é.md"]) expect(isSyncablePath(p)).toBe(false);
  });
});
