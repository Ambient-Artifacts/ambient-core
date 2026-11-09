// Which teams have an Ambient bot in Microsoft Teams. Each bot is the customer's own app
// registration in their own Microsoft Entra tenant, with an Azure Bot whose messaging endpoint
// is <origin>/teams/messages; its id and secret live only in the gateway's env (and, for the
// team's own loops that post the morning report and tell owners, in the team's pipeline).
//
// BRAIN_MSTEAMS_BOTS='[{"team":"acme","tenantId":"…","appId":"…","secret":"…"}]'
import { z } from "zod";

const Bot = z.object({
  /** The Ambient team (slug) whose wiki the bot answers from. */
  team: z.string().regex(/^[a-z0-9-]+$/),
  tenantId: z.string().uuid(),
  appId: z.string().uuid(),
  secret: z.string().min(8),
  /** Anthropic API key for the answers (the team's own, so the cost is theirs); ANTHROPIC_API_KEY when absent. */
  anthropicApiKey: z.string().min(10).optional(),
  model: z.string().default("claude-sonnet-5-5"),
  language: z.enum(["en", "de"]).default("en"),
});

export type MsTeamsBotConfig = z.infer<typeof Bot>;

export function parseMsTeamsBots(raw: string | undefined): MsTeamsBotConfig[] {
  if (!raw?.trim()) return [];
  const bots = z.array(Bot).parse(JSON.parse(raw));
  const ids = new Set<string>();
  for (const b of bots) {
    if (ids.has(b.appId)) throw new Error(`BRAIN_MSTEAMS_BOTS: app ${b.appId} is listed twice`);
    ids.add(b.appId);
  }
  return bots;
}
