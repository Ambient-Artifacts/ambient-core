// Personal access tokens for MCP clients without OAuth. Only the SHA-256 of
// the token is stored; the plaintext is shown once at creation.
import { randomBytes } from "node:crypto";
import { api, type Control } from "../control.ts";
import { sha256Hex } from "../crypto.ts";

export type PatResource = { kind: "personal" } | { kind: "team"; teamId: string };

export interface PatRecord {
  id: string;
  uid: string;
  scopes: string[];
  resource: PatResource;
}

export const PAT_PREFIX = "ambient_pat_";
/** Tokens created before the product was renamed to Ambient. */
export const LEGACY_PAT_PREFIX = "brain_pat_";

export class PatService {
  constructor(private control: Control) {}

  async create(input: { uid: string; scopes: string[]; resource: PatResource; label: string; expiresAt?: number }) {
    const token = `${PAT_PREFIX}${randomBytes(24).toString("base64url")}`;
    const id = await this.control.m(api.auth.createPat, {
      uid: input.uid as never,
      hash: sha256Hex(token),
      scopes: input.scopes,
      resourceKind: input.resource.kind,
      teamId: input.resource.kind === "team" ? (input.resource.teamId as never) : undefined,
      label: input.label.slice(0, 80),
      expiresAt: input.expiresAt,
      now: Date.now(),
    });
    return { token, id: String(id) };
  }

  /** The user's live tokens (label, scopes, dates), for the app and the admin CLI. */
  async list(uid: string) {
    return (await this.control.q(api.auth.listPats, { uid: uid as never, now: Date.now() })).map((p) => ({ ...p, id: String(p.id), teamId: p.teamId ? String(p.teamId) : null }));
  }

  /** Revoke one of the user's tokens; false when they have no live token with that id. */
  async revoke(uid: string, id: string): Promise<boolean> {
    return (await this.control.m(api.auth.revokePat, { uid: uid as never, id, now: Date.now() })).ok;
  }

  async find(token: string): Promise<PatRecord | undefined> {
    const r = await this.control.q(api.auth.findPat, { hash: sha256Hex(token), now: Date.now() });
    if (!r) return undefined;
    return { id: String(r.id), uid: String(r.uid), scopes: r.scopes, resource: r.resource as PatResource };
  }
}
