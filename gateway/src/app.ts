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
import { googleVerifier, type GoogleVerifier } from "./auth/google.ts";
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
import { SettingsService } from "./team-admin.ts";
import { Voices } from "./voices.ts";
import { interactionRouter } from "./oauth/interactions.ts";
import { createProvider } from "./oauth/provider.ts";
import { PersonalStore } from "./personal.ts";
import { apnsSender, Notifier, type PushSender } from "./push.ts";
import { PersonalRepos } from "./repos/personal.ts";
import { EventHub, PollingRevisionSource, Revisions, type RevisionSource } from "./revisions.ts";
import { hostRouter } from "./routines/route.ts";
import { BotService } from "./bots/service.ts";
import { AmbientChat } from "./bots/ambient.ts";
import { ambientHostRouter, botRunRouter } from "./bots/route.ts";
import { BotFolder } from "./bots/folder.ts";
import { BotFiles, type Folders } from "./bots/files.ts";
import { HistorySearch } from "./bots/history.ts";
import { BotMirror } from "./bots/mirror.ts";
import { Automations } from "./bots/automations.ts";
import { AmbientComputers } from "./bots/computer.ts";
import { AdminService } from "./bots/admin.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DecisionService } from "./bots/decisions.ts";
import { Heartbeat } from "./bots/heartbeat.ts";
import { AppChannel } from "./channels/channel.ts";
import { RoutineKeys } from "./routines/keys.ts";
import { loadRunner, RoutineService } from "./routines/service.ts";
import { sessionUploadRouter } from "./sessions/route.ts";
import { SessionService } from "./sessions/service.ts";
import { MicrosoftConnectFlow, MicrosoftConnector } from "./microsoft-connect.ts";
import { TeamLink } from "./teams.ts";
import { buildMcpServer, correctionNote } from "./mcp/tools.ts";
import { MCP_SCOPES, TEAM_MCP_SCOPES } from "./mcp/route.ts";
import { personalInstructions } from "./mcp/context.ts";
import { MsTeamsBot } from "./msteams/bot.ts";
import { BotClient, InboundVerifier } from "./msteams/botframework.ts";
import { msteamsRouter } from "./msteams/route.ts";

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
  /** Tests: checks Google ID tokens against local keys. */
  google?: GoogleVerifier;
  fetchImpl?: typeof fetch;
  /** Where ambient-runner.mjs lives (the repo's runner/ by default). */
  runnerDir?: string;
  /** Live revisions (production: a Convex subscription); polling Convex when absent (tests). */
  revisionSource?: RevisionSource;
  /** Tests: how often the polling source asks, and how long an event stream stays open. */
  revisionPollMs?: number;
  streamMaxMs?: number;
  /** Tests: the Teams bots against a fake Bot Framework, with their state in memory. */
  msteams?: { fetchImpl?: typeof fetch; verifier?: InboundVerifier; apiKey?: string };
  /** Tests: Ambient's chat against a fake Anthropic; how long it may look at a bot's question; no heartbeat timer. */
  ambient?: { fetchImpl?: typeof fetch; apiKey?: string; triageMs?: number; noHeartbeat?: boolean; turnMs?: number };
  /** Tests: how long after a change bots are mirrored into git (default 30 s). */
  mirrorDelayMs?: number;
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
  // A person's bots go into their repo with each sync (docs/bots.md, "A bot's folder in git").
  let botMirror: BotMirror | undefined;
  const repos = new PersonalRepos(control, personal, { allowFile: config.allowFileRepos }, { files: (uid) => botMirror?.personalFiles(uid) ?? Promise.resolve(new Map()) });
  const revisions = new Revisions(control);
  const teams = new TeamLink(config.origin, config.signingKeys[0]!, deps.fetchImpl, (team) => revisions.teamChanged(team.id));
  const events = new EventHub(deps.revisionSource ?? new PollingRevisionSource(revisions, deps.revisionPollMs ?? 5_000));
  const microsoft = deps.microsoft ?? (config.microsoftClientIds?.length ? microsoftVerifier(config.microsoftClientIds) : undefined);
  const google = deps.google ?? (config.googleClientIds?.length ? googleVerifier(config.googleClientIds) : undefined);
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
  const routineKeys = new RoutineKeys({ control, personal, master: config.masterKey });
  // Bots' folders, memory and handoffs, and Amb's memory (docs/bots.md, "A bot's folder").
  const folder = new BotFolder({ control, keys: routineKeys });
  const routines = new RoutineService({
    control,
    keys: routineKeys,
    folder,
    codes: codeHasher,
    origin: config.origin,
    runner: runner && { version: runner.version, sha256: runner.sha256, signature: runner.signature },
    notifier,
    bots: config.bots,
    teamsOf: (uid) => directory.teamsOf(uid),
    teamBySlug: (slug) => directory.teamBySlug(slug),
  });
  botMirror = new BotMirror({ control, keys: routineKeys, folder, teams, repos, delayMs: deps.mirrorDelayMs });
  const mirror = botMirror;
  folder.onChange = (owner, change) => mirror.changed(owner, change);
  const folders: Folders = {
    folder,
    mirror,
    files: new BotFiles({ routines, folder, mirror }),
    history: new HistorySearch({ control, keys: routineKeys, routines, folder, nameOf: async (uid) => (await directory.user(uid))?.name ?? "them" }),
  };
  // Bots talk to people through channels; the app is the first (docs/bots.md).
  let startNow: ((hostId: string, routineId: string) => boolean) | undefined;
  // A bot's question goes to Ambient first (DecisionService, set up below with Ambient).
  let onQuestion: ((q: Parameters<DecisionService["onBotQuestion"]>[0]) => void) | undefined;
  const bots = new BotService({
    routines,
    channels: [new AppChannel(notifier)],
    startNow: (hostId, routineId) => startNow?.(hostId, routineId) ?? false,
    onQuestion: (q) => (onQuestion ? onQuestion(q) : undefined),
  });
  const userName = async (uid: string) => (await directory.user(uid))?.name;
  const readers: ReaderSource = {
    personal: (uid) => personal.reader(uid),
    personalTranscript: (uid, rawPath) => personal.transcript(uid, rawPath),
    savePersonal: async (uid, path, content) => {
      await personal.serverWrite(uid, [{ path, content }]);
    },
    team: (team, uid) => (team.serverUrl ? teams.reader(team, uid) : undefined),
    logWork: (uid, spec) => sessions.writeNote(uid, spec),
    userName,
    // No hold: the person asked for the correction to go to the team.
    deliverToTeam: (team, uid, note) => teams.deliver(team, note, uid, team.peopleSlug ?? null),
  };

  // Teams' bots in Microsoft Teams: a click is filed as the clicker's own correction, a question is
  // answered by Claude with the team's MCP server built for the person who asked (team scope, as
  // /t/<team>/mcp gives it). The morning report and the cards come from the team's own loops.
  const msteamsBots = (config.msteamsBots ?? []).map(
    (b) =>
      new MsTeamsBot({
        config: b,
        client: new BotClient(b, deps.msteams?.fetchImpl ?? deps.fetchImpl),
        apiKey: deps.msteams?.apiKey ?? process.env.ANTHROPIC_API_KEY,
        fetchImpl: deps.msteams?.fetchImpl ?? deps.fetchImpl,
        // The team's members with their sign-in email (Convex has no lookup by email; a team is small).
        accounts: async () => {
          const { users } = await control.q(api.admin.overview, {});
          const inTeam = await Promise.all(users.map(async (u) => ((await directory.membership(String(u.uid), b.team)) ? u : undefined)));
          return inTeam.filter((u): u is NonNullable<typeof u> => !!u).map((u) => ({ uid: String(u.uid), name: u.name, email: u.email ?? null }));
        },
        reader: async (uid) => {
          const team = await directory.membership(uid, b.team);
          return team?.serverUrl ? teams.reader(team, uid) : undefined;
        },
        mcp: async (uid) => {
          const team = await directory.membership(uid, b.team);
          if (!team) return undefined;
          const principal = { uid, scopes: new Set(TEAM_MCP_SCOPES), via: "pat" as const, clientId: "msteams", personal: false, teams: [team] };
          return buildMcpServer({ principal, readers, version: VERSION, personal: null });
        },
        correct: async (c) => {
          const team = await directory.membership(c.uid, b.team);
          if (!team?.serverUrl) throw new Error(`${c.name} isn't in the team ${b.team}, or it has no server`);
          const note = correctionNote({ team, uid: c.uid, name: c.name, app: "Microsoft Teams", source: "msteams", wrong: c.wrong, right: c.right, howKnown: c.howKnown, refs: c.refs, subject: c.subject, now: new Date() });
          return teams.deliver(team, note, c.uid, team.peopleSlug ?? null);
        },
      }),
  );

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

  // Settings an AI app can change for its user, the same service as the app's routes.
  const settings = new SettingsService({ directory, teams, control });
  const voices = new Voices({ control, personal, directory });
  // Ambient, the master bot: Claude with the person's own MCP server, every scope, as /mcp gives it.
  // Ambient on a person's own computer (their Claude plan) when one is connected; the server's key otherwise.
  const computers = new AmbientComputers({ pats, scopes: MCP_SCOPES });
  startNow = (hostId, routineId) => computers.start(hostId, routineId);
  // Root commands Ambient asks for, run by the computer's runner after an approval (or at once on full access).
  const admin = new AdminService({ control, keys: routines.keys, routines, computers, notifier });
  const ambient: AmbientChat = new AmbientChat({
    control,
    keys: routines.keys,
    mcp: async (uid): Promise<McpServer> => {
      const principal = { uid, scopes: new Set(MCP_SCOPES), via: "pat" as const, clientId: "ambient-chat", personal: true, teams: await directory.teamsOf(uid) };
      const personal = await personalInstructions(principal, readers, { name: await userName(uid).catch(() => undefined) });
      return buildMcpServer({ principal, readers, routines, bots, admin, decisions, folders, settings, voices, version: VERSION, personal });
    },
    apiKey: deps.ambient?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    model: config.ambientModel ?? "claude-sonnet-5-5",
    fetchImpl: deps.ambient?.fetchImpl ?? deps.fetchImpl,
    computers,
    computersOf: (uid) => routines.computersOf(uid),
    nameOf: async (uid) => (await directory.user(uid))?.name,
    folder,
  });
  // Bots report to Ambient, Ambient reports to the person (docs/bots.md, "Decisions").
  const actorFor = async (uid: string) => ({ uid, teams: await directory.teamsOf(uid), personal: true, canWritePersonal: true, canWriteTeams: true });
  const decisions: DecisionService = new DecisionService({ control, keys: routines.keys, routines, bots, ambient, channels: [new AppChannel(notifier)], actorFor, triageMs: deps.ambient?.triageMs });
  ambient.decisionView = (uid, row) => decisions.view(uid, row);
  onQuestion = (q) => void decisions.onBotQuestion(q);
  const heartbeat = new Heartbeat({ control, ambient, bots: config.bots, notifier });
  // What Amb does on its own: templates on a schedule or an event (docs/bots.md, "Automations").
  const automations = new Automations({ control, keys: routineKeys, routines, ambient, files: folders.files, decisions, heartbeat, notifier, bots: config.bots, actorFor, turnMs: deps.ambient?.turnMs });
  folders.automations = automations;
  routines.onBotEvent = (e) => void automations.onEvent(e);
  bots.onEvent = (e) => void automations.onEvent(e);
  heartbeat.watching = (uid) => automations.watching(uid);
  if (!deps.ambient?.noHeartbeat) {
    heartbeat.start();
    automations.start();
  }
  app.use(mcpRouter({ origin: config.origin, verify, readers, routines, bots, admin, decisions, folders, settings, voices, version: VERSION, userName }));
  app.use(contextRouter({ origin: config.origin, verify, readers, userName }));
  app.use(hostRouter({ routines, directory, runnerSource: runner?.source }));
  app.use(botRunRouter({ bots, history: folders.history }));
  app.use(ambientHostRouter({ routines, directory, computers }));
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
      bots,
      ambient,
      admin,
      decisions,
      folders,
      onMeetingNote: (e) => void automations.onEvent({ kind: "meeting_note", ...e }),
      appleRevoke: deps.appleRevoke ?? appleRevoker(config.appleRevoke, deps.fetchImpl),
      microsoftClientId: microsoft ? config.microsoftClientIds?.[0] : undefined,
      googleClientId: google ? config.googleClientIds?.[0] : undefined,
      appleSignIn: config.appleAudiences.length > 0,
      microsoftConnect,
      appConfig: { minimumVersion: config.minAppVersion, updateUrl: config.appUpdateUrl },
      revisions,
      events,
      streamMaxMs: deps.streamMaxMs,
    }),
  );
  app.use(msteamsRouter(msteamsBots, deps.msteams?.verifier ?? new InboundVerifier(deps.fetchImpl)));
  app.use(joinRouter());
  if (microsoftConnect) app.use(microsoftConnect.router());
  // Where people get the code for an AI app: from the app; without Apple, Microsoft or Google sign-in
  // there's no app to show one, so from the admin CLI; on a self-hosted server, either.
  const appSignIn = config.appleAudiences.length > 0 || !!microsoft || !!google;
  const codes = !appSignIn ? "admin" : config.adminCodes ? "both" : "app";
  app.use(interactionRouter(provider, directory, pairing, control, { apple: deps.apple, microsoft, google, codes, signups: config.signups, nonces: signInNonces, requireNonce: config.requireSignInNonce }));

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

  return { app, provider, control, directory, pairing, personal, pats, repos, sessions, routines, bots, ambient, decisions, heartbeat, folders, automations, revisions, events, notifier, teams, microsoftConnect, msteamsBots };
}
