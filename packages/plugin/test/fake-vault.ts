import type { LocalFs } from "@bettersync/core";
import type { SimFs } from "@bettersync/sim";
import { ObsidianFs, type OpenNote, type VaultApi, type VaultEntry, type VaultFile, type VaultFolder } from "../src/obsidian-fs.ts";

/**
 * A fake Obsidian vault over the simulator's in-memory disk, behaving the
 * way the real one did when probed (Obsidian 1.13.7):
 *
 * - the index skips hidden paths, and looks paths up by exact name;
 * - createBinary needs its folder to exist, and fails if the file exists;
 * - folders are explicit and outlive their last file;
 * - an editor showing a note merges its unsaved typing into a changed note,
 *   but where the two overlap it keeps the new text and drops the typing.
 *
 * Writes go through the disk's engine view, so the simulator records any
 * content the plugin destroys. User changes on the disk reach the adapter
 * as vault events, like Obsidian's file watcher.
 */
export class FakeVault implements VaultApi {
  private readonly folders = new Set<string>();
  readonly editors: FakeEditor[] = [];
  private listeners: ((kind: "create" | "modify" | "delete" | "rename", entry: VaultEntry, oldPath?: string) => void)[] = [];

  constructor(
    readonly disk: SimFs,
    private readonly view: LocalFs,
  ) {
    disk.onUserChange = (kind, path, oldPath) => {
      if (hidden(path)) return;
      for (const d of parents(path)) this.folders.add(d);
      const entry = kind === "delete" ? { path, stat: { mtime: 0, size: 0 } } : this.fileAt(path)!;
      if (entry) this.emit(kind, entry, oldPath);
      if (kind !== "create") this.reloadEditors(oldPath ?? path, kind === "rename" ? path : null);
    };
  }

  on(fn: (kind: "create" | "modify" | "delete" | "rename", entry: VaultEntry, oldPath?: string) => void): void {
    this.listeners.push(fn);
  }

  private emit(kind: "create" | "modify" | "delete" | "rename", entry: VaultEntry, oldPath?: string) {
    for (const l of this.listeners) l(kind, entry, oldPath);
  }

  getFiles(): VaultFile[] {
    return this.disk
      .all()
      .filter((e) => !hidden(e.name))
      .map((e) => ({ path: e.name, stat: { mtime: e.mtime, size: e.bytes.length } }));
  }

  private fileAt(path: string): VaultFile | null {
    const e = this.disk.get(path);
    if (!e || e.name !== path || hidden(path)) return null;
    return { path: e.name, stat: { mtime: e.mtime, size: e.bytes.length } };
  }

  private folderAt(path: string): VaultFolder | null {
    if (path !== "" && !this.folders.has(path) && !this.getFiles().some((f) => f.path.startsWith(`${path}/`))) return null;
    const self = this;
    return {
      path,
      get children(): VaultEntry[] {
        const prefix = path === "" ? "" : `${path}/`;
        const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
        const folders = new Set([...self.folders].filter(direct));
        for (const f of self.getFiles()) for (const d of parents(f.path)) if (direct(d)) folders.add(d);
        return [...[...folders].map((d) => self.folderAt(d)!), ...self.getFiles().filter((f) => direct(f.path))];
      },
    };
  }

  getAbstractFileByPath(path: string): VaultEntry | null {
    return this.fileAt(path) ?? (path === "" ? null : this.folderAt(path));
  }

  getRoot(): VaultFolder {
    return this.folderAt("")!;
  }

  async readBinary(file: VaultFile): Promise<ArrayBuffer> {
    const bytes = await this.view.read(file.path);
    if (!bytes) throw new Error(`ENOENT: ${file.path}`);
    return bytes.slice().buffer;
  }

  async modifyBinary(file: VaultFile, data: ArrayBuffer): Promise<void> {
    if (!this.fileAt(file.path)) throw new Error(`ENOENT: ${file.path}`);
    await this.view.write(file.path, new Uint8Array(data));
    this.emit("modify", this.fileAt(file.path)!);
    this.reloadEditors(file.path, null);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<VaultFile> {
    if (this.disk.get(path)) throw new Error("File already exists.");
    const dir = parents(path).at(-1);
    if (dir !== undefined && !this.folderAt(dir)) throw new Error(`ENOENT: no such folder ${dir}`);
    await this.view.write(path, new Uint8Array(data));
    const f = this.fileAt(path)!;
    this.emit("create", f);
    return f;
  }

  async createFolder(path: string): Promise<unknown> {
    if (this.getAbstractFileByPath(path)) throw new Error("Folder already exists.");
    this.folders.add(path);
    return this.folderAt(path);
  }

  async delete(entry: VaultEntry, _force?: boolean): Promise<void> {
    if ("children" in entry) {
      if (entry.children.length > 0) throw new Error("folder not empty");
      this.folders.delete(entry.path);
      return;
    }
    await this.view.remove(entry.path);
    this.emit("delete", entry);
    this.reloadEditors(entry.path, null);
  }

  async rename(entry: VaultEntry, newPath: string): Promise<void> {
    if ("children" in entry) throw new Error("folder renames are not modelled");
    const dir = parents(newPath).at(-1);
    if (dir !== undefined && !this.folderAt(dir)) throw new Error(`ENOENT: no such folder ${dir}`);
    const old = entry.path;
    await this.view.rename(old, newPath);
    entry.path = newPath;
    this.emit("rename", this.fileAt(newPath)!, old);
    this.reloadEditors(old, newPath);
  }

  adapter = {
    stat: async (path: string) => {
      const e = this.disk.get(path);
      return e ? { type: "file", mtime: e.mtime, size: e.bytes.length } : null;
    },
    list: async (path: string) => {
      const dir = path === "/" ? "" : path;
      const prefix = dir === "" ? "" : `${dir}/`;
      const names = this.disk.all().map((e) => e.name).filter((n) => n.startsWith(prefix));
      return {
        files: names.filter((n) => !n.slice(prefix.length).includes("/")),
        folders: [...new Set(names.filter((n) => n.slice(prefix.length).includes("/")).map((n) => prefix + n.slice(prefix.length).split("/")[0]))],
      };
    },
  };

  // ---- editors ----

  open(path: string): FakeEditor {
    const e = new FakeEditor(this, path);
    this.editors.push(e);
    return e;
  }

  openNotes(path: string): OpenNote[] {
    return this.editors.filter((e) => e.path === path);
  }

  private reloadEditors(path: string, renamedTo: string | null) {
    for (const ed of this.editors) {
      if (ed.path !== path) continue;
      if (renamedTo !== null) ed.path = renamedTo;
      else ed.reload();
    }
  }
}

/** An editor tab: a text buffer that saves on `save()` (Obsidian autosaves 2 s after typing). */
export class FakeEditor implements OpenNote {
  buffer: string;
  /** What the editor last loaded or saved. */
  private saved: string;

  constructor(
    private readonly vault: FakeVault,
    public path: string,
  ) {
    this.saved = this.buffer = this.disk();
  }

  get dirty(): boolean {
    return this.buffer !== this.saved;
  }

  text(): string {
    return this.buffer;
  }

  savedText(): string {
    return this.saved;
  }

  setText(text: string): void {
    this.buffer = text;
  }

  private disk(): string {
    const e = this.vault.disk.get(this.path);
    return e ? new TextDecoder().decode(e.bytes) : "";
  }

  type(text: string): void {
    this.buffer = text;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.vault.disk.userWrite(this.path, new TextEncoder().encode(this.buffer));
    this.saved = this.buffer;
  }

  /** The note changed on disk. Obsidian keeps typing only where it does not overlap the change. */
  reload(): void {
    const now = this.disk();
    if (now === this.saved) return;
    this.buffer = this.dirty ? naiveMerge(this.saved, this.buffer, now) : now;
    this.saved = now;
  }
}

/** Line merge that, like Obsidian's, lets the disk win where both changed the same line. */
function naiveMerge(base: string, mine: string, disk: string): string {
  const b = base.split("\n");
  const m = mine.split("\n");
  const d = disk.split("\n");
  if (b.length !== m.length || b.length !== d.length) return disk;
  return d.map((line, i) => (line === b[i] ? m[i]! : line)).join("\n");
}

const hidden = (path: string) => path.split("/").some((s) => s.startsWith("."));

function parents(path: string): string[] {
  const segs = path.split("/");
  return segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join("/"));
}

/** An ObsidianFs on a fake vault, wired like the plugin wires the real one. */
export function obsidianFs(disk: SimFs, view: LocalFs): { fs: ObsidianFs; vault: FakeVault } {
  const vault = new FakeVault(disk, view);
  const fs = new ObsidianFs(vault, (p) => vault.openNotes(p), disk.caseInsensitive);
  vault.on((kind, entry, old) => fs.noteEvent(kind, entry, old));
  return { fs, vault };
}
