import { readFileSync } from "node:fs";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import type { GitHubAppConfig } from "./bots/github-app.ts";
import type { AppleRevokeConfig } from "./auth/apple-revoke.ts";
import { parseMasterKey, type MasterKey } from "./crypto.ts";
import { loadMicrosoftConnect, type MicrosoftConnectConfig } from "./microsoft-connect.ts";
import type { ApnsConfig } from "./push.ts";
import { parseMsTeamsBots, type MsTeamsBotConfig } from "./msteams/config.ts";

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
  /** Sign in with Google: the apps' OAuth client ids in Google Cloud (the first is the one the apps use). */
  googleClientIds?: string[];
  /**
   * "Connect Microsoft 365": Ambient's own multi-tenant Microsoft app (a confidential client of
   * its own, not the apps' sign-in app) and its credential. Optional: without it, teams connect
   * their own Entra app.
   */
  microsoftConnect?: MicrosoftConnectConfig;
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
  /**
   * Refuse Apple, Microsoft and Google sign-ins whose ID token doesn't carry a nonce this server issued
   * (auth/signin-nonce.ts). Off until every app in use sends one (set BRAIN_MIN_APP_VERSION to
   * the first that does); until then a token without a nonce is still taken.
   */
  requireSignInNonce?: boolean;
  /** Teams' bots in Microsoft Teams (msteams/), from BRAIN_MSTEAMS_BOTS. None: /teams/messages answers 401. */
  msteamsBots?: MsTeamsBotConfig[];
  /**
   * Who has bots and the chat with Ambient (docs/bots.md), from BRAIN_BOTS: accounts by id and
   * teams by slug. Absent: nobody; loops stay as they are.
   */
  bots?: BotsAccess;
  /** The model Ambient's chat answers with (BRAIN_AMBIENT_MODEL). */
  ambientModel?: string;
  /**
   * Ambient's GitHub App (docs/bots.md, "Connect GitHub"): BRAIN_GITHUB_APP_ID, _SLUG, _KEY_FILE,
   * _WEBHOOK_SECRET. Absent: Connect GitHub answers `app: null`, owners' own webhooks still work.
   */
  githubApp?: GitHubAppConfig;
}

export interface BotsAccess {
  users: string[];
  teams: string[];
}

/** BRAIN_BOTS: "user:<account id>,team:<slug>,…"; "all" for everyone (a self-hosted server). */
export function parseBotsAccess(raw: string | undefined): BotsAccess | undefined {
  const items = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) return undefined;
  const out: BotsAccess = { users: [], teams: [] };
  for (const item of items) {
    if (item === "all") {
      out.users.push("*");
      out.teams.push("*");
      continue;
    }
    const m = /^(user|team):([A-Za-z0-9_-]+)$/.exec(item);
    if (!m) throw new Error(`BRAIN_BOTS: "${item}" isn't user:<account id>, team:<slug> or all`);
    (m[1] === "user" ? out.users : out.teams).push(m[2]!);
  }
  return out;
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
    googleClientIds: env.BRAIN_GOOGLE_CLIENT_IDS?.split(",").map((s) => s.trim()).filter(Boolean),
    microsoftConnect: loadMicrosoftConnect(env),
    adminCodes: env.BRAIN_ADMIN_CODES === "true",
    signups: parseSignups(env.BRAIN_SIGNUPS),
    requireSignInNonce: env.BRAIN_SIGNIN_NONCE === "required",
    msteamsBots: parseMsTeamsBots(env.BRAIN_MSTEAMS_BOTS),
    bots: parseBotsAccess(env.BRAIN_BOTS),
    ambientModel: env.BRAIN_AMBIENT_MODEL || undefined,
    githubApp: loadGitHubApp(env),
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

/** Ambient's GitHub App, when all four settings are there (a half-set App is a mistake: said at start). */
export function loadGitHubApp(env: Record<string, string | undefined>): GitHubAppConfig | undefined {
  const { BRAIN_GITHUB_APP_ID: appId, BRAIN_GITHUB_APP_SLUG: slug, BRAIN_GITHUB_APP_KEY_FILE: keyFile, BRAIN_GITHUB_APP_WEBHOOK_SECRET: webhookSecret } = env;
  const given = [appId, slug, keyFile, webhookSecret].filter(Boolean).length;
  if (given === 0) return undefined;
  if (given < 4) throw new Error("The GitHub App needs BRAIN_GITHUB_APP_ID, BRAIN_GITHUB_APP_SLUG, BRAIN_GITHUB_APP_KEY_FILE and BRAIN_GITHUB_APP_WEBHOOK_SECRET together.");
  return { appId: appId!, slug: slug!, privateKey: readFileSync(keyFile!, "utf8"), webhookSecret: webhookSecret! };
}
