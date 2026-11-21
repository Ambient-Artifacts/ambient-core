// Secrets at rest on the team server (the repo token, the Microsoft 365 client secret): sealed
// with a key derived from BRAIN_TEAM_SECRET, which lives in the env file and not in the data
// directory, so a backup or copy of the data alone doesn't hand out access. AES-256-GCM.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface Sealer {
  seal(plain: string): string;
  /** Throws when the text was sealed with another secret (or was changed). */
  open(sealed: string): string;
}

/** `purpose` keeps keys apart: the same secret seals the repo token and the settings differently. */
export function sealer(secret: string | null | undefined, purpose: string): Sealer | null {
  if (!secret) return null;
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), purpose, 32));
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
      return `v1.${iv.toString("base64url")}.${body.toString("base64url")}`;
    },
    open(sealed) {
      const [, iv, body] = sealed.split(".");
      const raw = Buffer.from(body ?? "", "base64url");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv ?? "", "base64url"));
      d.setAuthTag(raw.subarray(raw.length - 16));
      return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8");
    },
  };
}
