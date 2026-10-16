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
  return (request, audience) => oauth.validateJwtAccessToken(as, request, audience, options);
}
