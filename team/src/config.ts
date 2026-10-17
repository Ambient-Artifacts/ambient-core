import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface TeamConfig {
  /** Empty while the server waits in the pool for a team (see claim.ts). */
  teamId: string;
  teamName: string;
  /** This server's id in the pool; a claim from the gateway is addressed to it. */
  serverId: string | null;
  dataDir: string;
  wikiDir: string;
  rawDir: string;
  outDir: string;
  gatewayIssuer: string;
  gatewayJwksUrl: string;
  port: number;
  /** Behind Caddy on the same machine by default; in a container, 0.0.0.0. */
  host: string;
  anthropicApiKey: string | null;
  /** BRAIN_TEAM_SECRET: seals the team repo's token in remote.json. */
  teamSecret: string | null;
  model: string;
  version: string;
}

function need(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is required`);
  return v;
}

/** Which team this server serves: set in its env by hand, or claimed from the pool (team.json). */
export function claimedTeam(dataDir: string, env: NodeJS.ProcessEnv = process.env): { teamId: string; teamName: string } | null {
  if (env.BRAIN_TEAM_ID) return { teamId: env.BRAIN_TEAM_ID, teamName: env.BRAIN_TEAM_NAME ?? "Team" };
  try {
    const t = JSON.parse(readFileSync(join(dataDir, "team.json"), "utf8")) as { teamId?: string; teamName?: string };
    return t.teamId ? { teamId: t.teamId, teamName: t.teamName ?? "Team" } : null;
  } catch {
    return null;
  }
}

export function loadTeamConfig(env: NodeJS.ProcessEnv = process.env): TeamConfig {
  const dataDir = env.BRAIN_DATA_DIR ?? "/srv/brain";
  const issuer = need(env, "BRAIN_GATEWAY_ISSUER").replace(/\/+$/, "");
  const team = claimedTeam(dataDir, env);
  if (!team && !env.BRAIN_SERVER_ID) throw new Error("BRAIN_TEAM_ID (or BRAIN_SERVER_ID for a pool server) is required");
  return {
    teamId: team?.teamId ?? "",
    teamName: team?.teamName ?? "Team",
    serverId: env.BRAIN_SERVER_ID ?? null,
    dataDir,
    wikiDir: join(dataDir, "wiki"),
    rawDir: join(dataDir, "raw"),
    outDir: join(dataDir, "out"),
    gatewayIssuer: issuer,
    gatewayJwksUrl: env.BRAIN_GATEWAY_JWKS ?? `${issuer}/oauth/jwks`,
    port: Number(env.PORT ?? 8090),
    host: env.BRAIN_LISTEN_HOST || "127.0.0.1",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    /** Seals the team repo's token in remote.json (TeamRemote); optional, for servers set up before it. */
    teamSecret: env.BRAIN_TEAM_SECRET || null,
    model: env.BRAIN_CONSOLIDATE_MODEL ?? "claude-haiku-4-5",
    version: env.BRAIN_VERSION ?? "0.1.0",
  };
}
