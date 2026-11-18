// HTTP for bots (docs/bots.md): the app's routes (features, a bot's thread, the chat with Ambient)
// and a run's own (asking its owner, with the run's token).
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { z } from "zod";
import type { Directory } from "../directory.ts";
import { RoutineError, type Actor, type RoutineService } from "../routines/service.ts";
import { limiter } from "../limiter.ts";
import { ChatAttachment, type AmbientChat } from "./ambient.ts";
import type { AdminService } from "./admin.ts";
import type { DecisionService } from "./decisions.ts";
import { ModelChoice } from "@brain/spec";
import type { BotService } from "./service.ts";
import type { AmbientComputers } from "./computer.ts";
import type { Host } from "../routines/service.ts";
import { FolderError, type BotFolder } from "./folder.ts";
import type { BotFiles } from "./files.ts";
import type { HistorySearch } from "./history.ts";
import { AutomationInput, TEMPLATES, type Automations } from "./automations.ts";

function fail(res: Response, err: unknown) {
  if (err instanceof RoutineError || err instanceof FolderError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  throw err;
}

const Text = z.object({ text: z.string().trim().min(1).max(8_000) });

export function botAppRoutes(
  r: Router,
  d: {
    routines: RoutineService;
    bots: BotService;
    ambient: AmbientChat;
    admin?: AdminService;
    decisions?: DecisionService;
    files?: BotFiles;
    folder?: BotFolder;
    automations?: () => Automations | undefined;
    directory: Directory;
    auth: RequestHandler;
    json: RequestHandler;
  },
) {
  const actor = async (res: Response): Promise<Actor> => {
    const uid = res.locals.uid as string;
    return { uid, teams: await d.directory.teamsOf(uid), personal: true, canWritePersonal: true, canWriteTeams: true };
  };
  const id = (req: Request) => String(req.params.id);
  const notEnabled = (res: Response) => res.status(403).json({ error: "bots_not_enabled", message: "Bots aren't switched on for this account yet." });

  // A computer's default model, and what Ambient may do there (docs/bots.md).
  // A bare `null` body clears it (express.json is strict about top-level values by default).
  r.put("/v1/app/computers/:id/model", d.auth, express.json({ strict: false, limit: "8kb" }), async (req, res) => {
    const body = ModelChoice.nullable().safeParse(req.body ?? null);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Pick a Claude model (claude-…), an effort and a fallback, or null for Claude Code's own." });
      return;
    }
    try {
      res.json({ computer: await d.routines.setModel(await actor(res), id(req), body.data) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.put("/v1/app/computers/:id/access", d.auth, d.json, async (req, res) => {
    const body = z.object({ access: z.enum(["standard", "admin", "full"]) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Access is standard, admin or full." });
      return;
    }
    try {
      res.json({ computer: await d.routines.setAccess(await actor(res), id(req), body.data.access) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/computers/:id/allowed", d.auth, d.json, async (req, res) => {
    const body = z.object({ command: z.string().min(1).max(4000) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Which command?" });
      return;
    }
    try {
      res.json({ computer: await d.routines.removeAllowed(await actor(res), id(req), body.data.command) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Decisions waiting for the person (docs/bots.md, "Decisions"): the stack, and answering one.
  r.get("/v1/app/decisions", d.auth, async (_req, res) => {
    const a = await actor(res);
    if (!d.decisions || !d.routines.botsEnabled(a)) return res.json({ decisions: [] });
    res.json({ decisions: await d.decisions.list(a.uid) });
  });

  r.post("/v1/app/decisions/:id", d.auth, d.json, async (req, res) => {
    const body = z.object({ option: z.string().min(1).max(4000).optional(), text: z.string().min(1).max(4000).optional() }).safeParse(req.body);
    const answer = body.success ? (body.data.option ?? body.data.text) : undefined;
    if (!answer || !d.decisions) {
      res.status(400).json({ error: "bad_request", message: "Pick an option or write an answer." });
      return;
    }
    try {
      res.json({ decision: await d.decisions.answer(await actor(res), id(req), answer, "app") });
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/approvals", d.auth, async (_req, res) => {
    if (!d.admin) return res.json({ approvals: [] });
    try {
      res.json({ approvals: await d.admin.list(await actor(res)) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/app/approvals/:id", d.auth, d.json, async (req, res) => {
    const body = z.object({ decision: z.enum(["once", "session", "always", "deny"]) }).safeParse(req.body);
    if (!body.success || !d.admin) {
      res.status(400).json({ error: "bad_request", message: "Decide once, session, always or deny." });
      return;
    }
    try {
      res.json({ approval: await d.admin.decide(await actor(res), id(req), body.data.decision) });
    } catch (err) {
      fail(res, err);
    }
  });

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

  // Files come along base64 (10 MB of files is about 14 MB of JSON).
  r.post("/v1/app/ambient/chat", d.auth, express.json({ limit: "16mb" }), async (req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) return notEnabled(res);
    const body = z.object({ text: z.string().max(8_000).default(""), attachments: z.array(ChatAttachment).max(4).default([]) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Write something (up to 8,000 characters), with up to 4 files." });
      return;
    }
    try {
      const name = (await d.directory.user(a.uid))?.name ?? "them";
      const { message, pending } = await d.ambient.send(a.uid, name, body.data.text, body.data.attachments);
      res.json({ message, pending });
    } catch (err) {
      fail(res, err);
    }
  });

  // "New chat" (the history stays findable), or ?forget=1: the whole history goes for good.
  r.delete("/v1/app/ambient/chat", d.auth, async (req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) return notEnabled(res);
    if (req.query.forget === "1" || req.query.forget === "true") await d.ambient.forget(a.uid);
    else await d.ambient.clear(a.uid, (await d.directory.user(a.uid))?.name);
    res.status(204).end();
  });

  // ---- automations (docs/bots.md, "Automations") ----

  const automations = async (res: Response): Promise<{ a: Actor; auto: Automations } | undefined> => {
    const a = await actor(res);
    const auto = d.automations?.();
    if (!d.routines.botsEnabled(a) || !auto) {
      notEnabled(res);
      return undefined;
    }
    return { a, auto };
  };

  r.get("/v1/app/automations", d.auth, async (_req, res) => {
    const x = await automations(res);
    if (!x) return;
    res.json({ templates: TEMPLATES, automations: await x.auto.list(x.a.uid) });
  });

  r.post("/v1/app/automations", d.auth, d.json, async (req, res) => {
    const x = await automations(res);
    if (!x) return;
    const body = AutomationInput.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Start from a template, or give a name, a trigger and instructions.", issues: body.error.issues.slice(0, 5).map((i) => i.path.join(".")) });
      return;
    }
    try {
      res.json({ automation: await x.auto.create(x.a.uid, body.data) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.patch("/v1/app/automations/:id", d.auth, d.json, async (req, res) => {
    const x = await automations(res);
    if (!x) return;
    const body = AutomationInput.omit({ template: true }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "That isn't a change to an automation.", issues: body.error.issues.slice(0, 5).map((i) => i.path.join(".")) });
      return;
    }
    try {
      res.json({ automation: await x.auto.update(x.a.uid, id(req), body.data) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/automations/:id", d.auth, async (req, res) => {
    const x = await automations(res);
    if (!x) return;
    try {
      await x.auto.remove(x.a.uid, id(req));
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  // Runs in the background (Amb may take a few minutes); the result shows in its runs.
  r.post("/v1/app/automations/:id/run", d.auth, async (req, res) => {
    const x = await automations(res);
    if (!x) return;
    try {
      await x.auto.get(x.a.uid, id(req));
      void x.auto.runNow(x.a.uid, id(req)).catch(() => undefined);
      res.status(202).json({ status: "started" });
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/automations/:id/runs", d.auth, async (req, res) => {
    const x = await automations(res);
    if (!x) return;
    try {
      res.json({ runs: await x.auto.runs(x.a.uid, id(req)) });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- a bot's folder: files, versions, handoffs (docs/bots.md, "A bot's folder") ----

  const files = d.files;
  const folder = d.folder;
  if (!files || !folder) return;
  const pathOf = (req: Request) => (typeof req.query.path === "string" ? req.query.path : "");
  const versionOf = (v: unknown) => {
    const n = Number(typeof v === "string" ? v : v === undefined ? NaN : v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const Write = z.object({ content: z.string().max(300_000), why: z.string().trim().max(500).optional() });
  const userBy = async (uid: string) => ({ kind: "user" as const, name: (await d.directory.user(uid))?.name ?? null });

  r.get("/v1/app/routines/:id/files", d.auth, async (req, res) => {
    try {
      res.json({ files: (await files.list(await actor(res), id(req))).files });
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/routines/:id/files/content", d.auth, async (req, res) => {
    try {
      res.json(await files.read(await actor(res), id(req), pathOf(req), versionOf(req.query.version)));
    } catch (err) {
      fail(res, err);
    }
  });

  r.put("/v1/app/routines/:id/files/content", d.auth, express.json({ limit: "1mb" }), async (req, res) => {
    const body = Write.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Send the file's content (and optionally why)." });
      return;
    }
    try {
      const a = await actor(res);
      res.json(await files.write(a, id(req), pathOf(req), body.data.content, await userBy(a.uid), body.data.why ?? null, "app"));
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/routines/:id/files/content", d.auth, async (req, res) => {
    try {
      const a = await actor(res);
      await files.remove(a, id(req), pathOf(req), await userBy(a.uid), null);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/routines/:id/files/history", d.auth, async (req, res) => {
    try {
      res.json({ versions: await files.history(await actor(res), id(req), pathOf(req)) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/app/routines/:id/files/revert", d.auth, d.json, async (req, res) => {
    const body = z.object({ path: z.string().max(200), version: z.number().int().min(1) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Say which file and which version." });
      return;
    }
    try {
      const a = await actor(res);
      res.json(await files.revert(a, id(req), body.data.path, body.data.version, await userBy(a.uid), "app"));
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/routines/:id/handoffs", d.auth, async (req, res) => {
    const asked = Number(typeof req.query.limit === "string" ? req.query.limit : NaN);
    try {
      res.json({ handoffs: await files.handoffs(await actor(res), id(req), Number.isInteger(asked) ? asked : 10) });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Amb's memory of the person (docs/bots.md, "Amb's memory") ----

  r.get("/v1/app/ambient/memory", d.auth, async (req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) return notEnabled(res);
    const version = versionOf(req.query.version);
    try {
      res.json(version ? await folder.ambMemoryVersion(a.uid, version) : await folder.ambMemory(a.uid));
    } catch (err) {
      fail(res, err);
    }
  });

  r.put("/v1/app/ambient/memory", d.auth, d.json, async (req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) return notEnabled(res);
    const body = Write.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Send the memory's content (and optionally why)." });
      return;
    }
    try {
      res.json(await folder.writeAmbMemory(a.uid, body.data.content, await userBy(a.uid), body.data.why ?? null));
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/ambient/memory/history", d.auth, async (_req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) return notEnabled(res);
    res.json({ versions: await folder.ambHistory(a.uid) });
  });

  r.post("/v1/app/ambient/memory/revert", d.auth, d.json, async (req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) return notEnabled(res);
    const body = z.object({ version: z.number().int().min(1) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Say which version." });
      return;
    }
    try {
      const old = await folder.ambMemoryVersion(a.uid, body.data.version);
      res.json(await folder.writeAmbMemory(a.uid, old.content, await userBy(a.uid), `restored version ${body.data.version}`));
    } catch (err) {
      fail(res, err);
    }
  });
}

/** A bot's run asks its owner (the runner's ask_owner tool), with its run token. */
export function botRunRouter(d: { bots: BotService; history?: HistorySearch }): Router {
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

  // search_history for a run: its own thread and handoffs (docs/bots.md, "The computer's side").
  r.get("/v1/bot/history", async (req, res) => {
    if (slowDown(req, res)) return;
    if (!d.history) {
      res.status(404).json({ error: "not_found", message: "History search isn't on here." });
      return;
    }
    const q = (k: string) => (typeof req.query[k] === "string" ? String(req.query[k]).slice(0, 200) : undefined);
    try {
      res.json({ results: await d.history.forRun(req.headers.authorization, { q: q("q"), from: q("from"), to: q("to"), limit: Number(q("limit") ?? 20) || 20 }) });
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
    // A person's computer stops with their account; a team's server with its team (checked in Convex).
    if (!h || (h.uid && !(await d.directory.user(h.uid)))) {
      res.status(401).json({ error: "invalid_token", message: "This computer isn't connected anymore. Set it up again from the Ambient app." });
      return undefined;
    }
    if (!(await d.routines.ambientOn(h))) {
      res.status(403).json({ error: "bots_not_enabled", message: "Ambient isn't switched on for this account." });
      return undefined;
    }
    return h;
  };

  r.get("/v1/host/ambient/next", async (req, res) => {
    const h = await host(req, res);
    if (!h) return;
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
