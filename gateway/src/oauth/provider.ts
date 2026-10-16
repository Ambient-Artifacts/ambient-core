// Our OAuth 2.1 authorization server, for MCP clients (Claude, ChatGPT, Codex,
// M365 Copilot) and for our own iPhone and Mac apps. oidc-provider handles the
// protocol and every token; we configure:
// - open dynamic client registration (MCP clients self-register),
// - one fixed client for the apps (APP_CLIENT_ID), which signs in with Apple or
//   Microsoft on our sign-in step (interactions.ts) instead of a pairing code,
// - PKCE S256 on every authorization code flow,
// - resource indicators (RFC 8707): each access token is a JWT bound to one
//   resource: /mcp or /t/<slug>/mcp for MCP clients, /v1/app for the apps only,
// - DPoP (RFC 9449) for the apps: their tokens only work with the key the app
//   holds, so their refresh token can stay the same (a lost answer can't sign
//   anyone out); every other refresh token changes on every use, and reusing an
//   old one ends the grant.
import Provider, { errors, type Configuration, type ErrorOut, type KoaContextWithOIDC } from "oidc-provider";
import type { GatewayConfig } from "../config.ts";
import type { Directory } from "../directory.ts";
import type { Control } from "../control.ts";
import { convexAdapterFactory } from "./adapter.ts";
import { MCP_SCOPES, TEAM_MCP_SCOPES } from "../mcp/route.ts";
import { errorPage } from "./pages.ts";

export const SUPPORTED_SCOPES = ["openid", "offline_access", "personal:read", "personal:write", "team:read", "team:write", "team:review"];

/** The iPhone and Mac apps: a public client that only ever gets the app API (appResource). */
export const APP_CLIENT_ID = "ambient-app";
/** Never opened: the app reads the code off this redirect itself (no browser in between). */
export const APP_REDIRECT_URI = "si.ambientartifacts.brain:/signed-in";
/** An app sign-in lasts this long, then the app asks to sign in again (its data stays). */
const APP_SESSION_S = 180 * 24 * 3600;
const APP_ACCESS_TOKEN_S = 3600;

/** The app API's resource indicator, and the audience of the apps' access tokens. */
export const appResource = (origin: string) => `${origin}/v1/app`;

const isApp = (client: { clientId: string } | undefined) => client?.clientId === APP_CLIENT_ID;

/** Parse a resource indicator into the MCP resource it names, or null if it isn't ours. */
export function parseResource(origin: string, resource: string): { path: string; teamSlug: string | null } | null {
  if (resource === `${origin}/mcp`) return { path: "/mcp", teamSlug: null };
  const m = new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/t/([a-z0-9-]{1,40})/mcp$`).exec(resource);
  return m ? { path: `/t/${m[1]}/mcp`, teamSlug: m[1]! } : null;
}

export function createProvider(cfg: GatewayConfig, directory: Directory, control: Control): Provider {
  const configuration: Configuration = {
    adapter: convexAdapterFactory(control),
    clients: [
      {
        client_id: APP_CLIENT_ID,
        client_name: "Ambient",
        application_type: "native",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: [APP_REDIRECT_URI],
        dpop_bound_access_tokens: true,
      },
    ],
    clientDefaults: {
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      id_token_signed_response_alg: "ES256",
    },
    cookies: {
      keys: cfg.cookieKeys,
      long: { sameSite: "lax" },
      short: { sameSite: "lax" },
    },
    jwks: { keys: cfg.signingKeys as never },
    scopes: SUPPORTED_SCOPES,
    claims: { openid: ["sub"], email: ["email"], profile: ["name"] },
    features: {
      devInteractions: { enabled: false },
      dPoP: { enabled: true },
      registration: { enabled: true },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        // Clients that omit `resource` (older MCP clients) get the personal /mcp resource.
        defaultResource: async (_ctx, client, oneOf) => oneOf ?? (isApp(client) ? appResource(cfg.origin) : `${cfg.origin}/mcp`),
        useGrantedResource: async () => true,
        getResourceServerInfo: async (_ctx, resourceIndicator, client) => {
          // The app API only for the apps, and nothing else for them.
          if (resourceIndicator === appResource(cfg.origin)) {
            if (!isApp(client)) throw new errors.InvalidTarget();
            return {
              scope: "app",
              audience: resourceIndicator,
              accessTokenTTL: APP_ACCESS_TOKEN_S,
              accessTokenFormat: "jwt",
              jwt: { sign: { alg: "ES256" } },
            };
          }
          if (isApp(client)) throw new errors.InvalidTarget();
          const r = parseResource(cfg.origin, resourceIndicator);
          if (!r) throw new errors.InvalidTarget();
          return {
            scope: (r.teamSlug ? TEAM_MCP_SCOPES : MCP_SCOPES).join(" "),
            audience: resourceIndicator,
            accessTokenTTL: cfg.accessTokenTtl,
            accessTokenFormat: "jwt",
            jwt: { sign: { alg: "ES256" } },
          };
        },
      },
    },
    pkce: { required: () => true },
    findAccount: async (_ctx, sub) => {
      const user = await directory.user(sub);
      if (!user) return undefined;
      return { accountId: sub, claims: async () => ({ sub, email: user.email ?? undefined, name: user.name }) };
    },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    // The apps' tokens outlive the browser-less sign-in's session (which nobody keeps).
    expiresWithSession: async (ctx, source) => !isApp(ctx.oidc.client) && !source.scopes.has("offline_access"),
    // A DPoP-bound refresh token (the apps') is useless without the device's key, so it isn't
    // replaced; every other one is replaced on each use and a reused one ends its grant.
    rotateRefreshToken: (ctx) => !ctx.oidc.entities.RefreshToken?.isSenderConstrained(),
    ttl: {
      AccessToken: cfg.accessTokenTtl,
      AuthorizationCode: 120,
      Grant: (_ctx, grant) => (grant.clientId === APP_CLIENT_ID ? APP_SESSION_S : 180 * 24 * 3600),
      IdToken: 3600,
      Interaction: 3600,
      RefreshToken: (_ctx, _token, client) => (isApp(client) ? APP_SESSION_S : 30 * 24 * 3600),
      Session: 30 * 24 * 3600,
    },
    routes: {
      authorization: "/oauth/authorize",
      token: "/oauth/token",
      registration: "/oauth/register",
      jwks: "/oauth/jwks",
      revocation: "/oauth/revoke",
      userinfo: "/oauth/userinfo",
      end_session: "/oauth/logout",
      pushed_authorization_request: "/oauth/par",
    },
    renderError: async (ctx: KoaContextWithOIDC, out: ErrorOut) => {
      ctx.type = "html";
      // The human-readable description when there is one ("too many wrong codes"), not the protocol code.
      const reason = String(out.error_description || out.error || "Something went wrong.");
      ctx.body = errorPage({ title: "Sign-in failed", message: reason.charAt(0).toUpperCase() + reason.slice(1) + (/[.!?]$/.test(reason) ? "" : ".") });
    },
  };

  const provider = new Provider(cfg.origin, configuration);
  // Caddy terminates TLS in front of us.
  provider.proxy = true;
  return provider;
}
