// Revoking a user's Sign in with Apple token when they delete their account (App Store
// guideline 5.1.1(v)). The app signs in with Apple once more right before deleting and sends
// the fresh authorization code; we trade it for a token at Apple and revoke that, which removes
// Ambient from the user's "Sign in with Apple" list. Needs a Sign in with Apple key (.p8) from
// the Apple Developer account; without one configured, deletion still goes ahead and only the
// revocation is skipped.
import { importPKCS8, SignJWT } from "jose";

export interface AppleRevokeConfig {
  teamId: string;
  keyId: string;
  /** The .p8 key's PEM text. */
  privateKey: string;
  /** The app's bundle id (the client id the code was issued to). */
  clientId: string;
}

export type AppleRevokeOutcome = "revoked" | "skipped" | "failed";
export type AppleRevoker = (authorizationCode: string | undefined) => Promise<AppleRevokeOutcome>;

const APPLE = "https://appleid.apple.com";

export function appleRevoker(config: AppleRevokeConfig | undefined, fetchImpl: typeof fetch = fetch): AppleRevoker {
  if (!config) return async () => "skipped";
  const key = importPKCS8(config.privateKey, "ES256");
  const clientSecret = async () =>
    new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: config.keyId })
      .setIssuer(config.teamId)
      .setIssuedAt()
      .setExpirationTime("5m")
      .setAudience(APPLE)
      .setSubject(config.clientId)
      .sign(await key);
  const post = (path: string, form: Record<string, string>) =>
    fetchImpl(`${APPLE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });

  return async (authorizationCode) => {
    if (!authorizationCode) return "skipped";
    try {
      const secret = await clientSecret();
      const exchanged = await post("/auth/token", { client_id: config.clientId, client_secret: secret, code: authorizationCode, grant_type: "authorization_code" });
      if (!exchanged.ok) throw new Error(`token exchange ${exchanged.status}`);
      const tokens = (await exchanged.json()) as { refresh_token?: string; access_token?: string };
      const token = tokens.refresh_token ?? tokens.access_token;
      if (!token) throw new Error("no token in Apple's answer");
      const revoked = await post("/auth/revoke", {
        client_id: config.clientId,
        client_secret: secret,
        token,
        token_type_hint: tokens.refresh_token ? "refresh_token" : "access_token",
      });
      if (!revoked.ok) throw new Error(`revoke ${revoked.status}`);
      return "revoked";
    } catch (err) {
      // The reason only, never the code or a token.
      console.warn(`[gateway] apple token revocation failed: ${(err as Error).message}`);
      return "failed";
    }
  };
}
