import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type Provider from "oidc-provider";
import { appApiRouter } from "./app-api.ts";
import { appleRevoker, type AppleRevoker } from "./auth/apple-revoke.ts";
import { joinRouter } from "./join.ts";
import { addressKey, limiter } from "./limiter.ts";
import { CodeHasher } from "./auth/codes.ts";
import { SignInNonces } from "./auth/signin-nonce.ts";
import { appAccess } from "./auth/app-access.ts";
import type { AppleVerifier } from "./auth/apple.ts";
import { microsoftVerifier, type MicrosoftVerifier } from "./auth/microsoft.ts";
import { createBearerVerifier } from "./auth/bearer.ts";
import { Pairing } from "./auth/pairing.ts";
import { PatService } from "./auth/pats.ts";
import type { GatewayConfig } from "./config.ts";
import { api, Control, type ConvexCaller } from "./control.ts";
import { Directory } from "./directory.ts";
import type { ReaderSource } from "./mcp/tools.ts";
import { contextRouter } from "./context/route.ts";
import { mcpRouter, protectedResourceRouter } from "./mcp/route.ts";
import { interactionRouter } from "./oauth/interactions.ts";
import { createProvider } from "./oauth/provider.ts";
import { PersonalStore } from "./personal.ts";
import { apnsSender, Notifier, type PushSender } from "./push.ts";
import { PersonalRepos } from "./repos/personal.ts";
import { EventHub, PollingRevisionSource, Revisions, type RevisionSource } from "./revisions.ts";
import { hostRouter } from "./routines/route.ts";
import { RoutineKeys } from "./routines/keys.ts";
import { loadRunner, RoutineService } from "./routines/service.ts";
import { sessionUploadRouter } from "./sessions/route.ts";
import { SessionService } from "./sessions/service.ts";
import { MicrosoftConnectFlow, MicrosoftConnector } from "./microsoft-connect.ts";
import { TeamLink } from "./teams.ts";

export const VERSION = "0.1.0";

export interface AppDeps {
  config: GatewayConfig;
  convex: ConvexCaller;
  apple: AppleVerifier;
  /** Tests only: stands in for Apple's token revocation. */
  appleRevoke?: AppleRevoker;
  /** Tests only: stands in for Apple's push service. */
  push?: PushSender;
  /** Tests: checks Microsoft ID tokens against local keys. */
  microsoft?: MicrosoftVerifier;
  fetchImpl?: typeof fetch;
  /** Where ambient-runner.mjs lives (the repo's runner/ by default). */
  runnerDir?: string;
  /** Live revisions (production: a Convex subscription); polling Convex when absent (tests). */
  revisionSource?: RevisionSource;
  /** Tests: how often the polling source asks, and how long an event stream stays open. */
  revisionPollMs?: number;
  streamMaxMs?: number;
  /** Tests: Ambient's Microsoft app against a fake Microsoft, and no wait for its access to spread. */
  microsoftConnect?: { connector: MicrosoftConnector; fetchImpl?: typeof fetch; propagationDelayMs?: number };
}

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const control = new Control(deps.convex, config.serviceSecret);
  const directory = new Directory(control, config.directoryTtlMs);
  const pats = new PatService(control);
  const codeHasher = new CodeHasher(config.masterKey);
  const signInNonces = new SignInNonces(config.masterKey, async (key, expiresAt) => (await control.m(api.oauth.useOnce, { model: "SignInNonce", key, expiresAt })).first);
  const pairing = new Pairing(control, codeHasher);
  const personal = new PersonalStore(control, config.masterKey);
  const repos = new PersonalRepos(control, personal, { allowFile: config.allowFileRepos });
  const revisions = new Revisions(control);
  const teams = new TeamLink(config.origin, config.signingKeys[0]!, deps.fetchImpl, (team) => revisions.teamChanged(team.id));
  const events = new EventHub(deps.revisionSource ?? new PollingRevisionSource(revisions, deps.revisionPollMs ?? 5_000));
  const microsoft = deps.microsoft ?? (config.microsoftClientIds?.length ? microsoftVerifier(config.microsoftClientIds) : undefined);
  const connector = deps.microsoftConnect?.connector ?? (config.microsoftConnect ? new MicrosoftConnector(config.microsoftConnect) : undefined);
  const microsoftConnect = connector
    ? new MicrosoftConnectFlow({
        origin: config.origin,
        connector,
        control,
        teams,
        fetchImpl: deps.microsoftConnect?.fetchImpl,
        propagationDelayMs: deps.microsoftConnect?.propagationDelayMs,
      })
    : undefined;
  const provider: Provider = createProvider(config, directory, control);
  const verify = createBearerVerifier({ issuer: config.origin, signingKeys: config.signingKeys, directory, pats });
  const sessions = new SessionService({ control, personal, directory, teams });
  const notifier = new Notifier({ control, send: deps.push ?? apnsSender(config.apns) });
  const runner = loadRunner(deps.runnerDir ?? fileURLToPath(new URL("../../runner/", import.meta.url)), config.origin);
  const routines = new RoutineService({
    control,
    keys: new RoutineKeys({ control, personal, master: config.masterKey }),
    codes: codeHasher,
    origin: config.origin,
    runner: runner && { version: runner.version, sha256: runner.sha256, signature: runner.signature },
    notifier,
  });
  const readers: ReaderSource = {
    personal: (uid) => personal.reader(uid),
    personalTranscript: (uid, rawPath) => personal.transcript(uid, rawPath),
    savePersonal: async (uid, path, content) => {
      await personal.serverWrite(uid, [{ path, content }]);
    },
    team: (team, uid) => (team.serverUrl ? teams.reader(team, uid) : undefined),
    logWork: (uid, spec) => sessions.writeNote(uid, spec),
  };

  const app: Express = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy ?? "loopback");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "brain-gateway", version: VERSION });
  });

  app.use(protectedResourceRouter(config.origin));

  // RFC 8414 metadata: same document oidc-provider serves as OIDC discovery.
  app.get("/.well-known/oauth-authorization-server", (req, _res, next) => {
    req.url = "/.well-known/openid-configuration";
    next();
  });

  const userName = async (uid: string) => (await directory.user(uid))?.name;
  app.use(mcpRouter({ origin: config.origin, verify, readers, routines, version: VERSION, userName }));
  app.use(contextRouter({ origin: config.origin, verify, readers, userName }));
  app.use(hostRouter({ routines, directory, runnerSource: runner?.source }));
  app.use(sessionUploadRouter({ pats, directory, sessions }));
  app.use(
    appApiRouter({
      control,
      directory,
      access: appAccess(config.origin, config.signingKeys),
      pairing,
      codes: codeHasher,
      signInNonces,
      clientName: async (clientId) => (await provider.Client.find(clientId))?.clientName,
      personal,
      teams,
      pats,
      repos,
      sessions,
      routines,
      appleRevoke: deps.appleRevoke ?? appleRevoker(config.appleRevoke, deps.fetchImpl),
      microsoftClientId: microsoft ? config.microsoftClientIds?.[0] : undefined,
      appleSignIn: config.appleAudiences.length > 0,
      microsoftConnect,
      appConfig: { minimumVersion: config.minAppVersion, updateUrl: config.appUpdateUrl },
      revisions,
      events,
      streamMaxMs: deps.streamMaxMs,
    }),
  );
  app.use(joinRouter());
  if (microsoftConnect) app.use(microsoftConnect.router());
  // Where people get the code for an AI app: from the app; without Apple or Microsoft sign-in
  // there's no app to show one, so from the admin CLI; on a self-hosted server, either.
  const appSignIn = config.appleAudiences.length > 0 || !!microsoft;
  const codes = !appSignIn ? "admin" : config.adminCodes ? "both" : "app";
  app.use(interactionRouter(provider, directory, pairing, control, { apple: deps.apple, microsoft, codes, signups: config.signups, nonces: signInNonces, requireNonce: config.requireSignInNonce }));

  // Client registration and the authorize step are open to anyone and each stores rows in Convex.
  // A registered client is kept for good, so registering is limited tightly per address; the
  // authorize step's rows expire (oauth.sweepExpired), so it only gets a ceiling against floods.
  const registrations = limiter(20);
  const authorizations = limiter(300);
  const tooMany = (res: Response) => res.status(429).json({ error: "rate_limited", error_description: "Too many requests. Try again in a minute." });
  app.post("/oauth/register", (req, res, next) => (registrations(addressKey(req.ip)) ? next() : tooMany(res)));
  app.use(["/oauth/authorize", "/oauth/par"], (req, res, next) => (authorizations(addressKey(req.ip)) ? next() : tooMany(res)));

  // Everything else (/.well-known/openid-configuration, /oauth/*) is the provider.
  app.use(provider.callback());

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[gateway] unhandled", err);
    if (!res.headersSent) res.status(500).json({ error: "server_error" });
  });

  return { app, provider, control, directory, pairing, personal, pats, repos, sessions, routines, revisions, events, notifier, teams, microsoftConnect };
}
