/**
 * Vault path rules shared by server and clients. Paths are vault-relative,
 * "/"-separated and NFC-normalized (macOS may hand us NFD).
 */

export const MAX_NOTE_BYTES = 10 * 1024 * 1024;

/** Characters Windows cannot store in a name (iOS and macOS also refuse ":"). */
const NON_PORTABLE = /[<>:"|?*]/;
/** Device names Windows reserves, with or without an extension. */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function normalizePath(path: string): string {
  return path.normalize("NFC");
}

/** Why a path cannot be synced, or null if it can. Expects a normalized path. */
export function invalidPathReason(path: string): string | null {
  if (path !== normalizePath(path)) return "not NFC-normalized";
  if (!path.endsWith(".md")) return "not a .md note";
  if (path.includes("\\")) return "contains a backslash";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "contains a control character";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "empty, '.' or '..' segment";
  // Obsidian hides and never indexes these (.obsidian, .trash, .git, ...), so its plugin could not keep them.
  if (segments.some((s) => s.startsWith("."))) return "hidden (a name starts with '.')";
  // Every device must be able to hold every note, or its client stalls on it.
  if (segments.some((s) => NON_PORTABLE.test(s))) return 'contains one of < > : " | ? *';
  if (segments.some((s) => s.endsWith(" ") || s.endsWith("."))) return "a name ends with a space or '.'";
  if (segments.some((s) => RESERVED.test(s))) return "a name Windows reserves (CON, NUL, COM1, ...)";
  return null;
}

export const isSyncablePath = (path: string) => invalidPathReason(path) === null;

/**
 * Identity of a path on a case-insensitive filesystem (Windows, macOS, iOS).
 * Two different paths with the same key cannot coexist on those devices, so
 * the server treats a case-only rename as a move and refuses a second path
 * with an existing key.
 */
export function pathKey(path: string): string {
  return normalizePath(path).toLowerCase();
}

/**
 * Whether two names for one note agree as far as a device controls them:
 * the file name exactly, folder names ignoring case. On a case-insensitive
 * disk "Projects/a.md" and "projects/b.md" share one folder, so a device
 * cannot give each note its own folder case; treating that as a rename would
 * make devices move notes back and forth forever.
 */
export function sameNoteName(a: string, b: string): boolean {
  if (a === b) return true;
  const i = a.lastIndexOf("/");
  const j = b.lastIndexOf("/");
  return a.slice(i + 1) === b.slice(j + 1) && pathKey(a.slice(0, i + 1)) === pathKey(b.slice(0, j + 1));
}

/**
 * Name for the losing side of a conflict, next to the note:
 * "Folder/Note.md" → "Folder/Note (conflict 2026-09-30 laptop).md", with
 * " 2", " 3", ... appended if that key is taken.
 */
export function conflictCopyPath(path: string, date: string, device: string, taken: (key: string) => boolean): string {
  const stem = path.slice(0, -".md".length);
  const label = `conflict ${date} ${device.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")}`;
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${label}${n === 1 ? "" : ` ${n}`}).md`;
    if (!taken(pathKey(candidate))) return candidate;
  }
}
