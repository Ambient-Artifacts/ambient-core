// POST /teams/messages: the messaging endpoint of every team's bot (its Azure Bot points here).
// The activity names the bot it's for (recipient 28:<app id>); the Bot Framework's signature is
// checked for that bot before anything is read from it. Teams wants an answer within seconds, so
// the work happens after the 200.
import express, { type Router } from "express";
import { InboundError, type Activity, type InboundVerifier } from "./botframework.ts";
import type { MsTeamsBot } from "./bot.ts";

export function msteamsRouter(bots: MsTeamsBot[], verifier: InboundVerifier): Router {
  const router = express.Router();
  router.post("/teams/messages", express.json({ limit: "256kb" }), async (req, res) => {
    const a = req.body as Activity;
    if (!a || typeof a !== "object" || typeof a.serviceUrl !== "string" || !a.recipient?.id || !a.conversation?.id || !a.from?.id) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const bot = bots.find((b) => a.recipient.id === `28:${b.appId}`);
    if (!bot) {
      res.status(401).json({ error: "unknown_bot" });
      return;
    }
    try {
      await verifier.verify(req.get("authorization"), bot.appId, a);
    } catch (err) {
      if (err instanceof InboundError) {
        console.warn(`[msteams] refused: ${err.message}`);
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      throw err;
    }
    if (!bot.accepts(a)) {
      // Signed for this bot, but from another tenant: a single-tenant bot answers no one there.
      res.status(403).json({ error: "wrong_tenant" });
      return;
    }
    res.status(200).end();
    bot.handle(a).catch((err) => console.error(`[msteams] ${a.type}: ${(err as Error).message}`));
  });
  return router;
}
