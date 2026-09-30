/**
 * Vault path rules shared by server and clients. Paths are vault-relative,
 * "/"-separated and NFC-normalized (macOS may hand us NFD).
 */

export const MAX_NOTE_BYTES = 10 * 1024 * 1024;

const IGNORED_ROOTS = new Set([".obsidian", ".trash"]);

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
  if (IGNORED_ROOTS.has(segments[0]!)) return `inside ${segments[0]}/`;
  if (segments.at(-1) === ".md") return "no file name";
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
