// DPoP-bound JWT access tokens (RFC 9449), checked with oauth4webapi: the token (RFC 9068:
// signature, issuer, audience, expiry) and the request's proof (method, address, time, the
// token's hash, the key the token was issued to). The apps' tokens are always DPoP-bound; an
// AI app may use DPoP too, since the OAuth server offers it to every client.
import type { JWK } from "jose";
import * as oauth from "oauth4webapi";
import { publicJwks } from "./bearer.ts";

export type DPoPAccessCheck = (request: Request, audience: string) => Promise<oauth.JWTAccessTokenClaims>;

export function dpopAccess(origin: string, signingKeys: JWK[]): DPoPAccessCheck {
  const jwks = JSON.stringify(publicJwks(signingKeys));
  const as: oauth.AuthorizationServer = { issuer: origin, jwks_uri: `${origin}/oauth/jwks` };
  const options: oauth.ValidateJWTAccessTokenOptions = {
    requireDPoP: true,
    signingAlgorithms: ["ES256"],
    // Our own keys, from memory rather than over the network (so a plain-HTTP origin, in tests
    // and local runs, is fine too).
    [oauth.customFetch]: async () => new Response(jwks, { headers: { "content-type": "application/json" } }),
    [oauth.allowInsecureRequests]: origin.startsWith("http://"),
  };
  // Each proof works once: oauth4webapi checks its time (within 5 minutes either way) but keeps no
  // memory, so a proof seen in a log or a proxy could be sent again, with another query or body,
  // for as long as its token lives. The apps make a new proof (a new jti) for every request.
  const seen = new Map<string, number>();
  return async (request, audience) => {
    const claims = await oauth.validateJwtAccessToken(as, request, audience, options);
    const jti = proofJti(request.headers.get("dpop"));
    const now = Date.now();
    if (!jti || (seen.get(jti) ?? 0) > now) throw new Error("DPoP proof already used");
    if (seen.size > 100_000) for (const [k, until] of seen) if (until <= now) seen.delete(k);
    seen.set(jti, now + 11 * 60_000);
    return claims;
  };
}

function proofJti(proof: string | null): string | undefined {
  try {
    const body = JSON.parse(Buffer.from(proof?.split(".")[1] ?? "", "base64url").toString("utf8")) as { jti?: unknown };
    return typeof body.jti === "string" && body.jti.length >= 8 && body.jti.length <= 128 ? body.jti : undefined;
  } catch {
    return undefined;
  }
}
