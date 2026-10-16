// What the Claude Code plugin's hooks read (integrations/claude-code/scripts/context.sh):
//   GET /v1/context/start?since=YYYY-MM-DD   the pack at the start of a session (plain text)
//   GET /v1/context/names                    people, orgs and projects with their names, which
//                                            the hook matches against a prompt on the computer
//   GET /v1/context/pages?ids=a,b            current truth of the ones a prompt mentioned
// The prompt itself never comes here: the hook finds the names in it and asks for those pages.
// Auth is the token the plugin already has (or any token for /mcp).
import express, { type Request, type Response, type Router } from "express";
import { AuthError, type Principal, type createBearerVerifier } from "../auth/bearer.ts";
import { limiter } from "../limiter.ts";
import { contextStores, entityPack, selfRefs, sessionStartPack, storeId } from "../mcp/context.ts";
import type { ReaderSource } from "../mcp/tools.ts";
import { ME_REF } from "../me.ts";

export function contextRouter(d: {
  origin: string;
  verify: ReturnType<typeof createBearerVerifier>;
  readers: ReaderSource;
  userName?: (uid: string) => Promise<string | undefined>;
}): Router {
  const r = express.Router();
  const allow = limiter(120);

  const who = async (req: Request, res: Response): Promise<Principal | null> => {
    try {
      const p = await d.verify(req.headers.authorization, { url: `${d.origin}/mcp`, teamSlug: null });
      if (!allow(p.uid)) {
        res.status(429).json({ error: "slow_down" });
        return null;
      }
      return p;
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      res.status(err.status).json({ error: err.code, message: err.message });
      return null;
    }
  };

  r.get("/v1/context/start", async (req, res) => {
    const p = await who(req, res);
    if (!p) return;
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const text = await sessionStartPack(p, d.readers, { name: await d.userName?.(p.uid).catch(() => undefined), since });
    res.set("Cache-Control", "no-store").type("text/plain; charset=utf-8").send(text);
  });

  r.get("/v1/context/names", async (req, res) => {
    const p = await who(req, res);
    if (!p) return;
    const stores = await contextStores(p, d.readers);
    const self = selfRefs(stores);
    const entities: { id: string; type: string; names: string[] }[] = [];
    for (const s of stores) {
      const list = s.reader.entityNames ? await s.reader.entityNames().catch(() => []) : [];
      for (const e of list) {
        if (e.type === "topic" || e.ref === ME_REF || self.has(`${s.scope}:${s.team?.slug ?? ""}:${e.ref}`)) continue;
        const names = [...new Set([e.title, ...e.aliases].map((n) => n.trim()).filter((n) => n.length >= 3))];
        if (names.length) entities.push({ id: storeId(s, e.ref), type: e.type, names });
      }
    }
    res.set("Cache-Control", "no-store");
    // The hook has no JSON parser: one "id<TAB>name" line per name.
    if (req.query.format === "tsv") {
      const clean = (x: string) => x.replace(/[\t\r\n]+/g, " ").trim();
      res.type("text/plain; charset=utf-8").send(entities.flatMap((e) => e.names.map((n) => `${e.id}\t${clean(n)}\n`)).join(""));
      return;
    }
    res.json({ entities });
  });

  r.get("/v1/context/pages", async (req, res) => {
    const p = await who(req, res);
    if (!p) return;
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 3 && x.length < 300)
      .slice(0, 3);
    const { text, found } = await entityPack(p, d.readers, ids);
    res.set("Cache-Control", "no-store").set("Ambient-Found", found.join(",")).type("text/plain; charset=utf-8").send(text);
  });

  return r;
}
