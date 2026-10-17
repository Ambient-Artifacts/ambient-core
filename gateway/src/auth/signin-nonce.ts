// Sign-in nonces: they tie an Apple or Microsoft ID token to this server. The app asks this
// server for one (GET /v1/app/sign-in-nonce) before it signs in with Apple or Microsoft, which put
// it into the ID token they sign. Without it, a token the app gave one server (a hostile
// "Use your own server", say) could be replayed to another, Ambient Cloud included, and sign the
// person in there: the token's audience is the app, not the server.
//
// Stateless: random, expiry and an HMAC (a key derived from the master key, so another server
// can't mint ours). Each works once; used ones are remembered until they expire.
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { MasterKey } from "../crypto.ts";

export const SIGNIN_NONCE_TTL_MS = 10 * 60_000;

export type NonceCheck = "ok" | "foreign" | "expired" | "used";

export class SignInNonces {
  private key: Buffer;
  private used = new Map<string, number>();

  constructor(master: MasterKey) {
    this.key = Buffer.from(hkdfSync("sha256", master.key, Buffer.alloc(0), "ambient sign-in nonce", 32));
  }

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }

  issue(now = Date.now()): { nonce: string; expiresAt: number } {
    const expiresAt = now + SIGNIN_NONCE_TTL_MS;
    const body = `${randomBytes(18).toString("base64url")}.${expiresAt}`;
    return { nonce: `${body}.${this.mac(body)}`, expiresAt };
  }

  /** Whether `nonce` is one of ours, still valid and not used yet; uses it up when it is. */
  check(nonce: string, now = Date.now()): NonceCheck {
    const parts = nonce.split(".");
    if (parts.length !== 3) return "foreign";
    const body = `${parts[0]}.${parts[1]}`;
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(parts[2]!);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return "foreign";
    const expiresAt = Number(parts[1]);
    if (!Number.isFinite(expiresAt) || expiresAt < now) return "expired";
    if (this.used.has(body)) return "used";
    if (this.used.size > 50_000) for (const [k, until] of this.used) if (until < now) this.used.delete(k);
    this.used.set(body, expiresAt);
    return "ok";
  }
}
