// Pairing codes: the signed-in app (or the admin CLI) shows an 8-character code, the user types it on
// the OAuth login page, and that approves the AI app as this user. No web
// sign-in needed. Codes live 5 minutes, work once, and a new code replaces the
// old one. Brute force is capped per login attempt (see interactions.ts).
import { randomInt } from "node:crypto";
import { api, type Control } from "../control.ts";
import { sha256Hex } from "../crypto.ts";

export const PAIRING_TTL_MS = 5 * 60_000;
/** No 0/O/1/I, so a code read off a screen is typed right. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 32^8, about 10^12 codes: 6 digits (10^6) could be guessed (see oauth/interactions.ts). */
export const PAIRING_CODE_LENGTH = 8;

/** What was typed, as a code: any case, spaces and dashes ignored. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function newCode(): string {
  return Array.from({ length: PAIRING_CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

export class Pairing {
  constructor(private control: Control) {}

  async create(uid: string): Promise<{ code: string; expiresAt: number }> {
    const now = Date.now();
    const expiresAt = now + PAIRING_TTL_MS;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      const ok = await this.control.m(api.auth.createPairingCode, { uid: uid as never, codeHash: sha256Hex(`pair:${code}`), expiresAt, now });
      if (ok) return { code, expiresAt };
    }
    throw new Error("could not allocate a pairing code");
  }

  async consume(input: string): Promise<string | null> {
    const code = normalizeCode(input);
    if (code.length !== PAIRING_CODE_LENGTH || ![...code].every((c) => ALPHABET.includes(c))) return null;
    const uid = await this.control.m(api.auth.consumePairingCode, { codeHash: sha256Hex(`pair:${code}`), now: Date.now() });
    return uid ? String(uid) : null;
  }
}
