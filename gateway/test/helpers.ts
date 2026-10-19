/// <reference types="vite/client" />
// Test harness: the real gateway, backed by the real Convex functions (via
// convex-test), plus a real team server with the fixture team wiki, plus a
// fake "Apple" that signs identity tokens with a local key.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { convexTest } from "convex-test";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { api, internal } from "@brain/control/api";
import schema from "../../control/convex/schema.js";
import { Deliverer, graphFor, GraphTokens, TeamRemote, TeamSettingsStore, TranscriptOutbox, createTeamApp, createUnclaimedApp, TeamWiki, type MicrosoftGraph } from "@brain/team";
import type { MicrosoftConnector } from "../src/microsoft-connect.ts";
import type { MicrosoftConnection } from "@brain/spec";
import { createApp } from "../src/app.ts";
import { appleVerifier } from "../src/auth/apple.ts";
import { googleVerifier } from "../src/auth/google.ts";
import { microsoftVerifier } from "../src/auth/microsoft.ts";
import { publicJwks } from "../src/auth/bearer.ts";
import { generateSigningKey, type GatewayConfig } from "../src/config.ts";
import { APP_CLIENT_ID, APP_REDIRECT_URI } from "../src/oauth/provider.ts";
import { parseMasterKey } from "../src/crypto.ts";
import type { PushSender } from "../src/push.ts";

export const FIXTURES = join(import.meta.dirname, "..", "..", "spec", "fixtures");
export const BUNDLE_ID = "com.example.brain";
export const INVITE = "ACME-2026";
export const MICROSOFT_CLIENT = "00000000-0000-0000-0000-00000000abcd";
export const GOOGLE_CLIENT = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const modules = import.meta.glob("../../control/convex/**/*.ts");

function listen(server: Server): Promise<string> {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

export async function startStack(
  opts: {
    revisionPollMs?: number;
    streamMaxMs?: number;
    push?: PushSender;
    signups?: { allow: string[] };
    requireSignInNonce?: boolean;
    /** Ambient's Microsoft app against a fake Microsoft; `microsoftFetch` also serves the team server's Graph calls. */
    microsoftConnect?: { connector: MicrosoftConnector; propagationDelayMs?: number };
    microsoftFetch?: typeof fetch;
  } = {},
) {
  const serviceSecret = randomBytes(24).toString("hex");
  process.env.BRAIN_SERVICE_SECRET = serviceSecret;
  const t = convexTest(schema, modules);

  // Fake Apple.
  const apple = await generateKeyPair("ES256", { extractable: true });
  const appleJwk = { ...(await exportJWK(apple.publicKey)), kid: "apple1", alg: "ES256", use: "sig" };
  const appleToken = (sub: string, email?: string, claims: Record<string, unknown> = {}) =>
    new SignJWT({ ...(email ? { email } : {}), ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "apple1" })
      .setIssuer("https://appleid.apple.com")
      .setAudience(BUNDLE_ID)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(apple.privateKey);

  // Fake Microsoft: RS256 ID tokens for one app registration, any tenant.
  const microsoft = await generateKeyPair("RS256", { extractable: true });
  const microsoftJwk = { ...(await exportJWK(microsoft.publicKey)), kid: "ms1", alg: "RS256", use: "sig" };
  const microsoftToken = (tid: string, oid: string, claims: Record<string, unknown> = {}, opts: { aud?: string; iss?: string } = {}) =>
    new SignJWT({ tid, oid, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "ms1" })
      .setIssuer(opts.iss ?? `https://login.microsoftonline.com/${tid}/v2.0`)
      .setAudience(opts.aud ?? MICROSOFT_CLIENT)
      .setSubject(`sub-${oid}`)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(microsoft.privateKey);

  // Fake Google: RS256 ID tokens for the apps' OAuth client.
  const google = await generateKeyPair("RS256", { extractable: true });
  const googleJwk = { ...(await exportJWK(google.publicKey)), kid: "g1", alg: "RS256", use: "sig" };
  const googleToken = (sub: string, claims: Record<string, unknown> = {}, opts: { aud?: string; iss?: string } = {}) =>
    new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "g1" })
      .setIssuer(opts.iss ?? "https://accounts.google.com")
      .setAudience(opts.aud ?? GOOGLE_CLIENT)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(google.privateKey);

  // Gateway (listen first: the origin is part of the config).
  const gatewayServer = createServer();
  const origin = await listen(gatewayServer);
  const signingKey = await generateSigningKey();
  const config: GatewayConfig = {
    origin,
    cookieKeys: [randomBytes(16).toString("hex")],
    signingKeys: [signingKey],
    accessTokenTtl: 3600,
    masterKey: parseMasterKey("mk-test", randomBytes(32).toString("base64")),
    convexUrl: "convex-test",
    serviceSecret,
    appleAudiences: [BUNDLE_ID],
    microsoftClientIds: [MICROSOFT_CLIENT],
    googleClientIds: [GOOGLE_CLIENT],
    directoryTtlMs: 0,
    allowFileRepos: true,
    signups: opts.signups,
    requireSignInNonce: opts.requireSignInNonce,
  };

  // Team server with a copy of the fixture team wiki.
  const dataDir = mkdtempSync(join(tmpdir(), "brain-gw-team-"));
  cpSync(join(FIXTURES, "wiki-team"), join(dataDir, "wiki"), { recursive: true });
  const teamId = await t.mutation(internal.teams.create, { slug: "acme", name: "Acme" });
  const wiki = await TeamWiki.open(join(dataDir, "wiki"), String(teamId), "Acme", new TeamRemote(join(dataDir, "remote.json"), join(dataDir, "wiki"), { allowFile: true }));
  const settings = new TeamSettingsStore(join(dataDir, "settings.json"));
  const graphTokens = new GraphTokens();
  const makeGraph = (conn: MicrosoftConnection): MicrosoftGraph => graphFor(conn, graphTokens, opts.microsoftFetch ?? fetch);
  const deliverer = new Deliverer(new TranscriptOutbox(join(dataDir, "outbox")), settings, wiki, makeGraph);
  const teamServer = createServer(
    createTeamApp(wiki, { teamId: String(teamId), gatewayIssuer: origin, gatewayJwks: publicJwks([signingKey]), rawDir: join(dataDir, "raw"), version: "test", settings, deliverer, graphTokens, graphFor: makeGraph }),
  );
  const teamUrl = await listen(teamServer);
  await t.mutation(internal.teams.setServerUrl, { slug: "acme", serverUrl: teamUrl });
  await t.mutation(internal.teams.createInvite, { slug: "acme", codeHash: createHash("sha256").update(`invite:${INVITE}`).digest("hex") });

  // A free server in the pool: claimed by the first team created in the app, then (like
  // systemd restarting it) it serves that team.
  const poolDir = mkdtempSync(join(tmpdir(), "brain-gw-pool-"));
  const poolServer = createServer();
  let poolApp: RequestListener = createUnclaimedApp({
    serverId: "pool-1",
    dataDir: poolDir,
    gatewayIssuer: origin,
    gatewayJwks: publicJwks([signingKey]),
    version: "test",
    onClaimed: async (team) => {
      const claimedWiki = await TeamWiki.open(join(poolDir, "wiki"), team.teamId, team.teamName);
      poolApp = createTeamApp(claimedWiki, { teamId: team.teamId, gatewayIssuer: origin, gatewayJwks: publicJwks([signingKey]), rawDir: join(poolDir, "raw"), version: "test" });
    },
  });
  poolServer.on("request", (req, res) => poolApp(req, res));
  const poolUrl = await listen(poolServer);
  await t.mutation(internal.teams.registerServer, { serverId: "pool-1", url: poolUrl });

  // convex-test's generic signatures don't line up with ConvexHttpClient's; the runtime shape does.
  const call = t as unknown as { query: (f: unknown, a: unknown) => Promise<never>; mutation: (f: unknown, a: unknown) => Promise<never> };
  const stack = createApp({
    config,
    convex: { query: (fn, args) => call.query(fn, args), mutation: (fn, args) => call.mutation(fn, args) },
    apple: appleVerifier([BUNDLE_ID], { keys: [appleJwk] }),
    revisionPollMs: opts.revisionPollMs,
    streamMaxMs: opts.streamMaxMs,
    push: opts.push,
    microsoft: microsoftVerifier([MICROSOFT_CLIENT], { keys: [microsoftJwk] }),
    google: googleVerifier([GOOGLE_CLIENT], { keys: [googleJwk] }),
    microsoftConnect: opts.microsoftConnect ? { ...opts.microsoftConnect, fetchImpl: opts.microsoftFetch } : undefined,
  });
  gatewayServer.on("request", stack.app);

  return {
    t,
    api,
    internal,
    origin,
    config,
    teamId: String(teamId),
    teamServer,
    dataDir,
    poolDir,
    appleToken,
    microsoftToken,
    googleToken,
    control: stack.control,
    personal: stack.personal,
    directory: stack.directory,
    teams: stack.teams,
    notifier: stack.notifier,
    sessions: stack.sessions,
    revisions: stack.revisions,
    events: stack.events,
    microsoftConnect: stack.microsoftConnect,
    graphTokens,
    deliverer,
    close: async () => {
      await new Promise<void>((r) => gatewayServer.close(() => r()));
      await new Promise<void>((r) => teamServer.close(() => r()));
      await new Promise<void>((r) => poolServer.close(() => r()));
    },
  };
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

// ---- the apps' sign-in, as the iPhone and Mac apps do it (Gateway.swift) ----

/** An app's signed-in state: its tokens and the DPoP key they're bound to. */
export interface AppSession {
  access_token: string;
  refresh_token: string;
  user: { uid: string; name: string; email?: string | null };
  key: CryptoKeyPair;
}

/** Each access token's DPoP key, so appCall can sign its proofs given just the token. */
const keyOf = new Map<string, CryptoKeyPair>();

export const dpopKey = () => generateKeyPair("ES256", { extractable: true });

/** A DPoP proof (RFC 9449) for one request: method, address without query, and the token's hash. */
export async function dpopProof(key: CryptoKeyPair, method: string, url: string, accessToken?: string) {
  const { kty, crv, x, y } = await exportJWK(key.publicKey);
  const htu = new URL(url);
  htu.search = "";
  htu.hash = "";
  return new SignJWT({ htm: method, htu: htu.toString(), jti: randomUUID(), ...(accessToken ? { ath: createHash("sha256").update(accessToken).digest("base64url") } : {}) })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: { kty, crv, x, y } })
    .setIssuedAt()
    .sign(key.privateKey);
}

/** What the app sends to the token endpoint, signed with `key`. */
export async function tokenRequest(stack: Stack, key: CryptoKeyPair, params: Record<string, string>) {
  const url = `${stack.origin}/oauth/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", dpop: await dpopProof(key, "POST", url) },
    body: new URLSearchParams({ client_id: APP_CLIENT_ID, ...params }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, string> };
}

type AppIdentity = { apple: string; name?: string } | { microsoft: string; nonce?: string; name?: string } | { google: string; name?: string };

/**
 * The apps' sign-in, step by step: the authorization request (no browser: the app reads each
 * redirect itself), the Apple or Microsoft step, the code off the final redirect, then tokens.
 * Answers the step that failed, or the signed-in session.
 */
export async function appSignIn(stack: Stack, who: AppIdentity, key?: CryptoKeyPair): Promise<{ status: number; step: string; session?: AppSession; json?: unknown }> {
  key ??= await dpopKey();
  const jar = new CookieJar();
  const { verifier, challenge } = pkce();
  const state = randomBytes(12).toString("base64url");
  const authorize = new URL(`${stack.origin}/oauth/authorize`);
  // Exactly the app's request (Gateway.swift): no resource (the server defaults the app's), and
  // the code bound to the key (dpop_jkt).
  for (const [k, v] of Object.entries({
    client_id: APP_CLIENT_ID,
    response_type: "code",
    redirect_uri: APP_REDIRECT_URI,
    scope: "app",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    dpop_jkt: await calculateJwkThumbprint(await exportJWK(key.publicKey)),
  }))
    authorize.searchParams.set(k, v);
  const start = await get(authorize.toString(), jar);
  const interaction = start.headers.get("location");
  if (start.status !== 303 || !interaction?.startsWith("/interaction/")) return { status: start.status, step: "authorize" };

  const body = "apple" in who ? { identityToken: who.apple, name: who.name } : "google" in who ? { idToken: who.google, name: who.name } : { idToken: who.microsoft, nonce: who.nonce, name: who.name };
  const step = await fetch(`${stack.origin}${interaction}/${"apple" in who ? "apple" : "google" in who ? "google" : "microsoft"}`, {
    method: "POST",
    headers: { cookie: jar.header(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  jar.store(step);
  const stepJson = (await step.json()) as { next?: string };
  if (step.status !== 200 || !stepJson.next) return { status: step.status, step: "sign-in", json: stepJson };

  const resumed = await get(stepJson.next, jar);
  const done = new URL(resumed.headers.get("location") ?? "about:blank");
  if (!`${done.protocol}${done.pathname}`.startsWith(APP_REDIRECT_URI) || done.searchParams.get("state") !== state) {
    return { status: resumed.status, step: "code" };
  }
  const tokens = await tokenRequest(stack, key, {
    grant_type: "authorization_code",
    code: done.searchParams.get("code") ?? "",
    redirect_uri: APP_REDIRECT_URI,
    code_verifier: verifier,
  });
  if (tokens.status !== 200) return { status: tokens.status, step: "token", json: tokens.json };
  keyOf.set(tokens.json.access_token!, key);
  const me = await appCall(stack, tokens.json.access_token!, "GET", "/v1/app/me");
  const session = { access_token: tokens.json.access_token!, refresh_token: tokens.json.refresh_token!, user: me.json.user as AppSession["user"], key };
  return { status: 200, step: "done", session };
}

/** Sign a user in with Apple, as the app does, and return their tokens. */
export async function signIn(stack: Stack, sub: string, name: string): Promise<AppSession> {
  const r = await appSignIn(stack, { apple: await stack.appleToken(sub, `${sub}@example.com`), name });
  if (!r.session) throw new Error(`sign-in failed at ${r.step}: ${r.status} ${JSON.stringify(r.json ?? "")}`);
  return r.session;
}

/** A refresh, as the app does it: same key, same refresh token. */
export async function appRefresh(stack: Stack, session: AppSession) {
  const r = await tokenRequest(stack, session.key, { grant_type: "refresh_token", refresh_token: session.refresh_token });
  if (r.status === 200) keyOf.set(r.json.access_token!, session.key);
  return r;
}

/** The headers of an app API request: the token as DPoP, with a proof for this request. */
export async function appHeaders(token: string, method: string, url: string): Promise<Record<string, string>> {
  const key = keyOf.get(token);
  return key ? { authorization: `DPoP ${token}`, dpop: await dpopProof(key, method, url, token) } : { authorization: `Bearer ${token}` };
}

export async function appCall(stack: Stack, token: string, method: string, path: string, body?: unknown) {
  const url = `${stack.origin}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...(await appHeaders(token, method, url)), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** The fixture personal wiki as sync ops. */
export function fixturePersonalOps() {
  const root = join(FIXTURES, "wiki-personal");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
    });
  return walk(join(root, "wiki")).map((p) => {
    const content = readFileSync(p, "utf8");
    return {
      op: "upsert" as const,
      path: relative(root, p).split(sep).join("/"),
      hash: createHash("sha256").update(content).digest("hex"),
      content,
      updated: "2026-10-07",
    };
  });
}

export async function mcpClient(url: string, token: string) {
  const client = new Client({ name: "brain-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

export function text(result: unknown): string {
  const c = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return c[0]?.text ?? "";
}

export class CookieJar {
  private cookies = new Map<string, string>();
  store(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0] ?? "";
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(sc)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function get(url: string, jar: CookieJar) {
  const res = await fetch(url, { redirect: "manual", headers: { cookie: jar.header() } });
  jar.store(res);
  return res;
}

export async function postForm(url: string, jar: CookieJar, body: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  jar.store(res);
  return res;
}

export async function followUntil(start: Response, origin: string, jar: CookieJar, stop: string | string[]): Promise<{ res: Response; url: string }> {
  const prefixes = Array.isArray(stop) ? stop : [stop];
  let res = start;
  for (let i = 0; i < 10; i++) {
    const loc = res.headers.get("location");
    if (!loc) return { res, url: "" };
    const url = new URL(loc, origin).toString();
    if (prefixes.some((p) => url.startsWith(p))) return { res, url };
    res = await get(url, jar);
  }
  throw new Error("too many redirects");
}
