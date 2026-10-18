// Team server entry point (systemd: brain-team.service).
import { createTeamApp } from "./app.ts";
import { createUnclaimedApp } from "./claim.ts";
import { loadTeamConfig } from "./config.ts";
import { moveSessionNotes } from "./sessions-folder.ts";
import { join } from "node:path";
import { Deliverer, TranscriptOutbox } from "./destination.ts";
import { graphFor, GraphTokens } from "./graph.ts";
import { TeamRemote } from "./remote.ts";
import { TeamSettingsStore } from "./settings.ts";
import { TeamWiki } from "./wiki.ts";

const cfg = loadTeamConfig();

if (!cfg.teamId) {
  // In the pool, waiting for a team created in the app.
  const app = createUnclaimedApp({
    serverId: cfg.serverId!,
    dataDir: cfg.dataDir,
    gatewayIssuer: cfg.gatewayIssuer,
    gatewayJwks: cfg.gatewayJwksUrl,
    version: cfg.version,
    // Restart (systemd Restart=always) as the team's server.
    onClaimed: (t) => {
      console.log(`[team] claimed by ${t.teamName} (${t.teamId}); restarting`);
      setTimeout(() => process.exit(0), 300);
    },
  });
  app.listen(cfg.port, cfg.host, () => console.log(`[team] pool server ${cfg.serverId} waiting for a team on ${cfg.host}:${cfg.port}`));
} else {
  const wiki = await TeamWiki.open(cfg.wikiDir, cfg.teamId, cfg.teamName, new TeamRemote(join(cfg.dataDir, "remote.json"), cfg.wikiDir, {}, cfg.teamSecret));
  const moved = await moveSessionNotes(wiki).catch((err) => {
    console.error(`[team] moving work sessions to sessions/ failed: ${(err as Error).message}`);
    return 0;
  });
  if (moved) console.log(`[team] moved ${moved} work session(s) to sessions/`);
  const settings = new TeamSettingsStore(cfg.settingsFile, cfg.teamSecret);
  await settings.load();
  // Tokens for Ambient's own Microsoft app arrive from the gateway; one store for settings and delivery.
  const graphTokens = new GraphTokens();
  const makeGraph = (conn: Parameters<typeof graphFor>[0]) => graphFor(conn, graphTokens);
  const deliverer = new Deliverer(new TranscriptOutbox(cfg.outboxDir), settings, wiki, makeGraph);
  // Retries (with backoff per file) for deliveries that failed or were cut off by a restart.
  const deliver = () => void deliverer.run().catch((err) => console.error("[team] delivery", err));
  setInterval(deliver, 60_000).unref();
  deliver();
  const app = createTeamApp(wiki, {
    teamId: cfg.teamId,
    gatewayIssuer: cfg.gatewayIssuer,
    gatewayJwks: cfg.gatewayJwksUrl,
    rawDir: cfg.rawDir,
    version: cfg.version,
    outDir: cfg.outDir,
    settings,
    deliverer,
    graphTokens,
    graphFor: makeGraph,
  });
  app.listen(cfg.port, cfg.host, () => {
    console.log(`[team] ${cfg.teamName} (${cfg.teamId}) on ${cfg.host}:${cfg.port}, ${wiki.store.size} pages`);
  });
}
