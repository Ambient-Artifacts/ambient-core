// Envelope encryption for personal pages.
// - Each user has a random 256-bit data key (DEK).
// - The DEK is stored in Convex wrapped (AES-256-GCM) by the gateway's master
//   key, which never leaves the core servers.
// - Pages are AES-256-GCM encrypted with the DEK; the AAD binds a ciphertext
//   to its user and path, so rows can't be swapped between users or files.
// Deleting the wrapped DEK makes all of a user's stored pages unreadable.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface MasterKey {
  id: string;
  key: Buffer;
}

export function parseMasterKey(id: string, base64: string): MasterKey {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("master key must be 32 bytes (base64)");
  return { id, key };
}

function seal(key: Buffer, plaintext: Buffer, aad: string): { iv: string; ciphertext: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString("base64"), ciphertext: body.toString("base64") };
}

function open(key: Buffer, iv: string, ciphertext: string, aad: string): Buffer {
  const body = Buffer.from(ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
}

export function newDataKey(): Buffer {
  return randomBytes(32);
}

export function wrapDataKey(master: MasterKey, uid: string, dek: Buffer): string {
  const { iv, ciphertext } = seal(master.key, dek, `dek:${uid}`);
  return `${iv}.${ciphertext}`;
}

export function unwrapDataKey(master: MasterKey, uid: string, wrapped: string): Buffer {
  const [iv, ciphertext] = wrapped.split(".");
  if (!iv || !ciphertext) throw new Error("malformed wrapped key");
  return open(master.key, iv, ciphertext, `dek:${uid}`);
}

export function encryptPage(dek: Buffer, uid: string, path: string, content: string) {
  return seal(dek, Buffer.from(content, "utf8"), `page:${uid}:${path}`);
}

export function decryptPage(dek: Buffer, uid: string, path: string, iv: string, ciphertext: string): string {
  return open(dek, iv, ciphertext, `page:${uid}:${path}`).toString("utf8");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
