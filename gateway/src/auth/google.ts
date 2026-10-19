// Sign in with Google for the apps, the same way as Microsoft (microsoft.ts): the app signs in at
// Google itself (authorization code with PKCE, in the system's web sheet), redeems the code (an
// iOS client has no secret) and sends us the ID token; we check it against Google's published
// keys and hand out our own tokens.
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWK } from "jose";

export interface GoogleIdentity {
  /** Google's account id ("sub"): stable, never reused for another account. */
  id: string;
  email?: string;
  /**
   * Google vouches for the email: verified, and a Gmail address or one in the Google Workspace
   * domain the account belongs to ("hd"). A Google account can be made with any email, verified
   * once, so only then can the email stand for the person (allow lists, admin-added accounts).
   */
  emailTrusted: boolean;
  name?: string;
  /** The token's nonce, if any (auth/signin-nonce.ts). */
  nonce?: string;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

const KEYS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** Checks Google ID tokens issued to one of `clientIds` (the apps' OAuth clients). */
export function googleVerifier(clientIds: string[], jwks: string | { keys: JWK[] } = KEYS): GoogleVerifier {
  const keys = typeof jwks === "string" ? createRemoteJWKSet(new URL(jwks)) : createLocalJWKSet(jwks);
  return async (idToken) => {
    const { payload } = await jwtVerify(idToken, keys, { audience: clientIds, issuer: ISSUERS, algorithms: ["RS256"] });
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!/^[0-9]{1,64}$/.test(sub)) throw new Error("google token without a valid sub");
    const email = typeof payload.email === "string" && payload.email.includes("@") ? payload.email : undefined;
    const verified = payload.email_verified === true || payload.email_verified === "true";
    const domain = email?.split("@").pop()?.toLowerCase();
    const hd = typeof payload.hd === "string" ? payload.hd.toLowerCase() : undefined;
    return {
      id: sub,
      email,
      emailTrusted: !!email && verified && (domain === "gmail.com" || (hd !== undefined && domain === hd)),
      name: typeof payload.name === "string" ? payload.name : undefined,
      nonce: typeof payload.nonce === "string" ? payload.nonce : undefined,
    };
  };
}
