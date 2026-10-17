// HTTP for routines: the app's routes (/v1/app/routines, /v1/app/computers), the computers'
// own API (/v1/host/*, with a computer token), and the runner script they download.
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import { z } from "zod";
import type { Directory } from "../directory.ts";
import { HostInfo, RoutineError, RoutineInput, RoutinePatch, RunProgress, RunResult, SecretName, SecretValue, type Actor, type Host, type RoutineService } from "./service.ts";
import { limiter } from "../limiter.ts";

function fail(res: Response, err: unknown) {
  if (err instanceof RoutineError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  throw err;
}

function badRequest(res: Response, error: z.ZodError) {
  const issue = error.issues[0];
  const where = issue?.path.join(".") || "request";
  res.status(400).json({ error: "bad_request", message: `Check ${where}: ${issue?.message ?? "invalid"}.` });
}

/** The app's routes, on the app router (its sign-in check and body parser). */
export function routineAppRoutes(r: Router, d: { routines: RoutineService; directory: Directory; auth: RequestHandler; json: RequestHandler }) {
  const id = (req: Request) => String(req.params.id);
  // The app acts for the signed-in user with everything their team roles allow.
  const actor = async (res: Response): Promise<Actor> => {
    const uid = res.locals.uid as string;
    return { uid, teams: await d.directory.teamsOf(uid), personal: true, canWritePersonal: true, canWriteTeams: true };
  };
  const team = (req: Request) => (typeof req.query.team === "string" && req.query.team ? req.query.team : null);

  // Secrets: names and values for the runs' environment; values are never sent back.
  r.get("/v1/app/routines/secrets", d.auth, async (req, res) => {
    try {
      res.json({ secrets: await d.routines.secrets(await actor(res), team(req)) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.put("/v1/app/routines/secrets/:name", d.auth, d.json, async (req, res) => {
    const name = SecretName.safeParse(req.params.name);
    if (!name.success) return badRequest(res, name.error);
    const value = SecretValue.safeParse(req.body?.value);
    if (!value.success) {
      res.status(400).json({ error: "bad_request", message: "Give the secret a value (up to 10,000 characters)." });
      return;
    }
    const slug = typeof req.body?.team === "string" && req.body.team ? req.body.team : null;
    try {
      await d.routines.setSecret(await actor(res), slug, name.data, value.data);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/routines/secrets/:name", d.auth, async (req, res) => {
    try {
      await d.routines.removeSecret(await actor(res), team(req), String(req.params.name));
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/routines", d.auth, async (_req, res) => {
    res.json(await d.routines.list(await actor(res)));
  });

  r.post("/v1/app/routines", d.auth, d.json, async (req, res) => {
    const body = RoutineInput.safeParse(req.body);
    if (!body.success) return badRequest(res, body.error);
    try {
      res.json({ routine: await d.routines.create(await actor(res), body.data, "app") });
    } catch (err) {
      fail(res, err);
    }
  });

  r.patch("/v1/app/routines/:id", d.auth, d.json, async (req, res) => {
    const body = RoutinePatch.safeParse(req.body);
    if (!body.success) return badRequest(res, body.error);
    try {
      res.json({ routine: await d.routines.update(await actor(res), id(req), body.data, "app") });
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/routines/:id", d.auth, async (req, res) => {
    try {
      await d.routines.remove(await actor(res), id(req));
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/app/routines/:id/run", d.auth, async (req, res) => {
    try {
      res.json({ routine: await d.routines.runNow(await actor(res), id(req)) });
    } catch (err) {
      fail(res, err);
    }
  });

  // The newest 20 unless `?limit=` asks for 1 to 50 (Convex keeps a routine's last 50): the
  // app's routine page polls for its 5 newest, its All Runs sheet for every one kept.
  r.get("/v1/app/routines/:id/runs", d.auth, async (req, res) => {
    const asked = Number(typeof req.query.limit === "string" ? req.query.limit : NaN);
    const limit = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 50) : 20;
    try {
      res.json({ runs: await d.routines.runs(await actor(res), id(req), limit) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/app/computers", d.auth, d.json, async (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Give the computer a name." });
      return;
    }
    try {
      res.json(await d.routines.addComputer(await actor(res), body.data.name));
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/computers/:id", d.auth, async (req, res) => {
    try {
      await d.routines.removeComputer(await actor(res), id(req));
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });
}

/** The computers' API, and the runner script itself (public: it holds no secrets). */
export function hostRouter(d: { routines: RoutineService; directory: Directory; runnerSource?: string }): Router {
  const r = express.Router();
  const json = express.json({ limit: "256kb" });
  // limiter() prunes only old entries: clearing the map when it filled up let anyone reset every
  // computer's and every address's count by sending enough distinct keys.
  const perHost = limiter(120);
  const perSetupAddress = limiter(10);

  r.get("/runner/ambient-runner.mjs", (_req, res) => {
    if (!d.runnerSource) {
      res.status(404).end();
      return;
    }
    res.type("text/javascript").set("cache-control", "no-store").send(d.runnerSource);
  });

  const host = async (req: Request, res: Response, next: NextFunction) => {
    const h = await d.routines.authenticate(req.headers.authorization);
    // A person's computer stops with their account; a team's server with its team (checked in Convex).
    if (!h || (h.uid && !(await d.directory.user(h.uid)))) {
      res.status(401).json({ error: "invalid_token", message: "This computer isn't connected anymore. Set it up again from the Ambient app." });
      return;
    }
    if (!perHost(h.id)) {
      res.status(429).json({ error: "slow_down" });
      return;
    }
    res.locals.host = h;
    next();
  };
  const hostOf = (res: Response) => res.locals.host as Host;

  r.post("/v1/host/setup", json, async (req, res) => {
    if (!perSetupAddress(req.ip ?? "?")) {
      res.status(429).json({ error: "slow_down" });
      return;
    }
    const body = z.object({ code: z.string().trim().min(4).max(20), info: HostInfo }).safeParse(req.body);
    if (!body.success) return badRequest(res, body.error);
    try {
      res.json(await d.routines.setup(body.data.code, body.data.info));
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/host/sync", json, host, async (req, res) => {
    const info = HostInfo.safeParse(req.body?.info);
    try {
      res.json(await d.routines.sync(hostOf(res), info.success ? info.data : undefined));
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/host/routines/:id/runs", host, async (req, res) => {
    try {
      res.json(await d.routines.startRun(hostOf(res), String(req.params.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/host/runs/:runId", json, host, async (req, res) => {
    const body = RunResult.safeParse(req.body);
    if (!body.success) return badRequest(res, body.error);
    try {
      await d.routines.finishRun(hostOf(res), String(req.params.runId), body.data);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  r.patch("/v1/host/runs/:runId", json, host, async (req, res) => {
    const body = RunProgress.safeParse(req.body);
    if (!body.success) return badRequest(res, body.error);
    try {
      await d.routines.updateRunProgress(hostOf(res), String(req.params.runId), body.data);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  return r;
}
