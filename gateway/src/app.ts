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
import { LiveText } from "./bots/live.ts";
import { EventHub, PollingRevisionSource, Revisions, type RevisionSource } from "./revisions.ts";
import { hostRouter } from "./routines/route.ts";
import { BotService } from "./bots/service.ts";
import { AmbientChat } from "./bots/ambient.ts";
import { ambientHostRouter, botRunRouter, githubHookRouter, linqHookRouter, slackHookRouter } from "./bots/route.ts";
import { GitHubEvents } from "./bots/github.ts";
import { GitHubApps } from "./bots/github-apps.ts";
import { SlackApps } from "./bots/slack-apps.ts";
import { BotFolder } from "./bots/folder.ts";
import { BotFiles, type Folders } from "./bots/files.ts";
import { HistorySearch } from "./bots/history.ts";
import { BotMirror } from "./bots/mirror.ts";
import { Automations, askedBefore } from "./bots/automations.ts";
import { BotLearning } from "./bots/learning.ts";
import { AmbSettings } from "./bots/amb-settings.ts";
import { AmbientComputers } from "./bots/computer.ts";
import { AdminService } from "./bots/admin.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DecisionService } from "./bots/decisions.ts";
import { Heartbeat } from "./bots/heartbeat.ts";
import { Wakes } from "./bots/wakes.ts";
import { AppChannel } from "./channels/channel.ts";
import { IMessageChannel } from "./channels/imessage.ts";
import { AmbReach } from "./channels/reach.ts";
import { McpConnections } from "./bots/mcp-connections.ts";
import { mcpRelayPath, mcpRelayRouter, mcpSignInRouter } from "./bots/mcp-relay.ts";
import { Transcriber } from "./channels/transcribe.ts";
import { RoutineKeys } from "./routines/keys.ts";
import { loadInstaller, loadRunner, RoutineService } from "./routines/service.ts";
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
import { internalRouter, Upkeep, upkeepOf, useServerKey } from "./upkeep.ts";
import { PeopleService } from "./people.ts";
import { botPrincipal } from "./mcp/bot-principal.ts";
import { Attachments } from "./bots/attachments.ts";
import { relayingFetch, type Relay } from "./relay.ts";
import { teamBundler, type TeamBundle } from "./team-bundle.ts";

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
  /** Tests: the team brain's bundle, instead of building it. */
  teamBundle?: () => Promise<TeamBundle>;
  ambient?: { fetchImpl?: typeof fetch; apiKey?: string; triageMs?: number; noHeartbeat?: boolean; turnMs?: number };
  /** Tests: how long after a change bots are mirrored into git (default 30 s). */
  mirrorDelayMs?: number;
  /** Tests: how long GitHub's events on one PR are gathered before they wake its bot (default 90 s). */
  githubBatchMs?: number;
  /** Tests: Ambient's GitHub App against a stand-in GitHub API. */
  githubFetch?: typeof fetch;
  /** Tests: bots' Slack apps against a stand-in Slack Web API. */
  slack?: { apiBase?: string; fetchImpl?: typeof fetch };
  /** Tests: MCP servers on 127.0.0.1 over http may be connected. */
  mcpConnections?: { allowLocal?: boolean };
  /** Tests: Amb's iMessage line against a stand-in Linq API. */
  linq?: { apiBase?: string; fetchImpl?: typeof fetch };
  /** Tests: how long after a signal Amb looks at a bot (default 10 minutes). */
  learning?: { reviewAfterMs?: number };
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
  // A team on its own computer is reached through that computer's runner (relay.ts); the computers'
  // queue is made further down, so the relay is looked up when a request goes out.
  let relay: Relay = () => Promise.reject(new Error("the gateway is still starting"));
  const teamFetch = relayingFetch((host, req, ms) => relay(host, req, ms), deps.fetchImpl ?? fetch);
  const teams = new TeamLink(config.origin, config.signingKeys[0]!, teamFetch, (team) => revisions.teamChanged(team.id));
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
  const runnerDir = deps.runnerDir ?? fileURLToPath(new URL("../../runner/", import.meta.url));
  // The team's brain for teams on their own computer (team-bundle.ts), built when first asked for.
  const teamBundle = deps.teamBundle ?? teamBundler(fileURLToPath(new URL("../../", import.meta.url)), VERSION);
  const runner = loadRunner(runnerDir, config.origin);
  const installer = loadInstaller(runnerDir, config.origin);
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
    teamsOf: (uid) => directory.teamsOf(uid),
    teamBySlug: (slug) => directory.teamBySlug(slug),
    teamBundle: async () => {
      const b = await teamBundle();
      return { version: b.version, sha256: b.sha256 };
    },
    onTeamServer: () => directory.forgetTeams(),
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
  // Files sent in Ambient's chat and bots' threads, kept so they show again (bots/attachments.ts).
  const attachments = new Attachments({ control, keys: routines.keys });
  // Bots' answers as they're written: from the runner to the readers' event streams (bots/live.ts).
  const live = new LiveText({ control });
  const bots = new BotService({
    routines,
    attachments,
    live,
    channels: [new AppChannel(notifier)],
    startNow: (hostId, routineId) => startNow?.(hostId, routineId) ?? false,
    onQuestion: (q) => (onQuestion ? onQuestion(q) : undefined),
  });
  // Wake-ups bots book for themselves (bots/wakes.ts): fired by its ticker, started at once.
  const wakes = new Wakes({ routines, startNow: (hostId, routineId) => startNow?.(hostId, routineId) ?? false });
  folders.wakes = wakes;
  routines.wakesFor = (r) => wakes.forRun(r);
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
        apiKey: deps.msteams?.apiKey ?? (useServerKey() ? process.env.ANTHROPIC_API_KEY : undefined),
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
  relay = (host, req, ms) => computers.relay(host, req, ms);
  // The brain's upkeep and work-session notes, written by Claude on the person's own computer.
  const upkeep = new Upkeep({ routines, computers });
  // Teams and the person's own profile (people.ts): the app's routes and the AI apps' tools share it.
  const people = new PeopleService({ control, directory, teams, codes: codeHasher, personal, microsoftConnect });
  const upkeepFor = (uid: string) => upkeepOf({ control, upkeep }, uid);
  // Root commands Ambient asks for, run by the computer's runner after an approval (or at once on full access).
  const admin = new AdminService({ control, keys: routines.keys, routines, computers, notifier });
  // The MCP servers a person gave Amb (set once the connections are up, below).
  let ambientMcp: (uid: string) => Promise<{ name: string; path: string; title: string }[]> = async () => [];
  const ambient: AmbientChat = new AmbientChat({
    attachments,
    mcpFor: (uid) => ambientMcp(uid),
    control,
    keys: routines.keys,
    mcp: async (uid): Promise<McpServer> => {
      const principal = { uid, scopes: new Set(MCP_SCOPES), via: "pat" as const, clientId: "ambient-chat", personal: true, teams: await directory.teamsOf(uid) };
      const personal = await personalInstructions(principal, readers, { name: await userName(uid).catch(() => undefined) });
      return buildMcpServer({ principal, readers, routines, bots, admin, decisions, folders, settings, voices, people, upkeep: upkeepFor, userName, version: VERSION, personal });
    },
    // Without a computer, the server's key answers only where the operator pays (upkeep.ts, useServerKey).
    apiKey: deps.ambient ? deps.ambient.apiKey : useServerKey() ? process.env.ANTHROPIC_API_KEY : undefined,
    model: config.ambientModel ?? "claude-sonnet-5-5",
    fetchImpl: deps.ambient?.fetchImpl ?? deps.fetchImpl,
    computers,
    computersOf: (uid) => routines.computersOf(uid),
    nameOf: async (uid) => (await directory.user(uid))?.name,
    folder,
  });
  // Bots report to Ambient, Ambient reports to the person (docs/bots.md, "Decisions").
  // Every routine is a bot (docs/bots.md, "Loops are bots"): loops from a server that had bots
  // off become bots that run as before, once, at start (as `admin bots adopt-loops`).
  void (control.m(api.bots.adoptPlainLoops, { now: Date.now() }) as Promise<{ adopted: number }>)
    .then((out) => {
      if (out.adopted) console.log(`[bots] ${out.adopted} loop(s) from before bots are bots now`);
    })
    .catch((err: Error) => console.warn(`[bots] loops weren't adopted: ${err.message}`));
  const actorFor = async (uid: string) => ({ uid, teams: await directory.teamsOf(uid), personal: true, canWritePersonal: true, canWriteTeams: true });
  // Where Amb's own words go besides the app's chat (channels/reach.ts): an answer back through
  // the channel it was asked in; what Amb says first to the one place the person chose.
  let reachOf: (uid: string) => Promise<string> = async () => "app";
  // Someone asked Amb to stop texting: it writes first in the app again (set with Amb's settings, below).
  let reachBackToApp: (uid: string) => Promise<void> = async () => undefined;
  // A pick in a poll files the decision's answer (set once the decisions are up, just below).
  let answerDecision: (uid: string, id: string, answer: string) => Promise<void> = async () => {
    throw new Error("Decisions aren't up yet.");
  };
  const reach = new AmbReach({ notifier, reachOf: (uid) => reachOf(uid) });
  folders.reach = reach;
  // What Amb made with its answer (a picture, a PDF) goes back with it.
  ambient.onReply = async (uid, via, text, files) => {
    const made = await Promise.all(files.map((f) => ambient.file(uid, f.id).catch(() => null)));
    await reach.reply(uid, via, text, made.filter((f): f is NonNullable<typeof f> => f !== null));
  };
  if (config.linq) {
    // Voice memos become text, when a speech-to-text key is set (channels/transcribe.ts).
    const transcriber = config.transcribe ? new Transcriber({ config: config.transcribe, fetchImpl: deps.linq?.fetchImpl ?? deps.fetchImpl }) : undefined;
    const imessage = new IMessageChannel({ control, keys: routineKeys, master: config.masterKey, config: config.linq, inbox: ambient, answer: (uid, id, answer) => answerDecision(uid, id, answer), onOptOut: (uid) => reachBackToApp(uid), ...(transcriber ? { transcribe: (bytes: Buffer, type: string) => transcriber.transcribe(bytes, type) } : {}), fetchImpl: deps.linq?.fetchImpl ?? deps.fetchImpl, apiBase: deps.linq?.apiBase });
    folders.imessage = imessage;
    reach.add(imessage);
  }
  const decisions: DecisionService = new DecisionService({ control, keys: routines.keys, routines, bots, ambient, channels: [new AppChannel(notifier)], reach, actorFor, triageMs: deps.ambient?.triageMs });
  ambient.decisionView = (uid, row) => decisions.view(uid, row);
  answerDecision = async (uid, id, answer) => void (await decisions.answer(await actorFor(uid), id, answer, "imessage"));
  onQuestion = (q) => void decisions.onBotQuestion(q);
  // Who Ambient's background work is for: everyone with bots or a chat with Ambient. Bots are
  // everyone's; with BRAIN_BOTS=all this was nobody (the "*" was dropped before asking Convex), so
  // the heartbeat, Amb's nightly memory and automations didn't run (2026-11-20).
  const withBots = async () => ((await control.q(api.bots.people, {})) as { users: string[] }).users.map(String);
  const heartbeat = new Heartbeat({ control, ambient, people: withBots, notifier, reach });
  // What Amb does on its own: templates on a schedule or an event (docs/bots.md, "Automations").
  const automations = new Automations({ control, keys: routineKeys, routines, ambient, files: folders.files, decisions, notifier, reach, people: withBots, actorFor, turnMs: deps.ambient?.turnMs });
  folders.automations = automations;
  // Watching the bots is part of Amb (its settings), not an automation.
  const ambSettings = new AmbSettings({ control, keys: routineKeys, legacyOff: (uid) => automations.legacyWatchOff(uid), canReach: (uid, kind) => reach.linked(uid, kind) });
  reachOf = (uid) => ambSettings.reach(uid);
  reachBackToApp = async (uid) => {
    if ((await ambSettings.reach(uid)) !== "app") await ambSettings.set(uid, { reach: "app" });
  };
  folders.ambSettings = ambSettings;
  heartbeat.watching = (uid) => ambSettings.notifies(uid);
  // Every bot learns on its own (docs/bots.md, "How bots learn").
  const learning = new BotLearning({
    control,
    keys: routineKeys,
    folder,
    files: folders.files,
    ambient,
    decisions,
    actorFor,
    reviewAfterMs: deps.learning?.reviewAfterMs,
    turnMs: deps.ambient?.turnMs,
    owners: async () => {
      const out = (await control.q(api.bots.people, {})) as { users: string[]; teams: string[] };
      return [...out.users.map((uid) => ({ kind: "user" as const, uid: String(uid) })), ...out.teams.map((teamId) => ({ kind: "team" as const, teamId: String(teamId) }))];
    },
  });
  folders.learning = learning;
  const ownerOf = async (routineId: string) => {
    const r = (await control.q(api.bots.routineOwner, { id: routineId })) as { teamId: string | null; createdBy: string } | null;
    return r ? (r.teamId ? { kind: "team" as const, teamId: String(r.teamId) } : { kind: "user" as const, uid: String(r.createdBy) }) : null;
  };
  // What happens in a bot's thread: automations for the person, and signals for the bot's learning.
  const onBotEvent = (e: Parameters<Automations["onEvent"]>[0]) => {
    void automations.onEvent(e);
    if (e.kind !== "bot_failed" && e.kind !== "bot_corrected" && e.kind !== "bot_asked") return;
    void (async () => {
      const owner = await ownerOf(e.routineId);
      if (!owner) return;
      if (e.kind === "bot_failed") await learning.signal(owner, e.routineId, { kind: "run_failed", text: e.text.slice(0, 600), source: `run ${e.runId}` });
      else if (e.kind === "bot_corrected") await learning.signal(owner, e.routineId, { kind: "corrected", text: e.text.slice(0, 600) });
      else if (await askedBefore(control, routineKeys, e, Date.now())) await learning.signal(owner, e.routineId, { kind: "asked_twice", text: e.text.slice(0, 600) });
    })().catch((err: Error) => console.warn(`[learning] ${err.message}`));
  };
  routines.onBotEvent = onBotEvent;
  bots.onEvent = onBotEvent;
  // GitHub's events wake the bot whose pull request it is; the PR gate (docs/bots.md).
  const github = new GitHubEvents({
    control,
    keys: routineKeys,
    origin: config.origin,
    startNow: (hostId, routineId) => computers.start(hostId, routineId),
    onCiFailed: (e) => void automations.onEvent({ kind: "github_ci_failed", ...e }),
    onSignal: (owner, routineId, signal) => void learning.signal(owner, routineId, signal),
    batchMs: deps.githubBatchMs,
  });
  folders.github = github;
  routines.githubFor = (owner, id) => github.forRun(owner, id);
  // Connect GitHub: Ambient's GitHub App, when it's set up (docs/bots.md, "Connect GitHub").
  // Ambient's GitHub Apps: the shared one (its config), the template roles' and bots' own (Convex).
  const githubApp = new GitHubApps({ control, keys: routineKeys, master: config.masterKey, origin: config.origin, github, shared: config.githubApp, apiBase: config.githubApp?.apiBase, fetchImpl: deps.githubFetch ?? deps.fetchImpl });
  folders.githubApp = githubApp;
  github.appOf = async (owner, bot) => (await githubApp.appFor(owner, bot))?.key ?? null;
  routines.githubToken = async (owner, id) => githubApp.tokenFor(owner, { id, ...(await github.watchOf(owner, id)) });
  // MCP servers people connect once and give to bots or to Amb (docs/bots.md, "MCP connections");
  // a run reaches them through the gateway (bots/mcp-relay.ts), never with their key.
  const mcpConnections = new McpConnections({ control, keys: routineKeys, origin: config.origin, fetchImpl: deps.fetchImpl, allowLocal: deps.mcpConnections?.allowLocal });
  folders.mcp = mcpConnections;
  routines.mcpFor = async (owner, id) => (await mcpConnections.forBot(owner, id)).map((c) => ({ name: c.name, path: mcpRelayPath(c.id) }));
  ambientMcp = async (uid) => (await mcpConnections.forAmb(uid)).map((c) => ({ name: c.name, path: mcpRelayPath(c.id), title: c.title }));
  // Bots' own Slack apps (docs/bots.md, "Slack"): one app per bot, made by Ambient, one tap to install.
  const slack = new SlackApps({ control, keys: routineKeys, master: config.masterKey, origin: config.origin, startNow: (hostId, routineId) => computers.start(hostId, routineId), fetchImpl: deps.slack?.fetchImpl ?? deps.fetchImpl, apiBase: deps.slack?.apiBase });
  folders.slack = slack;
  routines.slackToken = (owner, id) => slack.botToken(owner, id);
  routines.onBotSaid = (owner, id, text, final, runId) => slack.said(owner, id, text, final, { id: runId });
  routines.onBotRunStarted = (owner, id, runId, hash) => slack.runStarted(owner, id, runId, hash);
  bots.onSaid = (owner, id, text, hash) => slack.said(owner, id, text, false, { hash });
  bots.onTookSlack = (owner, id, hash) => slack.runTook(owner, id, hash);
  if (!deps.ambient?.noHeartbeat) {
    heartbeat.start();
    automations.start();
    wakes.start();
    learning.start();
  }
  // Bots' runs read the brain too, as an employee's AI app would (mcp/bot-principal.ts).
  app.use(mcpRouter({ origin: config.origin, verify, readers, routines, bots, admin, decisions, folders, settings, voices, people, upkeep: upkeepFor, version: VERSION, userName, botPrincipal: (h, t) => botPrincipal({ control, directory }, h, t) }));
  app.use(contextRouter({ origin: config.origin, verify, readers, userName }));
  app.use(hostRouter({ routines, directory, runnerSource: runner?.source, installSource: installer, teamBundle, live }));
  app.use(botRunRouter({ bots, history: folders.history, wakes }));
  app.use(githubHookRouter(() => folders.github, () => folders.githubApp));
  app.use(slackHookRouter(() => folders.slack));
  app.use(linqHookRouter(() => folders.imessage));
  app.use(mcpSignInRouter(() => folders.mcp));
  app.use(mcpRelayRouter({ connections: () => folders.mcp, control, ambUid: (token) => computers.uidOfToken(token), version: VERSION }));
  app.use(ambientHostRouter({ routines, directory, computers }));
  app.use(internalRouter({ secret: config.serviceSecret, upkeep, relay: (host, req, ms) => computers.relay(host, req, ms) }));
  app.use(sessionUploadRouter({ pats, directory, sessions }));
  app.use(
    appApiRouter({
      control,
      upkeep,
      people,
      directory,
      access: appAccess(config.origin, config.signingKeys),
      pairing,
      codes: codeHasher,
      signInNonces,
      clientName: async (clientId) => (await provider.Client.find(clientId))?.clientName,
      clientInfo: async (clientId) => {
        const c = await provider.Client.find(clientId);
        return c ? { name: c.clientName, redirectUris: [...(c.redirectUris ?? [])] } : undefined;
      },
      origin: config.origin,
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
      live,
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

  return { app, provider, control, directory, pairing, personal, pats, repos, sessions, routines, bots, ambient, decisions, heartbeat, folders, automations, revisions, events, live, notifier, teams, microsoftConnect, msteamsBots };
}
