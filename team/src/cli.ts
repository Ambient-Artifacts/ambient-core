// Jobs run by systemd timers. Exit code 1 on failed/partial so OnFailure fires;
// the result JSON in out/consolidate/ is the source of truth either way.
import { AnthropicDecisionFiler, AnthropicEntityFinder, AnthropicOverviewWriter, AnthropicResearcher, AnthropicUpdater } from "./anthropic.ts";
import { loadTeamConfig } from "./config.ts";
import { consolidate, type PageUpdater } from "./consolidate.ts";
import { join } from "node:path";
import { TeamRemote } from "./remote.ts";
import { TeamWiki } from "./wiki.ts";
import { seedTeam } from "./seed.ts";

const cmd = process.argv[2];
const cfg = loadTeamConfig();
if (!cfg.teamId) {
  // A pool server without a team yet: nothing to consolidate.
  console.log(JSON.stringify({ job: cmd, status: "noop", reason: "unclaimed pool server" }));
  process.exit(0);
}

// Without a key, nights with no new notes are still a clean noop; nights with
// work fail per page (and retry next run) instead of failing before looking.
const missingKey: PageUpdater = {
  model: cfg.model,
  update: async () => {
    throw new Error("ANTHROPIC_API_KEY is not set");
  },
};

if (cmd === "consolidate" || cmd === "rewrite") {
  const wiki = await TeamWiki.open(cfg.wikiDir, cfg.teamId, cfg.teamName, new TeamRemote(join(cfg.dataDir, "remote.json"), cfg.wikiDir, {}, cfg.teamSecret));
  // Another tool keeps this wiki (its repo is connected read-only, or Ambient writes only one
  // folder of it): its upkeep isn't ours to do.
  if (wiki.remote?.readOnly || wiki.fence) {
    console.log(JSON.stringify({ status: "skipped", reason: "another tool keeps the wiki (the team's repo is connected read-only or with a folder for Ambient)" }));
    process.exit(0);
  }
  const updater = cfg.anthropicApiKey ? new AnthropicUpdater(cfg.anthropicApiKey, cfg.model) : missingKey;
  // `rewrite --all` or `rewrite people/anna-mueller …`: pages rewritten from their latest notes
  // (into their kind's sections), as well as the nightly run's work.
  const args = process.argv.slice(3);
  const rewrite =
    cmd !== "rewrite" ? [] : args.includes("--all") ? ["person", "org", "project", "topic"].flatMap((t) => wiki.store.ofType(t).map((p) => p.ref)) : args;
  if (cmd === "rewrite" && rewrite.length === 0) {
    console.error("usage: cli.ts rewrite --all | <ref>…");
    process.exit(2);
  }
  const result = await consolidate(wiki, updater, {
    overview: cfg.anthropicApiKey ? new AnthropicOverviewWriter(cfg.anthropicApiKey, cfg.model) : undefined,
    decisions: cfg.anthropicApiKey ? new AnthropicDecisionFiler(cfg.anthropicApiKey, cfg.model) : undefined,
    finder: cfg.anthropicApiKey ? new AnthropicEntityFinder(cfg.anthropicApiKey, cfg.model) : undefined,
    outDir: cfg.outDir,
    version: cfg.version,
    rewrite,
    // A full rewrite touches every page in one run.
    maxPages: cmd === "rewrite" ? Math.max(40, rewrite.length + 40) : undefined,
  });
  console.log(JSON.stringify(result));
  process.exit(result.status === "ok" || result.status === "noop" ? 0 : 1);
} else if (cmd === "seed") {
  // Day one of a new team: `cli.ts seed --domain example.com`, run by whoever sets the team up.
  const at = process.argv.indexOf("--domain");
  const domain = at > 0 ? process.argv[at + 1] : undefined;
  if (!domain) {
    console.error("usage: cli.ts seed --domain example.com");
    process.exit(2);
  }
  if (!cfg.anthropicApiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }
  const wiki = await TeamWiki.open(cfg.wikiDir, cfg.teamId, cfg.teamName, new TeamRemote(join(cfg.dataDir, "remote.json"), cfg.wikiDir, {}, cfg.teamSecret));
  const seeded = await seedTeam(wiki, new AnthropicResearcher(cfg.anthropicApiKey, cfg.model), { domain, outDir: cfg.outDir });
  // The first overview, from what was just written.
  const result = await consolidate(wiki, new AnthropicUpdater(cfg.anthropicApiKey, cfg.model), {
    overview: new AnthropicOverviewWriter(cfg.anthropicApiKey, cfg.model),
    outDir: cfg.outDir,
    version: cfg.version,
    forceOverview: true,
  });
  console.log(JSON.stringify({ seed: seeded, consolidate: { status: result.status, checks: result.checks } }));
  process.exit(result.status === "failed" ? 1 : 0);
} else {
  console.error("usage: cli.ts consolidate | rewrite --all | rewrite <ref>… | seed --domain example.com");
  process.exit(2);
}
