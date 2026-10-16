// Sign in with Microsoft for the apps. The app signs in at Microsoft itself (authorization code
// with PKCE, in the system's web sheet) and sends us the ID token; we check it against
// Microsoft's published keys and hand out our own tokens, as for Sign in with Apple. Work and
// school accounts and personal Microsoft accounts alike ("common"): the issuer names the
// account's tenant, so it's checked against the token's own tenant id.
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWK } from "jose";

export interface MicrosoftIdentity {
  /** "tid:oid": one person in one directory. */
  id: string;
  email?: string;
  name?: string;
}

export type MicrosoftVerifier = (idToken: string, nonce?: string) => Promise<MicrosoftIdentity>;

const KEYS = "https://login.microsoftonline.com/common/discovery/v2.0/keys";

/** Checks Microsoft ID tokens issued to one of `clientIds` (the app's registration). */
export function microsoftVerifier(clientIds: string[], jwks: string | { keys: JWK[] } = KEYS): MicrosoftVerifier {
  const keys = typeof jwks === "string" ? createRemoteJWKSet(new URL(jwks)) : createLocalJWKSet(jwks);
  return async (idToken, nonce) => {
    const { payload } = await jwtVerify(idToken, keys, { audience: clientIds, algorithms: ["RS256"] });
    const tid = typeof payload.tid === "string" ? payload.tid : "";
    const oid = typeof payload.oid === "string" ? payload.oid : "";
    if (!tid || !oid) throw new Error("microsoft token without tid or oid");
    // Multi-tenant: the issuer must be the token's own tenant.
    if (payload.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) throw new Error("microsoft token from an unexpected issuer");
    if (nonce !== undefined && payload.nonce !== nonce) throw new Error("microsoft token nonce mismatch");
    const email = typeof payload.email === "string" && payload.email.includes("@") ? payload.email : undefined;
    const name = typeof payload.name === "string" ? payload.name : undefined;
    return { id: `${tid}:${oid}`, email, name };
  };
}
