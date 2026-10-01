import { ConcurrentChangeError, LocalBusyError, merge3, pathKey, type LocalFs, type LocalStat } from "@bettersync/core";

/**
 * The parts of Obsidian's Vault the adapter uses. The real Vault, TFile and
 * TFolder fit these shapes; tests and the simulator use a fake.
 */
export interface VaultFile {
  path: string;
  stat: { mtime: number; size: number };
}
export interface VaultFolder {
  path: string;
  children: VaultEntry[];
}
export type VaultEntry = VaultFile | VaultFolder;

export interface VaultApi {
  getFiles(): VaultFile[];
  getAbstractFileByPath(path: string): VaultEntry | null;
  getRoot(): VaultFolder;
  readBinary(file: VaultFile): Promise<ArrayBuffer>;
  modifyBinary(file: VaultFile, data: ArrayBuffer): Promise<void>;
  createBinary(path: string, data: ArrayBuffer): Promise<VaultFile>;
  createFolder(path: string): Promise<unknown>;
  delete(file: VaultEntry, force?: boolean): Promise<void>;
  rename(file: VaultEntry, newPath: string): Promise<void>;
  adapter: {
    stat(path: string): Promise<{ type: string; mtime: number; size: number } | null>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
  };
}

/** An editor showing a note. `dirty`: it holds typing not yet saved to disk. */
export interface OpenNote {
  readonly dirty: boolean;
  save(): Promise<void>;
  /** The editor's text, typing included. */
  text(): string;
  /** The text the editor last loaded or saved: what Obsidian merges its typing from. */
  savedText(): string;
  /** Replaces the editor's text in one synchronous step that keeps the cursor, as if typed. */
  setText(text: string): void;
}

export const isFolder = (e: VaultEntry): e is VaultFolder => "children" in e;

/**
 * An Obsidian vault as the engine's LocalFs (design doc, "Obsidian plugin").
 *
 * Writes go through the Vault API, so Obsidian's index stays current and an
 * open editor shows the new text at once. Obsidian keeps no index of hidden
 * paths, which is why the path rules leave them out everywhere.
 *
 * Open notes. An editor holds typing for up to 2 s before Obsidian saves
 * it. If the note changes on disk meanwhile, Obsidian merges the typing into
 * the new text, but where the two overlap it keeps the new text and drops
 * the typing, and a keystroke can land between any check and that merge. So
 * for a note open in an editor the adapter does not write the file: it
 * merges the incoming text into the editor itself, in one synchronous step
 * no keystroke can split, and has the editor save. Typing that overlaps the
 * change is never merged: the change waits (LocalBusyError), the note is
 * `busy` until the editor saves, and the typing is then pushed and merged by
 * the server or kept as a conflict copy. A note with typing is never deleted
 * from under its editor.
 *
 * Concurrent edits otherwise work as in the headless DiskFs: the adapter
 * remembers each file's disk stat as of the engine's last read, and refuses
 * to replace, delete or rename a file that changed since, or to write where
 * a file appeared or vanished. What remains is the time the write itself
 * takes.
 *
 * Names. The engine works in NFC vault paths; Obsidian reports names as they
 * are on disk (NFD from a Mac, other case on a case-insensitive disk). A path
 * resolves to the actual file through an index by path key, kept up to date
 * from vault events (`noteEvent`) and rebuilt on every listing.
 */
export class ObsidianFs implements LocalFs {
  /** Disk stat of each file as of the engine's last read, by actual path; null = it was not there. */
  private readonly seen = new Map<string, string | null>();
  /** Keys of notes whose remote change waits on an editor's typing. */
  private readonly busy = new Set<string>();
  /** Actual paths of files by path key. */
  private index = new Map<string, Set<string>>();
  private indexStale = true;

  constructor(
    private readonly vault: VaultApi,
    /** The editors showing a note, by its actual path. */
    private readonly openNotes: (path: string) => OpenNote[],
    /** Whether the vault's disk ignores case (Windows, macOS, iOS). */
    readonly caseInsensitive: boolean,
  ) {}

  /** Tell the adapter about a vault event, so its index stays current between listings. */
  noteEvent(kind: "create" | "delete" | "rename" | "modify", entry: VaultEntry, oldPath?: string): void {
    if (isFolder(entry)) {
      // A folder's files move or go with it; rebuild rather than trust per-file events.
      this.indexStale = true;
      return;
    }
    if (oldPath !== undefined) this.unindex(oldPath);
    if (kind === "delete") this.unindex(entry.path);
    else if (kind !== "modify") this.addIndex(entry.path);
  }

  /** Whether a remote change to this note waits on its editor; saving the editor early would only make a conflict copy. */
  isBusy(path: string): boolean {
    return this.busy.has(pathKey(path));
  }

  async list(): Promise<LocalStat[]> {
    const files = this.vault.getFiles();
    this.rebuild(files);
    return files.map(toStat);
  }

  async stat(path: string): Promise<LocalStat | null> {
    const f = this.resolve(path);
    if (!f) {
      this.seen.set(path, null);
      return null;
    }
    return toStat(f);
  }

  async variants(path: string): Promise<string[]> {
    const found = [...(this.keyIndex().get(pathKey(path)) ?? [])].filter((p) => this.fileAt(p));
    if (found.length === 0) this.seen.set(path, null);
    return found.map(nfc).sort();
  }

  async read(path: string): Promise<Uint8Array | null> {
    const f = this.resolve(path);
    if (!f) {
      this.seen.set(path, null);
      return null;
    }
    const before = await this.diskSig(f.path);
    if (before === null) return null;
    let data: ArrayBuffer;
    try {
      data = await this.vault.readBinary(f);
    } catch (e) {
      if ((await this.diskSig(f.path)) === null) return null;
      throw e;
    }
    const after = await this.diskSig(f.path);
    if (after !== before) throw new ConcurrentChangeError(path, "changed while being read");
    this.seen.set(f.path, after);
    return new Uint8Array(data);
  }

  async write(path: string, bytes: Uint8Array): Promise<LocalStat> {
    const existing = this.resolve(path);
    await this.checkUnchanged(existing?.path ?? null, path);
    const data = toArrayBuffer(bytes);
    let f: VaultFile;
    if (existing) {
      // Keeps the existing name (folder case included), like a save in an editor.
      if (!(await this.writeThroughEditors(existing, path, bytes))) await this.vault.modifyBinary(existing, data);
      f = existing;
    } else {
      const target = await this.prepareFolders(path);
      try {
        f = await this.vault.createBinary(target, data);
      } catch (e) {
        if (this.resolve(path)) throw new ConcurrentChangeError(path, "appeared while being written");
        throw e;
      }
      this.addIndex(f.path);
    }
    this.busy.delete(pathKey(path));
    this.seen.set(f.path, await this.diskSig(f.path));
    return toStat(f);
  }

  async remove(path: string): Promise<void> {
    const f = this.resolve(path);
    if (!f) return;
    await this.checkUnchanged(f.path, path);
    this.checkEditors(f.path, path, null);
    await this.vault.delete(f, true);
    this.busy.delete(pathKey(path));
    this.unindex(f.path);
    this.seen.set(f.path, null);
    await this.pruneEmpty(parentOf(f.path));
  }

  async rename(from: string, to: string): Promise<void> {
    const src = this.resolve(from);
    if (!src) throw new Error(`rename: ${from} is missing`);
    await this.checkUnchanged(src.path, from);
    const dst = this.resolve(to);
    if (dst && dst.path !== src.path) throw new ConcurrentChangeError(to, "is another file");
    const old = src.path;
    const target = await this.prepareFolders(to);
    await this.vault.rename(src, target);
    if (old !== target && pathKey(old) === pathKey(target)) await this.finishCaseRename(src, target);
    this.unindex(old);
    this.addIndex(src.path);
    this.seen.set(old, null);
    this.seen.set(src.path, await this.diskSig(src.path));
    if (pathKey(parentOf(old)) !== pathKey(parentOf(target))) await this.pruneEmpty(parentOf(old));
  }

  /**
   * A case-only rename on a case-folding Linux disk (Android's shared
   * storage, ext4 with casefold) leaves the name on disk as it was, since
   * both names are the same file, while Obsidian's index takes the new one.
   * If the disk kept the old name, rename through a temporary name.
   * (NTFS and APFS change the case in place.)
   */
  private async finishCaseRename(file: VaultFile, target: string): Promise<void> {
    const dir = parentOf(target);
    const onDisk = (await this.vault.adapter.list(dir)).files.map((f) => f.split("/").pop()!);
    const name = target.split("/").pop()!;
    if (onDisk.includes(name) || !onDisk.some((f) => pathKey(f) === pathKey(name))) return;
    const tmp = `${target.slice(0, -".md".length)}.bettersync-${Date.now().toString(36)}.md`;
    await this.vault.rename(file, tmp);
    await this.vault.rename(file, target);
  }

  // ---- names ----

  /**
   * The file the filesystem opens for `path`: the exact name (after NFC),
   * or on a disk that ignores case, the one file with its key.
   */
  private resolve(path: string): VaultFile | null {
    const exact = this.fileAt(path);
    if (exact) return exact;
    const candidates = [...(this.keyIndex().get(pathKey(path)) ?? [])].map((p) => this.fileAt(p)).filter((f): f is VaultFile => f !== null);
    const nfcMatch = candidates.find((f) => nfc(f.path) === path);
    if (nfcMatch) return nfcMatch;
    return this.caseInsensitive ? (candidates[0] ?? null) : null;
  }

  private fileAt(path: string): VaultFile | null {
    const e = this.vault.getAbstractFileByPath(path);
    return e && !isFolder(e) ? e : null;
  }

  /**
   * Creates the folders `path` needs and returns the path to create the file
   * at. On a disk that ignores case, existing folders keep their names
   * ("projects/a.md" goes into "Projects/"), as the disk would do anyway.
   */
  private async prepareFolders(path: string): Promise<string> {
    const segments = path.split("/");
    const name = segments.pop()!;
    let dir = this.vault.getRoot();
    let prefix = "";
    for (const seg of segments) {
      const want = prefix + seg;
      let next = dir.children.find((c): c is VaultFolder => isFolder(c) && c.path === want) ?? null;
      if (!next && this.caseInsensitive) next = dir.children.find((c): c is VaultFolder => isFolder(c) && pathKey(c.path) === pathKey(want)) ?? null;
      if (!next) {
        if (dir.children.some((c) => !isFolder(c) && pathKey(c.path) === pathKey(want))) throw new Error(`${want} is a file`);
        await this.vault.createFolder(want);
        const made = this.vault.getAbstractFileByPath(want);
        if (!made || !isFolder(made)) throw new Error(`could not create folder ${want}`);
        next = made;
      }
      dir = next;
      prefix = `${next.path}/`;
    }
    return prefix + name;
  }

  /** Removes folders left empty by the engine's own deletes and moves, up to the root. */
  private async pruneEmpty(dir: string): Promise<void> {
    while (dir !== "") {
      const e = this.vault.getAbstractFileByPath(dir);
      if (!e || !isFolder(e) || e.children.length > 0) return;
      try {
        await this.vault.delete(e, true);
      } catch {
        return;
      }
      dir = parentOf(dir);
    }
  }

  private keyIndex(): Map<string, Set<string>> {
    if (this.indexStale) this.rebuild(this.vault.getFiles());
    return this.index;
  }

  private rebuild(files: VaultFile[]): void {
    this.index = new Map();
    for (const f of files) this.addIndex(f.path);
    this.indexStale = false;
  }

  private addIndex(path: string): void {
    const key = pathKey(path);
    let set = this.index.get(key);
    if (!set) this.index.set(key, (set = new Set()));
    set.add(path);
  }

  private unindex(path: string): void {
    const key = pathKey(path);
    const set = this.index.get(key);
    if (!set) return;
    set.delete(path);
    if (set.size === 0) this.index.delete(key);
  }

  // ---- concurrent edits ----

  private async diskSig(path: string): Promise<string | null> {
    const st = await this.vault.adapter.stat(path);
    return st && st.type === "file" ? `${st.mtime}:${st.size}` : null;
  }

  private async checkUnchanged(actual: string | null, path: string): Promise<void> {
    if (actual === null) {
      if (this.seen.get(path)) throw new ConcurrentChangeError(path, "was deleted since it was read");
      return;
    }
    if (this.seen.get(actual) !== (await this.diskSig(actual))) throw new ConcurrentChangeError(path, "changed since it was read");
  }

  /**
   * Puts `bytes` into the editors showing the note, merged with any typing,
   * and saves; false if no editor shows it (the caller writes the file).
   * If typing overlaps the change, nothing changes and the note is busy.
   *
   * The file then holds the new text plus the typing, while the engine
   * records the new text: its stat is racy (just written), so the next pass
   * rehashes, finds the typing, and pushes it as a local edit.
   */
  private async writeThroughEditors(file: VaultFile, path: string, bytes: Uint8Array): Promise<boolean> {
    const notes = this.openNotes(file.path);
    if (notes.length === 0) return false;
    const incoming = decodeUtf8(bytes);
    // The editor turns CRLF into LF and cannot hold other bytes: write the file, if no typing is at stake.
    if (incoming === null || incoming.includes("\r")) {
      this.checkEditors(file.path, path, bytes);
      return false;
    }
    // From here to setText nothing awaits, so no keystroke can come between the merge and its result.
    const merged = notes.map((n) => merge3(n.savedText(), n.text(), incoming));
    if (merged.some((m) => !m.clean)) {
      this.busy.add(pathKey(path));
      throw new LocalBusyError(path, "has unsaved typing that overlaps the incoming change");
    }
    notes.forEach((n, i) => n.setText((merged[i] as { text: string }).text));
    for (const n of notes) await n.save();
    return true;
  }

  /**
   * Stops (LocalBusyError) if an editor holds typing that replacing the note
   * with `next` (null: deleting it) would lose.
   */
  private checkEditors(actual: string, path: string, next: Uint8Array | null): void {
    for (const n of this.openNotes(actual)) {
      if (!n.dirty) continue;
      const incoming = next === null ? null : decodeUtf8(next);
      if (incoming !== null && !incoming.includes("\r") && merge3(n.savedText(), n.text(), incoming).clean) continue;
      this.busy.add(pathKey(path));
      throw new LocalBusyError(path, next === null ? "is open with unsaved typing" : "has unsaved typing that overlaps the incoming change");
    }
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

const nfc = (s: string) => s.normalize("NFC");

function toStat(f: VaultFile): LocalStat {
  return { path: nfc(f.path), mtime: f.stat.mtime, size: f.stat.size };
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes.buffer : (bytes.slice().buffer as ArrayBuffer);
}
