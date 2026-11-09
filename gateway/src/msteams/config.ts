// Which teams have an Ambient bot in Microsoft Teams. Each bot is the customer's own app
// registration in their own Microsoft Entra tenant, with an Azure Bot whose messaging endpoint
// is <origin>/teams/messages; its id and secret live only in the gateway's env.
//
// BRAIN_MSTEAMS_BOTS='[{"team":"acme","tenantId":"…","appId":"…","secret":"…","readAs":"<uid>"}]'
import { z } from "zod";

const Bot = z.object({
  /** The Ambient team (slug) whose wiki the bot reports on. */
  team: z.string().regex(/^[a-z0-9-]+$/),
  tenantId: z.string().uuid(),
  appId: z.string().uuid(),
  secret: z.string().min(8),
  /** A member of the team the bot reads the wiki as (the team server checks membership). */
  readAs: z.string().min(1),
  /** Link to a page, `{path}` = its path in the repo with .md, e.g. an Azure DevOps or GitHub file URL. */
  pageUrl: z.string().url().optional(),
  language: z.enum(["en", "de"]).default("en"),
  timeZone: z.string().default("Europe/Vienna"),
  /** Local hour of the morning report on workdays; messages to owners only from `quietUntil` to `quietFrom`. */
  reportHour: z.number().int().min(0).max(23).default(8),
  quietUntil: z.string().regex(/^\d{2}:\d{2}$/).default("07:30"),
  quietFrom: z.string().regex(/^\d{2}:\d{2}$/).default("19:00"),
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
