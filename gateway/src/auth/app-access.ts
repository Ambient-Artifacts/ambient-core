// The app API's access check: the apps' tokens come from our OAuth server (oauth/provider.ts),
// for the app API only, and DPoP-bound, so every request carries a fresh proof signed with the
// key the token was issued to (dpop.ts).
import type { Request as ExpressRequest } from "express";
import type { JWK } from "jose";
import { APP_CLIENT_ID, appResource } from "../oauth/provider.ts";
import { dpopAccess } from "./dpop.ts";

/** The user an app request is from, or null when its token or proof doesn't hold. */
export type AppAccess = (req: ExpressRequest) => Promise<string | null>;

export function appAccess(origin: string, signingKeys: JWK[]): AppAccess {
  const check = dpopAccess(origin, signingKeys);
  const audience = appResource(origin);

  return async (req) => {
    const authorization = req.headers.authorization;
    const proof = req.headers.dpop;
    if (!authorization || typeof proof !== "string") return null;
    // The address the app signed its proof for: the public origin (TLS ends at Caddy).
    const request = new Request(new URL(req.originalUrl, origin), { method: req.method, headers: { authorization, dpop: proof } });
    try {
      const claims = await check(request, audience);
      if (claims.client_id !== APP_CLIENT_ID || !String(claims.scope ?? "").split(" ").includes("app")) return null;
      return claims.sub;
    } catch {
      return null;
    }
  };
}
