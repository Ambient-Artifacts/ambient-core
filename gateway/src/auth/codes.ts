// One-time codes people type or share: AI-app sign-in codes, team invites, computer setup codes.
// They're short so they can be typed (8 characters, about 40 bits), which is plenty against
// guessing online (rate limits, expiry) but not against a copy of the database: a plain SHA-256
// of 40 bits is worked out on one GPU in minutes. So they're stored as an HMAC with a key derived
// from the master key, which Convex never sees.
import { createHmac, hkdfSync } from "node:crypto";
import { sha256Hex, type MasterKey } from "../crypto.ts";

export type CodePurpose = "pair" | "invite" | "host-setup";

export class CodeHasher {
  private key: Buffer;

  constructor(master: MasterKey) {
    this.key = Buffer.from(hkdfSync("sha256", master.key, Buffer.alloc(0), "ambient code hashes", 32));
  }

  /** What's stored for a new code. */
  hash(purpose: CodePurpose, code: string): string {
    return `h1:${createHmac("sha256", this.key).update(`${purpose}:${code}`).digest("hex")}`;
  }

  /**
   * What a typed code is looked up by, in order: the keyed hash, then the plain SHA-256 that codes
   * made before had (and that the staff scripts ops/new-invite.mjs and ops/new-computer.mjs still
   * make, since they don't hold the master key).
   */
  candidates(purpose: CodePurpose, code: string): string[] {
    return [this.hash(purpose, code), sha256Hex(`${purpose}:${code}`)];
  }
}
