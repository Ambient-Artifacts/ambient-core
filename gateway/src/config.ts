import { exportJWK, generateKeyPair, type JWK } from "jose";
import type { AppleRevokeConfig } from "./auth/apple-revoke.ts";
import { parseMasterKey, type MasterKey } from "./crypto.ts";
import type { ApnsConfig } from "./push.ts";

export interface GatewayConfig {
  /** Public origin without trailing slash, e.g. https://mcp.example.com. Also the token issuer. */
  origin: string;
  /** Secrets for signing oidc-provider cookies. Rotate by prepending. */
  cookieKeys: string[];
  /** Private ES256 signing keys; the first one signs. Public halves are served at /oauth/jwks. */
  signingKeys: JWK[];
  /** Seconds an OAuth access token lives. */
  accessTokenTtl: number;
  /** Wraps every user's data key. Never leaves the core servers. */
  masterKey: MasterKey;
  /** Convex deployment URL and the shared secret its functions check. */
  convexUrl: string;
  serviceSecret: string;
  /** Bundle ids accepted as the audience of Sign in with Apple tokens. None: no Apple sign-in. */
  appleAudiences: string[];
  /** Directory cache in ms (membership changes take effect within this). */
  directoryTtlMs: number;
  /**
   * Which proxies' X-Forwarded-For to believe (Express "trust proxy"): the sign-in limits count
   * per client address. "loopback" behind Caddy on the same machine; in Docker, the network's.
   */
  trustProxy?: string;
  /** Tests only: allow file:// repos (local bare repos). */
  allowFileRepos?: boolean;
  /** Sign in with Apple key, to revoke a deleted account's Apple token. Optional. */
  appleRevoke?: AppleRevokeConfig;
  /** Older app versions are asked to update before they continue (e.g. "0.2.0"). */
  minAppVersion?: string;
  /** Where that update is (App Store or TestFlight link). */
  appUpdateUrl?: string;
  /** APNs key, for push notifications to the apps. Optional: without one nothing is sent. */
  apns?: ApnsConfig;
  /**
   * Sign in with Microsoft: the apps' app registration ids in Microsoft Entra (the first is
   * the one the apps use). Optional: without one the apps show only Sign in with Apple.
   */
  microsoftClientIds?: string[];
  /**
   * A self-hosted server whose admin hands out AI-app sign-in codes (`admin connect-code`): the
   * sign-in page mentions it next to the app's codes.
   */
  adminCodes?: boolean;
  /**
   * Who may make a new account by signing in from the apps. Absent: anyone (Ambient Cloud). A
   * self-hosted server lists exact emails and "@domain" entries (none: only people its admin
   * added with `admin user add`, matched by the email Apple confirms).
   */
  signups?: { allow: string[] };
}

export async function generateSigningKey(): Promise<JWK> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  return { ...jwk, alg: "ES256", use: "sig", kid: `es256-${Date.now().toString(36)}` };
}

function need(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is required`);
  return v;
}

/** BRAIN_SIGNUPS: unset or "open" for anyone, "none" for only the admin's people, or a list of emails and domains. */
export function parseSignups(raw: string | undefined): { allow: string[] } | undefined {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "open") return undefined;
  if (value === "none") return { allow: [] };
  const allow = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.includes("@") ? s : `@${s}`));
  return { allow };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const origin = need(env, "BRAIN_ORIGIN").replace(/\/+$/, "");
  const signingKeys = (JSON.parse(need(env, "BRAIN_SIGNING_JWKS")) as { keys: JWK[] }).keys;
  if (!signingKeys.length || !signingKeys[0]!.d) throw new Error("BRAIN_SIGNING_JWKS needs at least one private ES256 key");
  const serviceSecret = need(env, "BRAIN_SERVICE_SECRET");
  if (serviceSecret.length < 32) throw new Error("BRAIN_SERVICE_SECRET must be at least 32 characters");
  return {
    origin,
    cookieKeys: need(env, "BRAIN_COOKIE_KEYS").split(",").filter(Boolean),
    signingKeys,
    accessTokenTtl: Number(env.BRAIN_ACCESS_TOKEN_TTL ?? 3600),
    masterKey: parseMasterKey(env.BRAIN_MASTER_KEY_ID ?? "mk1", need(env, "BRAIN_MASTER_KEY")),
    convexUrl: need(env, "CONVEX_URL"),
    serviceSecret,
    // "none" turns it off where a default would set it (docker-compose.yml).
    appleAudiences: (env.BRAIN_APPLE_AUDIENCES ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "none"),
    directoryTtlMs: Number(env.BRAIN_DIRECTORY_TTL_MS ?? 60_000),
    trustProxy: env.BRAIN_TRUST_PROXY || "loopback",
    appleRevoke:
      env.BRAIN_APPLE_TEAM_ID && env.BRAIN_APPLE_KEY_ID && env.BRAIN_APPLE_PRIVATE_KEY
        ? {
            teamId: env.BRAIN_APPLE_TEAM_ID,
            keyId: env.BRAIN_APPLE_KEY_ID,
            privateKey: env.BRAIN_APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
            clientId: env.BRAIN_APPLE_CLIENT_ID ?? need(env, "BRAIN_APPLE_AUDIENCES").split(",")[0]!,
          }
        : undefined,
    minAppVersion: env.BRAIN_MIN_APP_VERSION || undefined,
    appUpdateUrl: env.BRAIN_APP_UPDATE_URL || undefined,
    microsoftClientIds: env.BRAIN_MICROSOFT_CLIENT_IDS?.split(",").map((s) => s.trim()).filter(Boolean),
    adminCodes: env.BRAIN_ADMIN_CODES === "true",
    signups: parseSignups(env.BRAIN_SIGNUPS),
    apns:
      env.BRAIN_APNS_KEY_ID && env.BRAIN_APNS_PRIVATE_KEY
        ? {
            teamId: env.BRAIN_APNS_TEAM_ID || need(env, "BRAIN_APPLE_TEAM_ID"),
            keyId: env.BRAIN_APNS_KEY_ID,
            privateKey: env.BRAIN_APNS_PRIVATE_KEY.replace(/\\n/g, "\n"),
            topic: env.BRAIN_APNS_TOPIC || need(env, "BRAIN_APPLE_AUDIENCES").split(",")[0]!,
          }
        : undefined,
  };
}
