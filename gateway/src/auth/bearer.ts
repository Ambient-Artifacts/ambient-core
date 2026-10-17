// Turns an Authorization header into a Principal for one MCP resource URL.
// Access tokens are RFC 9068 JWTs from our own authorization server, bound to
// exactly one resource (`aud`), so a token minted for /t/<slug>/mcp can never
// read personal notes on /mcp. A client that uses DPoP sends its token as
// "DPoP …" with a proof (dpop.ts); a DPoP-bound token sent as "Bearer …" is
// refused, since without the proof anyone holding it could use it.
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import type { Directory, Team } from "../directory.ts";
import { dpopAccess } from "./dpop.ts";
import { LEGACY_PAT_PREFIX, PAT_PREFIX, type PatService } from "./pats.ts";

export interface Principal {
  uid: string;
  scopes: Set<string>;
  via: "oauth" | "pat";
  clientId?: string;
  /** Personal notes are readable only on /mcp with personal:read. */
  personal: boolean;
  /** Teams readable on this resource (team:read): all memberships on /mcp, one on /t/<slug>/mcp. */
  teams: Team[];
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "invalid_token" | "insufficient_scope" | "invalid_request",
    message: string,
    /**
     * A token nobody was given (a made-up PAT, a bad signature): what the failed-auth limiter
     * counts. An expired token is the normal first step of a refresh, and AI apps like claude.ai
     * share addresses, so counting those would lock everyone behind one address out.
     */
    readonly strike = false,
  ) {
    super(message);
  }
}

export interface ResourceTarget {
  /** Absolute resource URL, e.g. https://mcp.x/mcp or https://mcp.x/t/acme/mcp. */
  url: string;
  teamSlug: string | null;
}

export function publicJwks(keys: JWK[]): { keys: JWK[] } {
  return {
    keys: keys.map(({ kty, crv, x, y, kid, alg, use, n, e }) =>
      Object.fromEntries(Object.entries({ kty, crv, x, y, kid, alg, use, n, e }).filter(([, v]) => v !== undefined)),
    ),
  };
}

/** A DPoP request's method and proof header, when the token comes as "DPoP …". */
export interface DPoPRequest {
  method: string;
  proof?: string;
}

export function createBearerVerifier(opts: { issuer: string; signingKeys: JWK[]; directory: Directory; pats: PatService }) {
  const jwks = createLocalJWKSet(publicJwks(opts.signingKeys));
  const dpop = dpopAccess(opts.issuer, opts.signingKeys);

  return async function verify(header: string | undefined, target: ResourceTarget, request?: DPoPRequest): Promise<Principal> {
    const scheme = header?.startsWith("Bearer ") ? "bearer" : header?.startsWith("DPoP ") ? "dpop" : null;
    if (!header || !scheme) throw new AuthError(401, "invalid_request", "missing bearer token");
    const token = header.slice(scheme === "bearer" ? 7 : 5).trim();

    let uid: string;
    let scopes: Set<string>;
    let via: Principal["via"];
    let clientId: string | undefined;

    if (scheme === "bearer" && (token.startsWith(PAT_PREFIX) || token.startsWith(LEGACY_PAT_PREFIX))) {
      const pat = await opts.pats.find(token);
      if (!pat) throw new AuthError(401, "invalid_token", "unknown or revoked token", true);
      const team = target.teamSlug ? await opts.directory.teamBySlug(target.teamSlug) : undefined;
      const resourceOk =
        pat.resource.kind === "personal" ? target.teamSlug === null : team !== undefined && pat.resource.teamId === team.id;
      if (!resourceOk) throw new AuthError(401, "invalid_token", "token is not valid for this resource");
      uid = pat.uid;
      scopes = new Set(pat.scopes);
      via = "pat";
    } else {
      try {
        const payload =
          scheme === "dpop"
            ? await dpop(new Request(target.url, { method: request?.method ?? "POST", headers: { authorization: header, dpop: request?.proof ?? "" } }), target.url)
            : (await jwtVerify(token, jwks, { issuer: opts.issuer, audience: target.url, typ: "at+jwt", algorithms: ["ES256"] })).payload;
        if (!payload.sub) throw new Error("no sub");
        if (scheme === "bearer" && (payload.cnf as { jkt?: unknown } | undefined)?.jkt) throw new Error("DPoP-bound token sent as a bearer token");
        uid = payload.sub;
        scopes = new Set(String(payload.scope ?? "").split(" ").filter(Boolean));
        clientId = typeof payload.client_id === "string" ? payload.client_id : undefined;
        via = "oauth";
      } catch (err) {
        const expired = (err as { code?: unknown }).code === "ERR_JWT_EXPIRED";
        throw new AuthError(401, "invalid_token", "invalid, expired or wrong-audience token", !expired);
      }
    }

    // Account state and membership are re-checked on every request (cached
    // briefly), so a removed member loses access even with a live token.
    const user = await opts.directory.user(uid);
    if (!user) throw new AuthError(401, "invalid_token", "account disabled");

    let teams: Team[];
    if (target.teamSlug) {
      const team = await opts.directory.membership(uid, target.teamSlug);
      if (!team) throw new AuthError(403, "insufficient_scope", "not a member of this team");
      teams = [team];
    } else {
      teams = await opts.directory.teamsOf(uid);
    }
    teams = scopes.has("team:read") ? teams.filter((t) => t.status === "active") : [];
    const personal = target.teamSlug === null && scopes.has("personal:read");
    if (!personal && teams.length === 0) throw new AuthError(403, "insufficient_scope", "token grants no readable scope here");
    return { uid, scopes, via, clientId, personal, teams };
  };
}
