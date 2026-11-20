// HTTP for bots (docs/bots.md): the app's routes (features, a bot's thread, the chat with Ambient)
// and a run's own (asking its owner, with the run's token).
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { z } from "zod";
import type { Directory } from "../directory.ts";
import { RoutineError, type Actor, type RoutineService } from "../routines/service.ts";
import { limiter } from "../limiter.ts";
import { ChatAttachment, checkAttachments, type AmbientChat } from "./ambient.ts";
import type { AdminService } from "./admin.ts";
import type { DecisionService } from "./decisions.ts";
import { ModelChoice } from "@brain/spec";
import type { BotService } from "./service.ts";
import type { AmbientComputers } from "./computer.ts";
import type { Host } from "../routines/service.ts";
import { FolderError, type BotFolder } from "./folder.ts";
import type { BotFiles } from "./files.ts";
import type { Wakes } from "./wakes.ts";
import type { HistorySearch } from "./history.ts";
import { AutomationInput, TEMPLATES, type Automations } from "./automations.ts";
import { GitHubError, WATCH_MODES, type GitHubEvents } from "./github.ts";
import { page as githubPage, type GitHubApps } from "./github-apps.ts";
import { LEARN, lessonsOf, type BotLearning } from "./learning.ts";
import { NOTIFY, type AmbSettings } from "./amb-settings.ts";
import { FromTemplate, createFromTemplate, templateViews } from "./bot-templates.ts";
import { passHeaders } from "../relay.ts";

function fail(res: Response, err: unknown) {
  if (err instanceof RoutineError || err instanceof FolderError || err instanceof GitHubError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  throw err;
}

const Text = z.object({ text: z.string().trim().min(1).max(8_000) });
/** A message to a bot: text, files, or both (files: bots/attachments.ts). */
const ThreadPost = z.object({ text: z.string().trim().max(8_000).default(""), attachments: z.array(ChatAttachment).max(4).default([]) });

/** A kept file, as its owner sent it: inline (images, PDFs show in place), cached for good (its id never changes). */
function sendFile(res: Response, file: { name: string; type: string; bytes: Buffer }) {
  res
    .type(file.type)
    .set({
      "cache-control": "private, max-age=31536000, immutable",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      // A text file or a PDF never runs anything of ours: shown in a sandbox of its own.
      "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    })
    .send(file.bytes);
}


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
    github?: () => GitHubEvents | undefined;
    githubApp?: () => GitHubApps | undefined;
    learning?: () => BotLearning | undefined;
    ambSettings?: () => AmbSettings | undefined;
    wakes?: () => Wakes | undefined;
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
  // Codex's ChatGPT sign-in on a computer (docs/bots.md, "Codex next to Claude Code").
  r.post("/v1/app/computers/:id/openai/login", d.auth, async (req, res) => {
    if (!d.admin) {
      res.status(404).json({ error: "not_found", message: "This server can't sign Codex in on computers." });
      return;
    }
    try {
      res.json(await d.admin.codexLogin(await actor(res), id(req)));
    } catch (err) {
      fail(res, err);
    }
  });

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
    const bots = d.routines.botsEnabled(await actor(res));
    // With bots every loop is a bot (docs/bots.md, "Loops are bots"): the app has no plain loops then.
    res.json({ bots, loopsAreBots: bots });
  });

  // A bot's wake-ups (docs/bots.md, "Wake-ups"): whoever sees it sees them, whoever may change it books and cancels.
  r.get("/v1/app/routines/:id/wakes", d.auth, async (req, res) => {
    const wakes = d.wakes?.();
    if (!wakes) return notEnabled(res);
    try {
      res.json(await wakes.listFor(await actor(res), id(req)));
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/app/routines/:id/wakes", d.auth, d.json, async (req, res) => {
    const wakes = d.wakes?.();
    if (!wakes) return notEnabled(res);
    const body = z.object({ at: z.string().trim().min(1).max(64), note: z.string().trim().min(1).max(2_000) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Pick a time and say what the bot should do then." });
      return;
    }
    try {
      res.json({ wake: await wakes.bookFor(await actor(res), id(req), body.data.at, body.data.note) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/routines/:id/wakes/:wake", d.auth, async (req, res) => {
    const wakes = d.wakes?.();
    if (!wakes) return notEnabled(res);
    try {
      const who = await actor(res);
      await wakes.cancelFor(who, id(req), String(req.params.wake), (await d.directory.user(who.uid).catch(() => null))?.name ?? "owner");
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/routines/:id/thread", d.auth, async (req, res) => {
    const asked = Number(typeof req.query.limit === "string" ? req.query.limit : NaN);
    const limit = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 100) : 50;
    try {
      res.json(await d.bots.thread(await actor(res), id(req), limit, { markSeen: true }));
    } catch (err) {
      fail(res, err);
    }
  });

  // Files come along base64, as in Ambient's chat (10 MB of files is about 14 MB of JSON).
  r.post("/v1/app/routines/:id/thread", d.auth, express.json({ limit: "16mb" }), async (req, res) => {
    const body = ThreadPost.safeParse(req.body);
    if (!body.success || (!body.data.text && !body.data.attachments.length)) {
      res.status(400).json({ error: "bad_request", message: "Write something first (up to 8,000 characters), with up to 4 files." });
      return;
    }
    try {
      const a = await actor(res);
      if (body.data.attachments.length) {
        res.json(await d.bots.post(a, id(req), body.data.text, { files: checkAttachments(body.data.attachments) }));
        return;
      }
      res.json(await d.bots.receive(a, { channel: "app", uid: a.uid, target: { kind: "bot", botId: id(req) }, text: body.data.text }));
    } catch (err) {
      fail(res, err);
    }
  });

  // A file sent in a bot's thread, to whoever may read the thread.
  r.get("/v1/app/routines/:id/thread/files/:file", d.auth, async (req, res) => {
    try {
      sendFile(res, await d.bots.file(await actor(res), id(req), String(req.params.file)));
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

  // A file sent in the person's chat with Ambient (only theirs).
  r.get("/v1/app/ambient/chat/files/:file", d.auth, async (req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) return notEnabled(res);
    try {
      sendFile(res, await d.ambient.file(a.uid, String(req.params.file)));
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

  // ---- GitHub: the owner's webhook, and which repos a bot watches (docs/bots.md, "GitHub events and the PR gate") ----

  const teamOf = (req: Request) => (typeof req.query.team === "string" && req.query.team ? req.query.team : null);

  r.get("/v1/app/github-hook", d.auth, async (req, res) => {
    const gh = d.github?.();
    if (!gh) return notEnabled(res);
    try {
      res.json(await gh.hook(d.routines.botOwner(await actor(res), teamOf(req))));
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/app/github-hook/rotate", d.auth, async (req, res) => {
    const gh = d.github?.();
    if (!gh) return notEnabled(res);
    try {
      res.json(await gh.rotate(d.routines.botOwner(await actor(res), teamOf(req))));
    } catch (err) {
      fail(res, err);
    }
  });

  // Connect GitHub: Ambient's GitHub App (docs/bots.md, "Connect GitHub").
  // `routine`: the bot whose GitHub step asks, so the App it works through is the one offered
  // (its own, its role's, or the shared one; docs/bots.md, "GitHub Apps").
  const routineOf = (req: Request) => (typeof req.query.routine === "string" && req.query.routine ? req.query.routine : null);

  r.get("/v1/app/github", d.auth, async (req, res) => {
    try {
      const a = await actor(res);
      const owner = d.routines.botOwner(a, teamOf(req));
      const gha = d.githubApp?.();
      if (!gha || !(await gha.any())) return res.json({ app: null, installations: [] });
      const rid = routineOf(req);
      const gh = d.github?.();
      let forBot: { app: string; slug: string; role: string; connected: boolean } | null = null;
      if (rid && gh) {
        const f = await d.routines.folderOf(a, rid, false);
        const bot = { id: rid, ...(await gh.watchOf(f.owner, rid)) };
        const meant = await gha.intendedFor(bot);
        if (meant) forBot = { app: meant.key, slug: meant.slug, role: meant.role, connected: (await gha.appFor(f.owner, bot))?.key === meant.key };
      }
      const shared = gha.shared;
      res.json({ app: { slug: (forBot?.slug ?? shared?.slug ?? (await gha.list())[0]?.slug) as string, configured: true }, apps: await gha.list(), forBot, installations: await gha.installations(owner) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/app/github/connect", d.auth, async (req, res) => {
    const gha = d.githubApp?.();
    if (!gha || !(await gha.any())) return res.status(404).json({ error: "not_set_up", message: "Connect GitHub isn't set up on this server; use the webhook instead." });
    try {
      const a = await actor(res);
      const rid = routineOf(req);
      const gh = d.github?.();
      if (rid && gh) {
        const f = await d.routines.folderOf(a, rid, true);
        const meant = await gha.intendedFor(await gh.watchOf(f.owner, rid));
        if (!meant) return res.status(404).json({ error: "not_set_up", message: "Connect GitHub isn't set up on this server; use the webhook instead." });
        return res.json({ url: meant.connectUrl(f.owner, a.uid), app: meant.slug });
      }
      const shared = gha.shared;
      if (!shared) return res.status(404).json({ error: "not_set_up", message: "Connect GitHub from a bot's GitHub settings." });
      res.json({ url: shared.connectUrl(d.routines.botOwner(a, teamOf(req)), a.uid), app: shared.slug });
    } catch (err) {
      fail(res, err);
    }
  });

  // A bot's own GitHub App (its own GitHub user): GitHub's manifest flow, then its install.
  r.post("/v1/app/routines/:id/github/app", d.auth, d.json, async (req, res) => {
    const gha = d.githubApp?.();
    const gh = d.github?.();
    if (!gha || !gh) return res.status(404).json({ error: "not_set_up", message: "GitHub isn't set up on this server." });
    const body = z.object({ account: z.string().trim().max(39).optional() }).safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: "bad_request", message: "Say which GitHub account its repos are in." });
    try {
      const a = await actor(res);
      const f = await d.routines.folderOf(a, id(req), true);
      res.json({ url: await gha.ownAppLink(f.owner, { id: f.routineId, name: f.name }, a.uid, body.data.account) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/github/installations/:id", d.auth, async (req, res) => {
    const gha = d.githubApp?.();
    if (!gha) return res.status(404).json({ error: "not_set_up", message: "Connect GitHub isn't set up on this server." });
    try {
      const owner = d.routines.botOwner(await actor(res), teamOf(req));
      const ok = await gha.unlink(owner, Number(req.params.id));
      if (!ok) return res.status(404).json({ error: "no_such_installation", message: "There's no such connection." });
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/routines/:id/github", d.auth, async (req, res) => {
    const gh = d.github?.();
    if (!gh) return notEnabled(res);
    try {
      const f = await d.routines.folderOf(await actor(res), id(req), false);
      res.json({ ...(await gh.watchOf(f.owner, f.routineId)), branchPrefix: await gh.prefixOf(f.owner, f.routineId) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.put("/v1/app/routines/:id/github", d.auth, d.json, async (req, res) => {
    const gh = d.github?.();
    if (!gh) return notEnabled(res);
    const body = z.object({ repos: z.array(z.string().max(200)).max(20), on: z.array(z.enum(WATCH_MODES)).min(1).max(3).optional() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: `Send the repos as a list of owner/name, and optionally on: ${WATCH_MODES.join(", ")}.` });
      return;
    }
    try {
      const f = await d.routines.folderOf(await actor(res), id(req), true);
      await gh.setWatch(f.owner, f.routineId, body.data.repos, body.data.on);
      res.json({ ...(await gh.watchOf(f.owner, f.routineId)), branchPrefix: await gh.prefixOf(f.owner, f.routineId) });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- how a bot learns (docs/bots.md, "How bots learn") ----

  r.get("/v1/app/routines/:id/learning", d.auth, async (req, res) => {
    const l = d.learning?.();
    if (!l) return notEnabled(res);
    try {
      const f = await d.routines.folderOf(await actor(res), id(req), false);
      res.json(await l.view(f.owner, f.routineId));
    } catch (err) {
      fail(res, err);
    }
  });

  r.put("/v1/app/routines/:id/learning", d.auth, d.json, async (req, res) => {
    const l = d.learning?.();
    if (!l) return notEnabled(res);
    const body = z.object({ learn: z.enum(LEARN) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: `Send learn: ${LEARN.join(" or ")}.` });
      return;
    }
    try {
      const f = await d.routines.folderOf(await actor(res), id(req), true);
      await l.setLearn(f.owner, f.routineId, body.data.learn);
      res.json(await l.view(f.owner, f.routineId));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Amb's settings (docs/bots.md, "Amb's settings") ----

  r.get("/v1/app/ambient/settings", d.auth, async (_req, res) => {
    const a = await actor(res);
    const st = d.ambSettings?.();
    if (!d.routines.botsEnabled(a) || !st) return notEnabled(res);
    res.json(await st.get(a.uid));
  });

  r.put("/v1/app/ambient/settings", d.auth, d.json, async (req, res) => {
    const a = await actor(res);
    const st = d.ambSettings?.();
    if (!d.routines.botsEnabled(a) || !st) return notEnabled(res);
    const body = z.object({ notify: z.enum(NOTIFY).optional() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: `Send notify: ${NOTIFY.join(" or ")}.` });
      return;
    }
    res.json(await st.set(a.uid, body.data));
  });

  // ---- bot templates (docs/bots.md, "Bot templates") ----

  r.get("/v1/app/bot-templates", d.auth, async (_req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) return notEnabled(res);
    res.json({ templates: templateViews() });
  });

  r.post("/v1/app/bots/from-template", d.auth, d.json, async (req, res) => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a) || !d.folder) return notEnabled(res);
    const body = FromTemplate.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Pick a template and answer its questions.", issues: body.error.issues.slice(0, 5).map((i) => i.path.join(".")) });
      return;
    }
    try {
      const name = (await d.directory.user(a.uid))?.name ?? null;
      res.json(await createFromTemplate({ routines: d.routines, folder: d.folder, github: d.github?.(), learning: d.learning?.(), githubApp: d.githubApp?.() }, a, body.data, { source: "app", enabled: true, by: { kind: "user", name } }));
    } catch (err) {
      fail(res, err);
    }
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
      const a = await actor(res);
      const [{ files: list }, mirror] = await Promise.all([files.list(a, id(req)), files.mirrorStatus(a, id(req)).catch(() => null)]);
      res.json({ files: list, mirror });
    } catch (err) {
      fail(res, err);
    }
  });

  // The bot's folder (and its owner's other bots) into git now (docs/bots.md, "A bot's folder in git").
  r.post("/v1/app/routines/:id/files/mirror", d.auth, async (req, res) => {
    try {
      res.json({ mirror: await files.mirrorNow(await actor(res), id(req)) });
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

  // ---- Amb's own folder, like a bot's (docs/bots.md, "One folder for every bot, Amb included") ----

  /** The person, when bots are on for them (Amb's folder is theirs alone). */
  const amb = async (res: Response): Promise<Actor | undefined> => {
    const a = await actor(res);
    if (!d.routines.botsEnabled(a)) {
      notEnabled(res);
      return undefined;
    }
    return a;
  };

  r.get("/v1/app/ambient/files", d.auth, async (_req, res) => {
    const a = await amb(res);
    if (!a) return;
    try {
      res.json({ files: await folder.ambFiles(a.uid) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/ambient/files/content", d.auth, async (req, res) => {
    const a = await amb(res);
    if (!a) return;
    try {
      res.json(await folder.ambRead(a.uid, pathOf(req), versionOf(req.query.version)));
    } catch (err) {
      fail(res, err);
    }
  });

  r.put("/v1/app/ambient/files/content", d.auth, express.json({ limit: "1mb" }), async (req, res) => {
    const a = await amb(res);
    if (!a) return;
    const body = Write.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Send the file's content (and optionally why)." });
      return;
    }
    try {
      res.json(await folder.ambWrite(a.uid, pathOf(req), body.data.content, await userBy(a.uid), body.data.why ?? null));
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/app/ambient/files/content", d.auth, async (req, res) => {
    const a = await amb(res);
    if (!a) return;
    try {
      await folder.ambRemove(a.uid, pathOf(req), await userBy(a.uid), null);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/v1/app/ambient/files/history", d.auth, async (req, res) => {
    const a = await amb(res);
    if (!a) return;
    try {
      res.json({ versions: await folder.ambFileHistory(a.uid, pathOf(req)) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/app/ambient/files/revert", d.auth, d.json, async (req, res) => {
    const a = await amb(res);
    if (!a) return;
    const body = z.object({ path: z.string().max(200), version: z.number().int().min(1) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Say which file and which version." });
      return;
    }
    try {
      res.json(await folder.ambRevert(a.uid, body.data.path, body.data.version, await userBy(a.uid)));
    } catch (err) {
      fail(res, err);
    }
  });

  // What Amb learned about the person, and what changed in its folder lately.
  r.get("/v1/app/ambient/learning", d.auth, async (_req, res) => {
    const a = await amb(res);
    if (!a) return;
    try {
      const memory = await folder.ambText(a.uid, "memory.md");
      const files = await folder.ambFiles(a.uid);
      const changes: { path: string; version: number; by: { kind: string; name: string | null }; why: string | null; at: number }[] = [];
      for (const f of files.filter((x) => x.version > 0)) {
        for (const v of (await folder.ambFileHistory(a.uid, f.path).catch(() => [])).slice(0, 10)) changes.push({ path: f.path, version: v.version, by: v.by, why: v.why, at: v.updatedAt });
      }
      res.json({ lessons: lessonsOf(memory), changes: changes.sort((x, y) => y.at - x.at).slice(0, 20) });
    } catch (err) {
      fail(res, err);
    }
  });
}

/** A bot's run asks its owner (the runner's ask_owner tool), with its run token. */
export function botRunRouter(d: { bots: BotService; history?: HistorySearch; wakes?: Wakes }): Router {
  const r = express.Router();
  const json = express.json({ limit: "64kb" });
  const perRun = limiter(120);
  const slowDown = (req: Request, res: Response) => {
    const key = (req.headers.authorization ?? "").slice(-16);
    if (perRun(key)) return false;
    res.status(429).json({ error: "slow_down" });
    return true;
  };

  r.post("/v1/bot/ask", express.json({ limit: "16mb" }), async (req, res) => {
    if (slowDown(req, res)) return;
    const body = z
      .object({ question: z.string().trim().min(1).max(2_000), choices: z.array(z.string().max(120)).max(6).optional(), details: z.string().max(20_000).optional(), files: z.array(ChatAttachment).max(4).default([]) })
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Ask a question (up to 2,000 characters), with up to 6 choices and up to 20,000 characters of details." });
      return;
    }
    try {
      res.json(await d.bots.ask(req.headers.authorization, body.data.question, body.data.choices, body.data.details, checkAttachments(body.data.files)));
    } catch (err) {
      fail(res, err);
    }
  });

  // search_history for a run: its own thread and handoffs (docs/bots.md, "The computer's side").
  // A file that came with the message that started this run (its run token): the runner puts it in the run's folder.
  r.get("/v1/bot/files/:file", async (req, res) => {
    try {
      const file = await d.bots.runFile(req.headers.authorization, String(req.params.file));
      res.type(file.type).set("cache-control", "no-store").send(file.bytes);
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      res.status(e.status ?? 500).json({ error: e.code ?? "failed", message: e.message });
    }
  });

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

  // Messages that came in while the run works, and its answers to them (docs/bots.md).
  r.get("/v1/bot/inbox", async (req, res) => {
    if (slowDown(req, res)) return;
    const after = Number(typeof req.query.after === "string" ? req.query.after : NaN);
    try {
      res.json(await d.bots.inbox(req.headers.authorization, Number.isFinite(after) ? after : undefined));
    } catch (err) {
      fail(res, err);
    }
  });

  // A run's message while it works: an answer, or files it made for its owner (send_file).
  r.post("/v1/bot/reply", express.json({ limit: "16mb" }), async (req, res) => {
    if (slowDown(req, res)) return;
    const body = z
      .object({ text: z.string().trim().max(20_000).default(""), files: z.array(ChatAttachment).max(4).default([]) })
      .refine((b) => b.text.length > 0 || b.files.length > 0)
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Send the answer's text, or files (up to 4)." });
      return;
    }
    try {
      await d.bots.runReply(req.headers.authorization, body.data.text, checkAttachments(body.data.files));
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  // Wake-ups a run books for its bot (the runner's wake_me and cancel_wake_up; bots/wakes.ts).
  r.get("/v1/bot/wakes", async (req, res) => {
    if (slowDown(req, res)) return;
    if (!d.wakes) return void res.status(404).json({ error: "not_found", message: "Wake-ups aren't on here." });
    try {
      res.json({ wakes: await d.wakes.list(req.headers.authorization) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.post("/v1/bot/wakes", json, async (req, res) => {
    if (slowDown(req, res)) return;
    if (!d.wakes) return void res.status(404).json({ error: "not_found", message: "Wake-ups aren't on here." });
    const body = z.object({ at: z.string().trim().min(1).max(64), note: z.string().trim().min(1).max(2_000) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Pass at (a time, e.g. 2026-11-24 09:00) and note (what to do then, up to 2,000 characters)." });
      return;
    }
    try {
      res.json(await d.wakes.book(req.headers.authorization, body.data.at, body.data.note));
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/v1/bot/wakes/:id", async (req, res) => {
    if (slowDown(req, res)) return;
    if (!d.wakes) return void res.status(404).json({ error: "not_found", message: "Wake-ups aren't on here." });
    try {
      await d.wakes.cancel(req.headers.authorization, String(req.params.id));
      res.status(204).end();
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

  // The team server's answer to a relayed request (relay.ts), as is: status and headers in ours.
  r.post("/v1/host/relay/:jobId", express.raw({ type: () => true, limit: "32mb" }), async (req, res) => {
    const h = await host(req, res);
    if (!h) return;
    const id = String(req.params.jobId);
    const error = req.header("x-ambient-error") ? Buffer.from(req.header("x-ambient-error")!, "base64").toString("utf8") : undefined;
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(Buffer.from(req.header("x-ambient-headers") ?? "", "base64").toString("utf8")) as Record<string, string>;
    } catch {}
    const status = Number(req.header("x-ambient-status"));
    const ok = error
      ? d.computers.relayed(h.id, id, { error: error.slice(0, 500) })
      : d.computers.relayed(h.id, id, { status: status >= 100 && status < 600 ? status : 502, headers: passHeaders(headers), body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) });
    res.status(ok ? 204 : 404).end();
  });

  // Ambient's reply from the computer, with the files it put in its outbox for the person.
  r.post("/v1/host/ambient/:jobId", express.json({ limit: "16mb" }), async (req, res) => {
    const h = await host(req, res);
    if (!h) return;
    const body = z.object({ text: z.string().max(100_000).optional(), error: z.string().max(2_000).optional(), files: z.array(ChatAttachment).max(4).optional() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Send the reply's text, or what went wrong." });
      return;
    }
    const id = String(req.params.jobId);
    let files: ChatAttachment[] = [];
    try {
      files = checkAttachments(body.data.files ?? []);
    } catch (err) {
      // Files that can't go with a message (a type or size the chat doesn't take): the text still does.
      console.warn(`[ambient] files from ${h.name} left out: ${(err as Error).message}`);
    }
    const ok = body.data.error !== undefined ? d.computers.fail(h.id, id, body.data.error) : d.computers.reply(h.id, id, body.data.text ?? "", files);
    if (!ok) {
      res.status(404).json({ error: "no_such_message", message: "That message isn't waiting for a reply anymore." });
      return;
    }
    res.status(204).end();
  });

  return r;
}

/**
 * GitHub's deliveries to an owner's webhook (docs/bots.md, "GitHub events and the PR gate"). The
 * body is kept raw: the signature is over the exact bytes GitHub sent.
 */
export function githubHookRouter(github: () => GitHubEvents | undefined, app: () => GitHubApps | undefined = () => undefined): Router {
  const r = express.Router();
  const perHook = limiter(600);
  const perApp = limiter(3_000);
  const headerOf = (req: Request) => (n: string) => (typeof req.headers[n] === "string" ? (req.headers[n] as string) : undefined);

  // Ambient's GitHub App: every installation's deliveries (docs/bots.md, "Connect GitHub").
  // The shared App's deliveries at /v1/hooks/github-app; every other App's at its own hook id.
  const appHook = (hookOf: (req: Request) => string | null) => async (req: Request, res: Response) => {
    const gha = app();
    if (!gha) return res.status(404).json({ error: "not_found" });
    const hook = hookOf(req);
    if (!perApp(hook ?? "app")) return res.status(429).json({ error: "slow_down" });
    const header = headerOf(req);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const out = await gha.receive(hook, { event: header("x-github-event"), signature: header("x-hub-signature-256"), delivery: header("x-github-delivery") }, body).catch((err: Error) => {
      console.warn(`[github-app] a delivery wasn't handled: ${err.message}`);
      return { status: 202, result: "not handled" };
    });
    res.status(out.status).json({ result: out.result });
  };
  r.post("/v1/hooks/github-app", express.raw({ type: "*/*", limit: "2mb" }), appHook(() => null));
  r.post("/v1/hooks/github-app/:hookId", express.raw({ type: "*/*", limit: "2mb" }), appHook((req) => String(req.params.hookId)));

  // Making an App (GitHub's manifest flow): the page that posts the manifest, and GitHub's return.
  r.get("/v1/github/new-app", (req, res) => {
    const gha = app();
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    if (!gha) return res.status(404).send(githubPage("Not set up", "<p>GitHub isn't set up on this Ambient server.</p>"));
    try {
      res.send(gha.newAppPage(typeof req.query.state === "string" ? req.query.state : ""));
    } catch (err) {
      res.status(err instanceof GitHubError ? err.status : 500).send(githubPage("Can't start", `<p>${err instanceof GitHubError ? err.message : "Start again in Ambient."}</p>`));
    }
  });

  r.get("/v1/github/app-created", async (req, res) => {
    const gha = app();
    res.setHeader("cache-control", "no-store");
    if (!gha) return res.status(404).type("html").send(githubPage("Not set up", "<p>GitHub isn't set up on this Ambient server.</p>"));
    try {
      const out = await gha.created(typeof req.query.code === "string" ? req.query.code : "", typeof req.query.state === "string" ? req.query.state : "");
      if (out.redirect) return res.redirect(303, out.redirect);
      res.type("html").send(out.html ?? githubPage("Done", ""));
    } catch (err) {
      res.status(err instanceof GitHubError ? err.status : 500).type("html").send(githubPage("Not made", `<p>${err instanceof GitHubError ? err.message : "That didn't work. Start again in Ambient."}</p>`));
    }
  });

  // GitHub sends the browser back here after an install (or a change of its repos).
  r.get("/v1/github/installed", async (req, res) => {
    const gha = app();
    const page = (title: string, text: string, ok: boolean) =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${ok ? '<meta http-equiv="refresh" content="1;url=ambient://github/connected">' : ""}<title>${title}</title><style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.25rem;color:#1d1d1f;background:#fbfaf7}a{color:inherit}@media(prefers-color-scheme:dark){body{color:#f5f5f7;background:#141414}}</style></head><body><h1>${title}</h1><p>${text}</p>${ok ? '<p><a href="ambient://github/connected">Back to Ambient</a></p>' : ""}</body></html>`;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    if (!gha) return res.status(404).send(page("Not set up", "Connect GitHub isn't set up on this Ambient server.", false));
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const id = Number(typeof req.query.installation_id === "string" ? req.query.installation_id : NaN);
    try {
      const { inst } = await gha.installed(id, state);
      const what = inst.repos === "all" ? `all of ${inst.account}'s repos` : `${inst.repos.length} repo${inst.repos.length === 1 ? "" : "s"} of ${inst.account}`;
      res.send(page("Connected", `Ambient's bots can work on ${what} now. You can go back to Ambient.`, true));
    } catch (err) {
      const message = err instanceof GitHubError ? err.message : "That didn't work. Start Connect GitHub again in the app.";
      res.status(err instanceof GitHubError ? err.status : 500).send(page("Not connected", message, false));
    }
  });

  r.post("/v1/hooks/github/:hookId", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
    const gh = github();
    const hook = String(req.params.hookId);
    if (!gh) return res.status(404).json({ error: "not_found" });
    if (!perHook(hook)) return res.status(429).json({ error: "slow_down" });
    const header = (n: string) => (typeof req.headers[n] === "string" ? (req.headers[n] as string) : undefined);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const out = await gh.receive(hook, { event: header("x-github-event"), signature: header("x-hub-signature-256"), delivery: header("x-github-delivery") }, body);
    res.status(out.status).json({ result: out.result });
  });
  return r;
}
