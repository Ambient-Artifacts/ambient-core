// "Connect Microsoft 365" (product/sources.md): Ambient's own multi-tenant Microsoft app, so a
// company neither registers an app nor pastes a secret.
//
//   1. An admin approves Ambient's app for the company once (admin consent). Its only application
//      permission is Files.SelectedOperations.Selected, which on its own reaches nothing.
//   2. They sign in and paste the folder's link. Microsoft lets only someone who may manage a
//      folder give an app access to it, with the delegated Sites.FullControl.All: Ambient uses that
//      sign-in once, to give its own app write access to that one folder, and then drops it (no
//      refresh token is asked for or kept).
//   3. The team's server gets the connection, and from then on short-lived app-only tokens for
//      that company's tenant: the gateway holds the app's credential (a certificate, or a secret)
//      and pushes a fresh token every 20 minutes. The tenant is recorded in Convex, so a team
//      server can never ask for another company's token.
//
// Ambient's app is a confidential client registered on its own (not the apps' sign-in app, which
// is a public client): tokens with the admin's sign-in can only be redeemed here, with the
// credential. The state of a flow lives in memory for 15 minutes; one gateway process.
import { createHash, createPrivateKey, randomBytes, randomUUID, X509Certificate, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import express, { type Request, type Response, type Router } from "express";
import { decodeJwt, SignJWT } from "jose";
import { GraphError, MicrosoftGraph, staticToken, type DriveFolder } from "@brain/team";
import { api } from "@brain/control/api";
import type { Control } from "./control.ts";
import type { Team } from "./directory.ts";
import { errorPage, m365ConfirmPage, m365FolderPage } from "./oauth/pages.ts";
import type { TeamLink } from "./teams.ts";

const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const FLOW_MS = 15 * 60_000;
/** How often team servers get a fresh token (Microsoft's last about an hour). */
export const TOKEN_PUSH_MS = 20 * 60_000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MicrosoftConnectConfig {
  /** Ambient's Microsoft app (Application (client) ID). */
  clientId: string;
  /** Its certificate: the private key (PEM) and the certificate's SHA-1 thumbprint (x5t, base64url). */
  privateKey?: string;
  x5t?: string;
  /** Or a client secret (simpler, but it expires within two years). */
  secret?: string;
}

/**
 * BRAIN_MICROSOFT_CONNECT_CLIENT_ID plus BRAIN_MICROSOFT_CONNECT_CERT_FILE (a PEM file with the
 * private key and the certificate) or BRAIN_MICROSOFT_CONNECT_SECRET. Unset: no Connect button,
 * teams use their own Entra app.
 */
export function loadMicrosoftConnect(env: NodeJS.ProcessEnv = process.env): MicrosoftConnectConfig | undefined {
  const clientId = env.BRAIN_MICROSOFT_CONNECT_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  if (!GUID.test(clientId)) throw new Error("BRAIN_MICROSOFT_CONNECT_CLIENT_ID must be the app's Application (client) ID");
  const file = env.BRAIN_MICROSOFT_CONNECT_CERT_FILE?.trim();
  if (file) {
    const pem = readFileSync(file, "utf8");
    const key = /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/.exec(pem)?.[0];
    const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0];
    if (!key || !cert) throw new Error(`${file} needs the private key and the certificate (PEM)`);
    return { clientId, privateKey: key, x5t: createHash("sha1").update(new X509Certificate(cert).raw).digest("base64url") };
  }
  const secret = env.BRAIN_MICROSOFT_CONNECT_SECRET?.trim();
  if (secret) return { clientId, secret };
  throw new Error("BRAIN_MICROSOFT_CONNECT_CLIENT_ID needs BRAIN_MICROSOFT_CONNECT_CERT_FILE or BRAIN_MICROSOFT_CONNECT_SECRET");
}

export class MicrosoftConnectError extends Error {}

/** Ambient's Microsoft app talking to Microsoft: consent and sign-in addresses, tokens. */
export class MicrosoftConnector {
  private key: KeyObject | null = null;

  constructor(
    private cfg: MicrosoftConnectConfig,
    private fetchImpl: typeof fetch = fetch,
    readonly login = LOGIN,
    readonly graph = GRAPH,
  ) {}

  get clientId(): string {
    return this.cfg.clientId;
  }

  adminConsentUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ client_id: this.cfg.clientId, scope: "https://graph.microsoft.com/.default", redirect_uri: redirectUri, state });
    return `${this.login}/organizations/v2.0/adminconsent?${q}`;
  }

  authorizeUrl(tenant: string, state: string, redirectUri: string, challenge: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: "code",
      response_mode: "query",
      redirect_uri: redirectUri,
      scope: "openid profile https://graph.microsoft.com/User.Read https://graph.microsoft.com/Sites.FullControl.All",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return `${this.login}/${tenant}/oauth2/v2.0/authorize?${q}`;
  }

  /** The app proves itself: a signed assertion with its certificate, or its secret. */
  private async clientAuth(tenant: string): Promise<Record<string, string>> {
    if (this.cfg.secret) return { client_secret: this.cfg.secret };
    this.key ??= createPrivateKey(this.cfg.privateKey!);
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT", x5t: this.cfg.x5t! })
      .setIssuer(this.cfg.clientId)
      .setSubject(this.cfg.clientId)
      .setAudience(`${this.login}/${tenant}/oauth2/v2.0/token`)
      .setJti(randomUUID())
      .setNotBefore(now - 60)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(this.key);
    return { client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion };
  }

  private async token(tenant: string, params: Record<string, string>): Promise<{ access_token: string; expires_in?: number; id_token?: string }> {
    let res: globalThis.Response;
    try {
      res = await this.fetchImpl(`${this.login}/${tenant}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.cfg.clientId, ...(await this.clientAuth(tenant)), ...params }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new MicrosoftConnectError(`Microsoft sign-in unreachable: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; id_token?: string; error_description?: string };
    if (!res.ok || !json.access_token) throw new MicrosoftConnectError((json.error_description ?? `Microsoft answered ${res.status}`).split("\n")[0]!.slice(0, 300));
    return json as { access_token: string; expires_in?: number; id_token?: string };
  }

  /** App-only: what the team server writes with. */
  async appToken(tenant: string): Promise<{ access_token: string; expires_at: number }> {
    const t = await this.token(tenant, { grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" });
    return { access_token: t.access_token, expires_at: Date.now() + Math.max(300, t.expires_in ?? 3600) * 1000 };
  }

  /** The admin's sign-in, for picking the folder and giving the app access to it. */
  async redeem(tenant: string, code: string, verifier: string, redirectUri: string): Promise<{ accessToken: string; tenant: string; account: string }> {
    const t = await this.token(tenant, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
    // Straight from Microsoft's token endpoint over TLS, for this client: its claims can be taken
    // as they are (OpenID Connect Core 3.1.3.7).
    const claims = t.id_token ? decodeJwt(t.id_token) : {};
    const account = String(claims.preferred_username ?? claims.email ?? claims.name ?? "your account");
    return { accessToken: t.access_token, tenant: String(claims.tid ?? tenant), account };
  }
}

type Purpose = "transcripts" | "work";

interface Flow {
  uid: string;
  team: Team;
  requester: string;
  purpose: Purpose;
  verifier: string;
  tenant?: string;
  token?: string;
  account?: string;
  folder?: DriveFolder;
  expires: number;
}

export interface MicrosoftConnectDeps {
  origin: string;
  connector: MicrosoftConnector;
  control: Control;
  teams: TeamLink;
  fetchImpl?: typeof fetch;
  /** Tests: how long to wait between checks that Microsoft passed the new access on. */
  propagationDelayMs?: number;
}

/** The connect flow (browser pages under /connect/microsoft) and the token push. */
export class MicrosoftConnectFlow {
  private flows = new Map<string, Flow>();

  constructor(private d: MicrosoftConnectDeps) {}

  private get redirectUri(): string {
    return `${this.d.origin}/connect/microsoft/callback`;
  }

  /** A flow for an owner or admin of `team` (checked by the caller); the app opens the address. */
  start(o: { uid: string; team: Team; requester: string; purpose: Purpose }): string {
    const now = Date.now();
    for (const [id, f] of this.flows) if (f.expires < now) this.flows.delete(id);
    const id = randomBytes(32).toString("base64url");
    this.flows.set(id, { ...o, verifier: randomBytes(32).toString("base64url"), expires: now + FLOW_MS });
    return `${this.d.origin}/connect/microsoft?state=${id}`;
  }

  private flow(state: unknown): [string, Flow] | null {
    if (typeof state !== "string") return null;
    const f = this.flows.get(state);
    if (!f || f.expires < Date.now()) return null;
    return [state, f];
  }

  /** Back to the app (ASWebAuthenticationSession closes on the ambient:// address). */
  private backToApp(res: Response, slug: string, result: "connected" | "cancelled" | { error: string }): void {
    const q = typeof result === "string" ? `microsoft=${result}` : `microsoft=error&message=${encodeURIComponent(result.error.slice(0, 300))}`;
    res.redirect(303, `ambient://team-settings/${encodeURIComponent(slug)}?${q}`);
  }

  private delegated(f: Flow): MicrosoftGraph {
    return new MicrosoftGraph(staticToken(f.token!), this.d.fetchImpl ?? fetch, this.d.connector.graph);
  }

  router(): Router {
    const r = express.Router();
    const form = express.urlencoded({ extended: false, limit: "8kb" });
    const page = (res: Response, html: string, status = 200) => {
      res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'");
      res.set("Cache-Control", "no-store");
      res.status(status).type("html").send(html);
    };
    const expired = (res: Response) => page(res, errorPage({ title: "This link has expired", message: "Start again from Ambient: team settings → Transcripts and work logs." }), 400);

    r.get("/connect/microsoft", async (req, res) => {
      const found = this.flow(req.query.state);
      if (!found) return expired(res);
      const [state, f] = found;
      // A company that approved Ambient's app before goes straight to signing in.
      const tenant = await this.d.control.q(api.teams.microsoftTenant, { slug: f.team.slug });
      if (tenant) {
        f.tenant = tenant;
        res.redirect(this.d.connector.authorizeUrl(tenant, state, this.redirectUri, challenge(f.verifier)));
      } else {
        res.redirect(this.d.connector.adminConsentUrl(state, this.redirectUri));
      }
    });

    r.get("/connect/microsoft/callback", async (req, res) => {
      const found = this.flow(req.query.state);
      if (!found) return expired(res);
      const [state, f] = found;
      const q = req.query as Record<string, string | undefined>;
      if (q.error) {
        this.flows.delete(state);
        const declined = q.error === "access_denied" || q.error === "consent_required";
        return this.backToApp(res, f.team.slug, { error: declined ? "The approval for Ambient's Microsoft app was declined." : (q.error_description ?? q.error).split("\n")[0]! });
      }
      if (q.admin_consent !== undefined) {
        if (q.admin_consent.toLowerCase() !== "true" || !q.tenant || !GUID.test(q.tenant)) {
          this.flows.delete(state);
          return this.backToApp(res, f.team.slug, { error: "Microsoft didn't confirm the approval." });
        }
        f.tenant = q.tenant.toLowerCase();
        return res.redirect(this.d.connector.authorizeUrl(f.tenant, state, this.redirectUri, challenge(f.verifier)));
      }
      if (!q.code || !f.tenant) return expired(res);
      try {
        const signedIn = await this.d.connector.redeem(f.tenant, q.code, f.verifier, this.redirectUri);
        if (signedIn.tenant.toLowerCase() !== f.tenant) throw new MicrosoftConnectError("You signed in with an account of another company. Sign in with an account of the company that approved Ambient.");
        f.token = signedIn.accessToken;
        f.account = signedIn.account;
      } catch (err) {
        this.flows.delete(state);
        return this.backToApp(res, f.team.slug, { error: (err as Error).message });
      }
      page(res, m365FolderPage({ state, team: f.team.name, account: f.account, purpose: f.purpose }));
    });

    r.post("/connect/microsoft/folder", form, async (req, res) => {
      const found = this.flow(req.body?.state);
      if (!found || !found[1].token) return expired(res);
      const [state, f] = found;
      const link = String(req.body?.link ?? "").trim().slice(0, 2000);
      try {
        f.folder = await this.delegated(f).resolveFolder(link);
      } catch (err) {
        const message = err instanceof GraphError ? err.message : "That folder couldn't be opened.";
        return page(res, m365FolderPage({ state, team: f.team.name, account: f.account!, purpose: f.purpose, error: message, link }), 400);
      }
      page(res, m365ConfirmPage({ state, team: f.team.name, requester: f.requester, folder: f.folder.label || f.folder.folder_id, purpose: f.purpose }));
    });

    r.post("/connect/microsoft/cancel", form, (req, res) => {
      const found = this.flow(req.body?.state);
      if (!found) return expired(res);
      this.flows.delete(found[0]);
      this.backToApp(res, found[1].team.slug, "cancelled");
    });

    r.post("/connect/microsoft/grant", form, async (req, res) => {
      const found = this.flow(req.body?.state);
      if (!found || !found[1].token || !found[1].folder || !found[1].tenant) return expired(res);
      const [state, f] = found;
      const folder = f.folder!;
      const tenant = f.tenant!;
      const retry = (message: string) =>
        page(res, m365FolderPage({ state, team: f.team.name, account: f.account!, purpose: f.purpose, error: message }), 400);
      // 1. Ambient's app may write to this folder (the admin's sign-in, used this once).
      try {
        await this.delegated(f).request("POST", `/drives/${encodeURIComponent(folder.drive_id)}/items/${encodeURIComponent(folder.folder_id)}/permissions`, {
          body: JSON.stringify({ roles: ["write"], grantedToV2: { application: { id: this.d.connector.clientId } } }),
          contentType: "application/json",
        });
      } catch (err) {
        if (err instanceof GraphError && (err.status === 401 || err.status === 403)) {
          return retry("Your account can't give apps access to this folder. Sign in as an admin of that OneDrive or SharePoint site (for a person's OneDrive: Microsoft 365 admin center → Users → the owner → OneDrive → Get access to files).");
        }
        if (!(err instanceof GraphError && err.status === 409)) return retry(err instanceof Error ? err.message : "Microsoft refused.");
      }
      // 2. The company's name, for the settings screen (the sign-in may read it).
      const tenantName = await this.delegated(f)
        .request("GET", "/organization?$select=displayName")
        .then(async (r) => String(((await r.json()) as { value?: { displayName?: string }[] }).value?.[0]?.displayName ?? ""))
        .catch(() => "");
      // 3. The app's own token for this company, to the team's server. Fails when the approval
      //    is missing (taken back since): then nothing is recorded.
      let token: { access_token: string; expires_at: number };
      try {
        token = await this.d.connector.appToken(tenant);
      } catch (err) {
        await this.d.control.m(api.teams.setMicrosoftTenant, { slug: f.team.slug, tenantId: null });
        this.flows.delete(state);
        return this.backToApp(res, f.team.slug, { error: `Ambient's Microsoft app isn't approved for your company (${(err as Error).message}). Connect again to approve it.` });
      }
      try {
        await this.d.teams.pushGraphToken(f.team, { tenant_id: tenant, ...token });
      } catch {
        this.flows.delete(state);
        return this.backToApp(res, f.team.slug, { error: "The team's server didn't answer. Try again in a minute." });
      }
      await this.d.control.m(api.teams.setMicrosoftTenant, { slug: f.team.slug, tenantId: tenant });
      // 4. The team's settings. The server checks it can see the folder with the app's token;
      //    Microsoft can take a little while to pass the new access on.
      const body = { microsoft: { kind: "ambient", tenant_id: tenant, tenant_name: tenantName }, [f.purpose]: { kind: "drive", drive_id: folder.drive_id, folder_id: folder.folder_id } };
      let last = "";
      for (let attempt = 0; attempt < 7; attempt++) {
        if (attempt) await new Promise((ok) => setTimeout(ok, this.d.propagationDelayMs ?? 5_000));
        const out = await this.d.teams.settings(f.team, f.uid, "PUT", body).catch(() => ({ status: 503, json: { message: "The team's server didn't answer." } }));
        if (out.status === 200) {
          this.flows.delete(state);
          return this.backToApp(res, f.team.slug, "connected");
        }
        last = String((out.json as { message?: unknown })?.message ?? `HTTP ${out.status}`);
        if (out.status !== 400) break;
      }
      this.flows.delete(state);
      this.backToApp(res, f.team.slug, { error: `Microsoft hasn't passed the access on yet (${last}). Try again in a minute.` });
    });
    return r;
  }

  /** A fresh token to every team connected with Ambient's app (every TOKEN_PUSH_MS). */
  async pushTokens(): Promise<{ slug: string; ok: boolean; error?: string }[]> {
    const teams = (await this.d.control.q(api.teams.active, {})) as { id: string; slug: string; name: string; serverUrl: string; microsoftTenantId: string | null }[];
    const out: { slug: string; ok: boolean; error?: string }[] = [];
    for (const t of teams) {
      if (!t.microsoftTenantId) continue;
      try {
        const token = await this.d.connector.appToken(t.microsoftTenantId);
        await this.d.teams.pushGraphToken({ id: String(t.id), slug: t.slug, serverUrl: t.serverUrl }, { tenant_id: t.microsoftTenantId, ...token });
        out.push({ slug: t.slug, ok: true });
      } catch (err) {
        out.push({ slug: t.slug, ok: false, error: (err as Error).message });
      }
    }
    return out;
  }
}

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
