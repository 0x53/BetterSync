/**
 * SHA-256 of note contents as lowercase hex: the blob address. Uses Web
 * Crypto, which exists in Bun, Electron (desktop Obsidian) and iOS WebKit.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export const isSha256Hex = (s: string) => /^[0-9a-f]{64}$/.test(s);
