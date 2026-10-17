// Sign in with Apple: the app gets an identity token from Apple and sends it to the sign-in
// step (oauth/interactions.ts), which checks it here before signing the app in.
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWK } from "jose";

export interface AppleIdentity {
  sub: string;
  email?: string;
  /** Apple confirmed the email (a "Hide My Email" relay address is confirmed too). */
  emailVerified: boolean;
  /** The nonce the app asked Apple to sign in, if any (auth/signin-nonce.ts). */
  nonce?: string;
}

export type AppleVerifier = (identityToken: string) => Promise<AppleIdentity>;

/** Verifies Apple identity tokens (iss appleid.apple.com, aud = our bundle id). */
export function appleVerifier(bundleIds: string[], jwks: string | { keys: JWK[] } = "https://appleid.apple.com/auth/keys"): AppleVerifier {
  const keys = typeof jwks === "string" ? createRemoteJWKSet(new URL(jwks)) : createLocalJWKSet(jwks);
  return async (identityToken) => {
    // A self-hosted server without the apps has no bundle id: nobody signs in with Apple.
    if (!bundleIds.length) throw new Error("Sign in with Apple isn't set up on this server (BRAIN_APPLE_AUDIENCES)");
    const { payload } = await jwtVerify(identityToken, keys, { issuer: "https://appleid.apple.com", audience: bundleIds, algorithms: ["RS256", "ES256"] });
    if (!payload.sub) throw new Error("apple token without sub");
    const email = typeof payload.email === "string" ? payload.email : undefined;
    // Apple sends these as booleans or as "true"/"false".
    const yes = (v: unknown) => v === true || v === "true";
    return { sub: payload.sub, email, emailVerified: yes(payload.email_verified), nonce: typeof payload.nonce === "string" ? payload.nonce : undefined };
  };
}
