/** Synchronous SHA-256, so hashing never yields to the event loop mid-simulation. */
export function hashSync(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export const hashAsync = async (bytes: Uint8Array) => hashSync(bytes);
