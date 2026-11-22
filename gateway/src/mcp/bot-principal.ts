// The brain for bots (docs/bots.md, "The brain for bots"): a bot's run signs in to Ambient's MCP
// with its run token, valid only while the run goes. It gets the brain the way an employee's AI app
// has it: everything to read that its owner may read (a personal bot: their wiki and their teams';
// a team bot: that team's only, never a member's personal wiki), and to write only what anyone may:
// corrections and its work log. No pages edited, no notes saved in someone's name, no settings, no
// other bots, computers, accounts or secrets (BOT_TOOLS).
import { sha256Hex } from "../crypto.ts";
import { api, type Control } from "../control.ts";
import { AuthError, type Principal, type ResourceTarget } from "../auth/bearer.ts";
import type { Directory, Team } from "../directory.ts";
import { RUN_TOKEN_PREFIX } from "../routines/service.ts";

/** What a bot's run may use of Ambient's MCP: reading the brain, corrections, its work log. */
export const BOT_TOOLS = new Set([
  "index",
  "search",
  "fetch",
  "brief",
  "get_entity",
  "list_recent",
  "list_decisions",
  "list_action_items",
  "transcript",
  "suggest_correction",
  "log_work",
  "post_to_slack",
]);

/** A bot run's principal from its run token; null when the header holds another kind of token. */
export async function botPrincipal(d: { control: Control; directory: Directory }, authorization: string | undefined, target: ResourceTarget): Promise<Principal | null> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token.startsWith(RUN_TOKEN_PREFIX)) return null;
  const run = await d.control.q(api.bots.runOwner, { runTokenHash: sha256Hex(token) });
  if (!run) throw new AuthError(401, "invalid_token", "This bot's run is over.", true);
  const uid = String(run.createdBy);
  const bot = { routineId: String(run.routineId), name: run.name, teamId: run.teamId ? String(run.teamId) : null };
  if (run.teamId) {
    const team = (await d.control.q(api.teams.byId, { teamId: run.teamId as never })) as unknown as Team | null;
    if (!team || team.status !== "active") throw new AuthError(403, "insufficient_scope", "This bot's team isn't active.");
    if (target.teamSlug && target.teamSlug !== team.slug) throw new AuthError(403, "insufficient_scope", `This bot belongs to the team ${team.name}.`);
    return { uid, scopes: new Set(["team:read", "team:write"]), via: "pat", clientId: `bot:${bot.routineId}`, personal: false, teams: [team], bot };
  }
  const teams = (await d.directory.teamsOf(uid)).filter((t) => t.status === "active");
  const only = target.teamSlug ? teams.filter((t) => t.slug === target.teamSlug) : teams;
  if (target.teamSlug && !only.length) throw new AuthError(403, "insufficient_scope", "This bot's owner isn't in that team.");
  return { uid, scopes: new Set(["personal:read", "personal:write", "team:read", "team:write"]), via: "pat", clientId: `bot:${bot.routineId}`, personal: !target.teamSlug, teams: only, bot };
}
