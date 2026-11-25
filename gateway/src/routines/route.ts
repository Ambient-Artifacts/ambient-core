// HTTP for routines: the app's routes (/v1/app/routines, /v1/app/computers), the computers'
// own API (/v1/host/*, with a computer token), and the runner script they download.
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import { z } from "zod";
import type { Directory } from "../directory.ts";
import { ClaudeToken, HostInfo, RoutineError, RoutineInput, RoutinePatch, RunProgress, RunResult, SecretName, SecretValue, secretNameProblem, type Actor, type Host, type RoutineService } from "./service.ts";
import { addressKey, limiter } from "../limiter.ts";
import type { TeamBundle } from "../team-bundle.ts";
import type { LiveText } from "../bots/live.ts";

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
    if (!name.success) {
      res.status(400).json({ error: "bad_request", message: secretNameProblem(name.error) });
      return;
    }
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
    const body = z.object({ name: z.string().trim().min(1).max(60), team: z.string().regex(/^[a-z0-9-]{1,40}$/).optional() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Give the computer a name." });
      return;
    }
    try {
      res.json(await d.routines.addComputer(await actor(res), body.data.name, body.data.team));
    } catch (err) {
      fail(res, err);
    }
  });

  // Whose Claude the computer uses: a plan token or API key goes in here only, never through a chat.
  r.put("/v1/app/computers/:id/claude", d.auth, d.json, async (req, res) => {
    const body = ClaudeToken.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_token", message: "Paste a Claude plan token (from claude setup-token) or an Anthropic API key." });
      return;
    }
    try {
      res.json({ computer: await d.routines.setClaude(await actor(res), id(req), body.data.kind, body.data.token) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/app/computers/:id/claude/use", d.auth, d.json, async (req, res) => {
    const body = z.object({ use: z.enum(["plan", "key", "computer"]) }).safeParse(req.body);
    if (!body.success) return badRequest(res, body.error);
    try {
      res.json({ computer: await d.routines.useClaude(await actor(res), id(req), body.data.use) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/computers/:id/claude/:kind", d.auth, async (req, res) => {
    const kind = z.enum(["plan", "key"]).safeParse(req.params.kind);
    if (!kind.success) return badRequest(res, kind.error);
    try {
      res.json({ computer: await d.routines.removeClaude(await actor(res), id(req), kind.data) });
    } catch (err) {
      fail(res, err);
    }
  });

  // How the computer's Codex bots sign in to OpenAI (docs/bots.md, "Codex next to Claude Code"):
  // an API key goes in here only; the ChatGPT plan is signed in on the computer (…/openai/login).
  r.put("/v1/app/computers/:id/openai", d.auth, d.json, async (req, res) => {
    const body = z.object({ key: z.string().trim().min(20).max(400) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_openai_key", message: "Paste an OpenAI API key (sk-…)." });
      return;
    }
    try {
      res.json({ computer: await d.routines.setOpenAIKey(await actor(res), id(req), body.data.key) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/app/computers/:id/openai/use", d.auth, d.json, async (req, res) => {
    const body = z.object({ use: z.enum(["plan", "key"]) }).safeParse(req.body);
    if (!body.success) return badRequest(res, body.error);
    try {
      res.json({ computer: await d.routines.useOpenAI(await actor(res), id(req), body.data.use) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/computers/:id/openai/key", d.auth, async (req, res) => {
    try {
      res.json({ computer: await d.routines.removeOpenAIKey(await actor(res), id(req)) });
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
const LiveUpdate = z.object({ seq: z.number().int().min(0), text: z.string().max(40_000), tool: z.string().max(1_000).nullable().optional() });

export function hostRouter(d: { routines: RoutineService; directory: Directory; runnerSource?: string; installSource?: string; teamBundle?: () => Promise<TeamBundle>; live?: LiveText }): Router {
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

  // The team's brain for a team's own computer (team-bundle.ts): open source, so not behind a token;
  // the runner checks its sha256 from sync before running it.
  r.get("/runner/ambient-team.mjs", async (_req, res) => {
    if (!d.teamBundle) {
      res.status(404).end();
      return;
    }
    try {
      const b = await d.teamBundle();
      res.type("text/javascript").set({ "cache-control": "no-store", "x-ambient-sha256": b.sha256, "x-ambient-version": b.version }).send(b.source);
    } catch (err) {
      console.error(`[gateway] building the team brain failed: ${(err as Error).message}`);
      res.status(503).json({ error: "unavailable", message: "The team's brain couldn't be built here." });
    }
  });

  // The one-line setup: curl -fsSL <origin>/install.sh | sudo bash -s <code> (runner/install.sh).
  r.get("/install.sh", (_req, res) => {
    if (!d.installSource) {
      res.status(404).end();
      return;
    }
    res.type("text/x-shellscript").set("cache-control", "no-store").send(d.installSource);
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

  // Live text has a limit of its own (bots/live.ts): a few updates a second while a bot writes
  // would use up the computer's 120 a minute within half a minute, and its result and everything
  // else would get 429s (Reviewi on #80). And the computer is looked up once per 30 seconds, not
  // on every update.
  const perLive = limiter(600);
  const liveHosts = new Map<string, { host: Host; at: number }>();
  const hostLive = async (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers.authorization ?? "";
    const now = Date.now();
    let h = liveHosts.get(key);
    if (!h || now - h.at > 30_000) {
      const found = await d.routines.authenticate(key);
      if (!found || (found.uid && !(await d.directory.user(found.uid)))) {
        liveHosts.delete(key);
        res.status(401).json({ error: "invalid_token" });
        return;
      }
      if (liveHosts.size > 1_000) liveHosts.clear();
      h = { host: found, at: now };
      liveHosts.set(key, h);
    }
    if (!perLive(h.host.id)) {
      res.status(429).json({ error: "slow_down" });
      return;
    }
    res.locals.host = h.host;
    next();
  };

  r.post("/v1/host/setup", json, async (req, res) => {
    if (!perSetupAddress(addressKey(req.ip))) {
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

  r.post("/v1/host/sync", host, json, async (req, res) => {
    const info = HostInfo.safeParse(req.body?.info);
    try {
      res.json(await d.routines.sync(hostOf(res), info.success ? info.data : undefined));
    } catch (err) {
      fail(res, err);
    }
  });

  // The computer's chosen Claude sign-in, fetched when sync's `claude` version changes.
  r.get("/v1/host/claude", host, async (_req, res) => {
    try {
      res.set("cache-control", "no-store").json(await d.routines.hostClaude(hostOf(res)));
    } catch (err) {
      fail(res, err);
    }
  });

  // The computer stores its own Claude plan (install.sh, after `claude setup-token` there).
  r.post("/v1/host/claude", host, json, async (req, res) => {
    const body = ClaudeToken.safeParse(req.body);
    if (!body.success) return badRequest(res, body.error);
    try {
      await d.routines.hostSetClaude(hostOf(res), body.data.kind, body.data.token);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  // The computer's stored OpenAI key for its Codex bots, fetched when sync's `openai` version changes.
  r.get("/v1/host/openai", host, async (_req, res) => {
    try {
      res.set("cache-control", "no-store").json(await d.routines.hostOpenAI(hostOf(res)));
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

  r.post("/v1/host/runs/:runId", host, json, async (req, res) => {
    const body = RunResult.safeParse(req.body);
    if (!body.success) return badRequest(res, body.error);
    try {
      await d.routines.finishRun(hostOf(res), String(req.params.runId), body.data);
      // Its message is in the thread now: the readers drop the live text (bots/live.ts).
      d.live?.end(String(req.params.runId));
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  // The text a bot's run is writing, a few times a second (docs/bots.md, "Live text"). In memory
  // only; 404 for a run that isn't this computer's or is over, and the runner stops sending.
  r.post("/v1/host/runs/:runId/live", hostLive, json, async (req, res) => {
    const body = LiveUpdate.safeParse(req.body);
    if (!body.success) return badRequest(res, body.error);
    if (!d.live) return res.status(404).json({ error: "no_live_text" });
    try {
      const ok = await d.live.update(hostOf(res).id, String(req.params.runId), body.data);
      if (ok) res.status(204).end();
      else res.status(404).json({ error: "no_such_run" });
    } catch (err) {
      fail(res, err);
    }
  });

  r.patch("/v1/host/runs/:runId", host, json, async (req, res) => {
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
