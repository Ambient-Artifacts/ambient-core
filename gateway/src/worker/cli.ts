// Jobs on the core VM, run by systemd timers:
//   node --import tsx gateway/src/worker/cli.ts personal        every 15 min (brain-personal.timer)
//   node --import tsx gateway/src/worker/cli.ts sessions         every minute (brain-sessions.timer)
//   node --import tsx gateway/src/worker/cli.ts health [--daily] every 30 min, daily heartbeat
//   node --import tsx gateway/src/worker/cli.ts digest           hourly (brain-digest.timer)
// `personal` exits 1 when any user's run failed (OnFailure alerts); per-user results are in
// Convex either way. `sessions` turns uploaded work sessions into notes and sends team copies
// whose hold is over; it always exits 0 (failures are retried, and the health check flags
// what stays stuck). `health` posts to BRAIN_ALERT_WEBHOOK and exits 1 while problems are open.
import { ConvexHttpClient } from "convex/browser";
import { AnthropicOverviewWriter, AnthropicSessionSummarizer, AnthropicUpdater, DEFAULT_MODEL } from "@brain/team";
import { VERSION } from "../app.ts";
import { loadConfig } from "../config.ts";
import { Control } from "../control.ts";
import { Directory } from "../directory.ts";
import { SessionService } from "../sessions/service.ts";
import { TeamLink } from "../teams.ts";
import { PersonalStore } from "../personal.ts";
import { Revisions } from "../revisions.ts";
import { PersonalRepos } from "../repos/personal.ts";
import { RoutineKeys } from "../routines/keys.ts";
import { BotFolder } from "../bots/folder.ts";
import { BotMirror } from "../bots/mirror.ts";
import { alerts, checkHealth, loadState, post, saveState, systemdUnit } from "./health.ts";
import { runPersonalWorker } from "./personal.ts";
import { runDigest } from "../digest.ts";
import { computerLlm, GatewayUpkeep, useServerKey } from "../upkeep.ts";
import { gatewayRelay, relayingFetch } from "../relay.ts";
import { apnsSender, Notifier } from "../push.ts";

const [cmd, ...flags] = process.argv.slice(2);
const config = loadConfig();
const convex = new ConvexHttpClient(config.convexUrl);
const control = new Control({ query: (fn, args) => convex.query(fn, args), mutation: (fn, args) => convex.mutation(fn, args) }, config.serviceSecret);

/**
 * Where upkeep's model runs: "computer" (each person's own, the default) or "key": the server's
 * ANTHROPIC_API_KEY, only with BRAIN_USE_SERVER_KEY=true (self-hosting, where the server pays).
 */
function upkeepMode(): "computer" | "key" {
  return useServerKey() ? "key" : "computer";
}

/** fetch for team servers: a team on its own computer is reached through the gateway's relay (relay.ts). */
function teamFetch(): typeof fetch {
  return relayingFetch(gatewayRelay(process.env.BRAIN_HEALTH_GATEWAY_URL || `http://127.0.0.1:${process.env.PORT ?? 8080}`, config.serviceSecret));
}

/** The gateway's way to people's computers (its internal routes, with the service secret). */
function gatewayUpkeep(): GatewayUpkeep {
  return new GatewayUpkeep(process.env.BRAIN_HEALTH_GATEWAY_URL || `http://127.0.0.1:${process.env.PORT ?? 8080}`, config.serviceSecret);
}

if (cmd === "personal") {
  const personal = new PersonalStore(control, config.masterKey);
  // 1. Claude upkeep, on each person's own computer (upkeep.ts): their notes wait while it isn't
  //    connected. BRAIN_USE_SERVER_KEY=true runs it on ANTHROPIC_API_KEY instead (self-hosting).
  const model = process.env.BRAIN_CONSOLIDATE_MODEL ?? "claude-haiku-4-5";
  const key = process.env.ANTHROPIC_API_KEY;
  const viaKey = upkeepMode() === "key";
  const computers = viaKey ? undefined : gatewayUpkeep();
  const runs =
    viaKey && !key
      ? []
      : await runPersonalWorker({
          control,
          personal,
          ...(viaKey ? { updater: new AnthropicUpdater(key!, model, "personal"), overview: new AnthropicOverviewWriter(key!, model) } : {}),
          ...(computers
            ? {
                computers: {
                  computerFor: (uid: string) => computers.computerFor(uid),
                  writers: (uid: string) => ({ updater: new AnthropicUpdater(computerLlm(computers, uid), model, "personal"), overview: new AnthropicOverviewWriter(computerLlm(computers, uid), model) }),
                },
              }
            : {}),
          version: VERSION,
        });
  // 2. Users' own repos, after upkeep so its changes go out in the same pass. Their failures
  //    (a revoked token) are the health check's business, not an OnFailure alert every 15 min.
  //    Their bots' folders go along (docs/bots.md, "A bot's folder in git").
  const keys = new RoutineKeys({ control, personal, master: config.masterKey });
  const mirror = new BotMirror({ control, keys, folder: new BotFolder({ control, keys }) });
  const repos = await new PersonalRepos(control, personal, {}, { files: (uid) => mirror.personalFiles(uid) }).syncAll();
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      ...(viaKey && !key ? { upkeep: "skipped: BRAIN_USE_SERVER_KEY=true but ANTHROPIC_API_KEY is not set" } : {}),
      users: runs.length,
      runs,
      repos: repos.map((r) => ({ uid: r.uid, ok: r.ok, error: r.error ?? null, ...(r.result ?? {}) })),
    }),
  );
  process.exit(runs.some((r) => r.status === "failed") ? 1 : 0);
} else if (cmd === "sessions") {
  const personal = new PersonalStore(control, config.masterKey);
  const directory = new Directory(control, 60_000);
  const revisions = new Revisions(control);
  const teams = new TeamLink(config.origin, config.signingKeys[0]!, teamFetch(), (team) => revisions.teamChanged(team.id));
  const sessions = new SessionService({ control, personal, directory, teams });
  // Each session's note is written on its person's computer (upkeep.ts); BRAIN_USE_SERVER_KEY=true: on the key.
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.BRAIN_SESSION_MODEL ?? DEFAULT_MODEL;
  const viaKey = upkeepMode() === "key";
  const moved = await sessions.moveLegacyNotes();
  const computers = viaKey ? null : gatewayUpkeep();
  const written = viaKey
    ? key
      ? await sessions.process(new AnthropicSessionSummarizer(key, model))
      : []
    : await sessions.process((uid) => new AnthropicSessionSummarizer(computerLlm(computers!, uid), model));
  const delivered = await sessions.deliverDue();
  const skipped = viaKey && !key;
  // Sessions waiting for a computer aren't news every minute.
  if (written.some((w) => w.status !== "waiting") || delivered.length || moved || skipped) {
    console.log(JSON.stringify({ at: new Date().toISOString(), ...(skipped ? { sessions: "skipped: BRAIN_USE_SERVER_KEY=true but ANTHROPIC_API_KEY is not set" } : {}), moved, written: written.filter((w) => w.status !== "waiting"), waiting: written.filter((w) => w.status === "waiting").length, delivered }));
  }
  process.exit(0);
} else if (cmd === "digest") {
  // The morning push of open action items, in each user's time zone (digest.ts).
  const personal = new PersonalStore(control, config.masterKey);
  const directory = new Directory(control, 60_000);
  const teams = new TeamLink(config.origin, config.signingKeys[0]!, teamFetch());
  const notifier = new Notifier({ control, send: apnsSender(config.apns) });
  const runs = await runDigest({ control, personal, teams, directory, notifier });
  const sent = runs.filter((r) => r.status === "sent").length;
  if (sent || runs.some((r) => r.status === "failed")) console.log(JSON.stringify({ at: new Date().toISOString(), sent, failed: runs.filter((r) => r.status === "failed") }));
  process.exit(0);
} else if (cmd === "health") {
  const now = Date.now();
  const stateFile = process.env.BRAIN_HEALTH_STATE ?? "/var/lib/brain-health/state.json";
  const { problems, summary } = await checkHealth({
    control,
    // In Docker the jobs run in their own container: BRAIN_HEALTH_GATEWAY_URL is the gateway's.
    gatewayUrl: process.env.BRAIN_HEALTH_GATEWAY_URL || `http://127.0.0.1:${process.env.PORT ?? 8080}`,
    now,
    unit: systemdUnit,
    teamToken: (team) => new TeamLink(config.origin, config.signingKeys[0]!, teamFetch()).token(team, "health"),
    // A team on its own computer is checked through the gateway's relay (relay.ts).
    fetchImpl: teamFetch(),
    poolInUse: process.env.BRAIN_TEAM_POOL === "true",
  });
  const out = alerts(await loadState(stateFile), problems, now, flags.includes("--daily"), summary);
  for (const m of out.messages) await post(process.env.BRAIN_ALERT_WEBHOOK, m).catch((err) => console.error(`alert failed: ${(err as Error).message}`));
  await saveState(stateFile, out.state);
  process.exit(problems.length ? 1 : 0);
} else {
  console.error("usage: cli.ts personal | sessions | health [--daily] | digest");
  process.exit(2);
}
