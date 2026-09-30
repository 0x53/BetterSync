import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConcurrentChangeError, DiskFs } from "../src/fs.ts";

/**
 * DiskFs on real disks. Runs in the system temp folder and, when
 * BETTERSYNC_CI_DIR names one, in a folder on a case-insensitive disk too
 * (e.g. /mnt/c/... under WSL, or any folder on macOS or Windows).
 */
const roots = [tmpdir(), ...(process.env.BETTERSYNC_CI_DIR ? [process.env.BETTERSYNC_CI_DIR] : [])];
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const enc = new TextEncoder();
const dec = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

function caseInsensitive(dir: string): boolean {
  writeFileSync(join(dir, "Probe"), "");
  const yes = existsSync(join(dir, "PROBE"));
  rmSync(join(dir, "Probe"));
  return yes;
}

for (const root of roots) {
  const fresh = () => {
    const d = mkdtempSync(join(root, "bettersync-fs-"));
    made.push(d);
    return d;
  };
  const insensitive = caseInsensitive(fresh());

  describe(`DiskFs in ${root} (${insensitive ? "case-insensitive" : "case-sensitive"})`, () => {
    test("write creates folders; read, stat and list agree", async () => {
      const dir = fresh();
      const fs = new DiskFs(dir);
      const st = await fs.write("Projects/Alpha.md", enc.encode("a\n"));
      expect(st).toMatchObject({ path: "Projects/Alpha.md", size: 2 });
      expect(dec(await fs.read("Projects/Alpha.md"))).toBe("a\n");
      expect(await fs.stat("Projects/Alpha.md")).toEqual(st);
      expect((await fs.list()).map((s) => s.path)).toEqual(["Projects/Alpha.md"]);
      expect(await fs.read("Missing.md")).toBeNull();
      expect(await fs.stat("Missing.md")).toBeNull();
    });

    test("overwrite is atomic and leaves no temp files", async () => {
      const dir = fresh();
      const fs = new DiskFs(dir);
      await fs.write("A.md", enc.encode("one"));
      await fs.read("A.md");
      await fs.write("A.md", enc.encode("two"));
      expect(readFileSync(join(dir, "A.md"), "utf8")).toBe("two");
      expect(readdirSync(dir)).toEqual(["A.md"]);
    });

    test("temp files from a killed process are hidden and cleaned", async () => {
      const dir = fresh();
      writeFileSync(join(dir, ".bettersync-abc123.tmp"), "partial");
      const fs = new DiskFs(dir);
      expect(await fs.list()).toEqual([]);
      expect(await fs.cleanTemp()).toBe(1);
      expect(readdirSync(dir)).toEqual([]);
    });

    test("refuses to overwrite a file edited since the engine read it", async () => {
      const dir = fresh();
      const fs = new DiskFs(dir);
      await fs.write("A.md", enc.encode("synced"));
      await fs.read("A.md");
      await Bun.sleep(5);
      writeFileSync(join(dir, "A.md"), "user edit!");
      await expect(fs.write("A.md", enc.encode("server"))).rejects.toBeInstanceOf(ConcurrentChangeError);
      await expect(fs.remove("A.md")).rejects.toBeInstanceOf(ConcurrentChangeError);
      await expect(fs.rename("A.md", "B.md")).rejects.toBeInstanceOf(ConcurrentChangeError);
      expect(readFileSync(join(dir, "A.md"), "utf8")).toBe("user edit!");
      // Once the engine has looked again, it may act.
      await fs.read("A.md");
      await fs.write("A.md", enc.encode("server"));
      expect(readFileSync(join(dir, "A.md"), "utf8")).toBe("server");
    });

    test("refuses to write where a file appeared, or vanished, since the engine looked", async () => {
      const dir = fresh();
      const fs = new DiskFs(dir);
      expect(await fs.variants("New.md")).toEqual([]);
      writeFileSync(join(dir, "New.md"), "user");
      await expect(fs.write("New.md", enc.encode("server"))).rejects.toBeInstanceOf(ConcurrentChangeError);
      expect(readFileSync(join(dir, "New.md"), "utf8")).toBe("user");

      await fs.read("New.md");
      rmSync(join(dir, "New.md"));
      await expect(fs.write("New.md", enc.encode("server"))).rejects.toBeInstanceOf(ConcurrentChangeError);
      expect(await fs.variants("New.md")).toEqual([]);
      await fs.write("New.md", enc.encode("server"));
    });

    test("remove prunes folders it emptied, never the root", async () => {
      const dir = fresh();
      const fs = new DiskFs(dir);
      await fs.write("a/b/C.md", enc.encode("x"));
      await fs.read("a/b/C.md");
      await fs.remove("a/b/C.md");
      expect(readdirSync(dir)).toEqual([]);
      expect(existsSync(dir)).toBe(true);
    });

    test("rename moves between folders and prunes the old one", async () => {
      const dir = fresh();
      const fs = new DiskFs(dir);
      await fs.write("old/N.md", enc.encode("x"));
      await fs.read("old/N.md");
      await fs.rename("old/N.md", "new/deeper/N.md");
      expect(readdirSync(dir)).toEqual(["new"]);
      expect(dec(await fs.read("new/deeper/N.md"))).toBe("x");
    });

    test("rename refuses to replace another file", async () => {
      const dir = fresh();
      const fs = new DiskFs(dir);
      await fs.write("A.md", enc.encode("a"));
      await fs.write("B.md", enc.encode("b"));
      await fs.read("A.md");
      await expect(fs.rename("A.md", "B.md")).rejects.toBeInstanceOf(ConcurrentChangeError);
    });

    test("NFD names on disk read as NFC", async () => {
      const dir = fresh();
      const nfd = "Notes/Émigré.md";
      const nfc = nfd.normalize("NFC");
      mkdirSync(join(dir, "Notes"));
      writeFileSync(join(dir, nfd), "mac");
      const fs = new DiskFs(dir);
      expect((await fs.list()).map((s) => s.path)).toEqual([nfc]);
      expect(dec(await fs.read(nfc))).toBe("mac");
      expect((await fs.stat(nfc))?.path).toBe(nfc);
      await fs.write(nfc, enc.encode("synced"));
      expect((await fs.list()).map((s) => s.path)).toEqual([nfc]);
      expect(dec(await fs.read(nfc))).toBe("synced");
    });

    test("symlinks are not followed", async () => {
      const dir = fresh();
      const outside = fresh();
      writeFileSync(join(outside, "Secret.md"), "x");
      try {
        symlinkSync(outside, join(dir, "link"));
        symlinkSync(join(outside, "Secret.md"), join(dir, "Linked.md"));
      } catch {
        return; // no symlink permission (Windows without developer mode)
      }
      expect(await new DiskFs(dir).list()).toEqual([]);
    });

    if (insensitive) {
      test("case: stat finds another case and reports the actual name", async () => {
        const dir = fresh();
        const fs = new DiskFs(dir);
        await fs.write("Projects/Note.md", enc.encode("x"));
        expect((await fs.stat("projects/note.md"))?.path).toBe("Projects/Note.md");
        expect(await fs.variants("PROJECTS/NOTE.md")).toEqual(["Projects/Note.md"]);
      });

      test("case: a case-only rename works", async () => {
        const dir = fresh();
        const fs = new DiskFs(dir);
        await fs.write("Note.md", enc.encode("x"));
        await fs.read("Note.md");
        await fs.rename("Note.md", "note.md");
        expect(readdirSync(dir)).toEqual(["note.md"]);
      });

      test("case: a write over another case keeps the actual name", async () => {
        const dir = fresh();
        const fs = new DiskFs(dir);
        await fs.write("Note.md", enc.encode("x"));
        await fs.read("note.md");
        await fs.write("note.md", enc.encode("y"));
        expect(readdirSync(dir)).toEqual(["Note.md"]);
        expect(readFileSync(join(dir, "Note.md"), "utf8")).toBe("y");
      });

      test("case: notes in one folder keep the folder's case", async () => {
        const dir = fresh();
        const fs = new DiskFs(dir);
        await fs.write("Projects/A.md", enc.encode("a"));
        await fs.write("projects/B.md", enc.encode("b"));
        expect((await fs.list()).map((s) => s.path).sort()).toEqual(["Projects/A.md", "Projects/B.md"]);
      });
    } else {
      test("case: other cases are other files", async () => {
        const dir = fresh();
        const fs = new DiskFs(dir);
        await fs.write("Note.md", enc.encode("x"));
        expect(await fs.stat("note.md")).toBeNull();
        await fs.write("note.md", enc.encode("y"));
        expect((await fs.variants("NOTE.md")).sort()).toEqual(["Note.md", "note.md"]);
        mkdirSync(join(dir, "projects"));
        mkdirSync(join(dir, "Projects"));
        writeFileSync(join(dir, "projects", "A.md"), "1");
        writeFileSync(join(dir, "Projects", "a.md"), "2");
        expect((await fs.variants("PROJECTS/A.MD")).sort()).toEqual(["Projects/a.md", "projects/A.md"]);
      });
    }
  });
}
