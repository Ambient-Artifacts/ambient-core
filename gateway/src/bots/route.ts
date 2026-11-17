// HTTP for bots (docs/bots.md): the app's routes (features, a bot's thread, the chat with Ambient)
// and a run's own (asking its owner, with the run's token).
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { z } from "zod";
import type { Directory } from "../directory.ts";
import { RoutineError, type Actor, type RoutineService } from "../routines/service.ts";
import { limiter } from "../limiter.ts";
import type { AmbientChat } from "./ambient.ts";
import type { BotService } from "./service.ts";
import type { AmbientComputers } from "./computer.ts";
import type { Host } from "../routines/service.ts";

function fail(res: Response, err: unknown) {
  if (err instanceof RoutineError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  throw err;
}

const Text = z.object({ text: z.string().trim().min(1).max(8_000) });

export function botAppRoutes(
  r: Router,
  d: { routines: RoutineService; bots: BotService; ambient: AmbientChat; directory: Directory; auth: RequestHandler; json: RequestHandler },
) {
  const actor = async (res: Response): Promise<Actor> => {
    const uid = res.locals.uid as string;
    return { uid, teams: await d.directory.teamsOf(uid), personal: true, canWritePersonal: true, canWriteTeams: true };
  };
  const id = (req: Request) => String(req.params.id);
  const notEnabled = (res: Response) => res.status(403).json({ error: "bots_not_enabled", message: "Bots aren't switched on for this account yet." });

  r.get("/v1/app/features", d.auth, async (_req, res) => {
    res.json({ bots: d.routines.botsEnabled(await actor(res)) });
  });

  r.get("/v1/app/routines/:id/thread", d.auth, async (req, res) => {
    const asked = Number(typeof req.query.limit === "string" ? req.query.limit : NaN);
    const limit = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 100) : 50;
    try {
      res.json(await d.bots.thread(await actor(res), id(req), limit));
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/app/routines/:id/thread", d.auth, d.json, async (req, res) => {
    const body = Text.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Write something first (up to 8,000 characters)." });
      return;
    }
    try {
      const a = await actor(res);
      res.json(await d.bots.receive(a, { channel: "app", uid: a.uid, target: { kind: "bot", botId: id(req) }, text: body.data.text }));
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/ambient/chat", d.auth, async (_req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) return notEnabled(res);
    res.json(await d.ambient.list(a.uid));
  });

  r.post("/v1/app/ambient/chat", d.auth, d.json, async (req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) return notEnabled(res);
    const body = Text.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Write something first (up to 8,000 characters)." });
      return;
    }
    try {
      const name = (await d.directory.user(a.uid))?.name ?? "them";
      const { message, pending } = await d.ambient.send(a.uid, name, body.data.text);
      res.json({ message, pending });
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/ambient/chat", d.auth, async (_req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) return notEnabled(res);
    await d.ambient.clear(a.uid);
    res.status(204).end();
  });
}

/** A bot's run asks its owner (the runner's ask_owner tool), with its run token. */
export function botRunRouter(d: { bots: BotService }): Router {
  const r = express.Router();
  const json = express.json({ limit: "64kb" });
  const perRun = limiter(120);
  const slowDown = (req: Request, res: Response) => {
    const key = (req.headers.authorization ?? "").slice(-16);
    if (perRun(key)) return false;
    res.status(429).json({ error: "slow_down" });
    return true;
  };

  r.post("/v1/bot/ask", json, async (req, res) => {
    if (slowDown(req, res)) return;
    const body = z.object({ question: z.string().trim().min(1).max(2_000), choices: z.array(z.string().max(120)).max(6).optional() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Ask a question (up to 2,000 characters), with up to 6 choices." });
      return;
    }
    try {
      res.json(await d.bots.ask(req.headers.authorization, body.data.question, body.data.choices));
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/bot/questions/:id", async (req, res) => {
    if (slowDown(req, res)) return;
    try {
      res.json(await d.bots.answer(req.headers.authorization, String(req.params.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  return r;
}

/**
 * A person's computer that runs Ambient (ambient-runner ambient), with its computer token: it waits
 * for the next chat message (a long poll of up to 25 seconds) and sends back the reply.
 */
export function ambientHostRouter(d: { routines: RoutineService; directory: Directory; computers: AmbientComputers }): Router {
  const r = express.Router();
  const json = express.json({ limit: "256kb" });
  const host = async (req: Request, res: Response): Promise<Host | undefined> => {
    const h = await d.routines.authenticate(req.headers.authorization);
    if (!h || !h.uid || h.teamId || !(await d.directory.user(h.uid))) {
      res.status(401).json({ error: "invalid_token", message: "This computer isn't connected anymore. Set it up again from the Ambient app." });
      return undefined;
    }
    if (!(await d.routines.botsForUser(h.uid))) {
      res.status(403).json({ error: "bots_not_enabled", message: "Ambient isn't switched on for this account." });
      return undefined;
    }
    return h;
  };

  r.get("/v1/host/ambient/next", async (req, res) => {
    const h = await host(req, res);
    if (!h) return;
    if (req.query.token === "missing") d.computers.forgetToken(h.id);
    let closed = false;
    res.on("close", () => {
      closed = true;
      d.computers.drop(h.id);
    });
    const job = await d.computers.next(h.id, 25_000);
    if (closed) {
      if (job) d.computers.requeue(h.id, job);
      return;
    }
    if (!job) {
      res.status(204).end();
      return;
    }
    res.json(job);
  });

  r.post("/v1/host/ambient/:jobId", json, async (req, res) => {
    const h = await host(req, res);
    if (!h) return;
    const body = z.object({ text: z.string().max(100_000).optional(), error: z.string().max(2_000).optional() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Send the reply's text, or what went wrong." });
      return;
    }
    const id = String(req.params.jobId);
    const ok = body.data.error !== undefined ? d.computers.fail(h.id, id, body.data.error) : d.computers.reply(h.id, id, body.data.text ?? "");
    if (!ok) {
      res.status(404).json({ error: "no_such_message", message: "That message isn't waiting for a reply anymore." });
      return;
    }
    res.status(204).end();
  });

  return r;
}
