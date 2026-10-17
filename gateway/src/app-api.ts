// /v1/app/*: the iOS app's API. In the MVP the app talks only to the gateway;
// Convex sits behind it.
import { randomInt } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { SyncRequest, TeamNoteV1, parsePage, slugify } from "@brain/spec";
import { GitError, QueryRequest, dispatchQuery, fileLinks, renderListing, type WikiReader } from "@brain/wiki";
import type { AppAccess } from "./auth/app-access.ts";
import type { AppleRevoker } from "./auth/apple-revoke.ts";
import type { Pairing } from "./auth/pairing.ts";
import type { PatService } from "./auth/pats.ts";
import { api, type Control } from "./control.ts";
import { sha256Hex } from "./crypto.ts";
import type { Directory } from "./directory.ts";
import { limiter } from "./limiter.ts";
import { MAX_ABOUT, ME_PATH, writeAbout } from "./me.ts";
import { appStores, meetingBrief, waitingOn } from "./briefs.ts";
import { localDay, validZone } from "./digest.ts";
import type { PersonalStore } from "./personal.ts";
import type { PersonalRepos } from "./repos/personal.ts";
import { routineAppRoutes } from "./routines/route.ts";
import type { RoutineService } from "./routines/service.ts";
import type { SessionService } from "./sessions/service.ts";
import type { EventHub, Revisions } from "./revisions.ts";
import { TeamServerError, type TeamLink } from "./teams.ts";
import type { CodeHasher } from "./auth/codes.ts";

export interface AppApiDeps {
  /** Invite codes are stored keyed (auth/codes.ts). */
  codes: CodeHasher;
  control: Control;
  directory: Directory;
  /** Who an app request is from (its DPoP-bound access token); the apps sign in at /oauth. */
  access: AppAccess;
  pairing: Pairing;
  personal: PersonalStore;
  teams: TeamLink;
  pats: PatService;
  repos: PersonalRepos;
  sessions: SessionService;
  routines: RoutineService;
  appleRevoke: AppleRevoker;
  /** Microsoft's app registration id the apps sign in with (/v1/app/config), when there is one. */
  microsoftClientId?: string;
  /** Whether the apps can sign in with Apple here (a self-hosted server may take only Microsoft, or neither). */
  appleSignIn: boolean;
  /** What the app checks at launch, before anyone signs in. */
  appConfig: { minimumVersion?: string; updateUrl?: string };
  revisions: Revisions;
  events: EventHub;
  /** How long an event stream stays open before the app reconnects (with a fresh token). */
  streamMaxMs?: number;
}

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

const DeleteAccount = z.object({ authorizationCode: z.string().min(10).max(4000).optional() });

/** An app install's APNs device token (hex; 32 bytes today, longer allowed). */
const PushToken = z.string().regex(/^[0-9a-fA-F]{64,200}$/);
const PushDeviceBody = z.object({
  token: PushToken,
  sandbox: z.boolean(),
  platform: z.enum(["ios", "macos"]),
  /** IANA time zone, for pushes meant for the morning. */
  timeZone: z.string().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/).optional(),
});

/** A calendar meeting about to start: its title and who's invited, as the calendar names them. */
const BriefBody = z.object({ title: z.string().max(200).optional(), attendees: z.array(z.string().min(1).max(120)).min(1).max(20) });


export function appApiRouter(d: AppApiDeps): Router {
  const r = express.Router();
  // Sync batches may carry transcripts; the app splits batches well below this. Routes put `auth`
  // before `json`, so nobody can make the gateway inflate and buffer a body without signing in.
  const json = express.json({ limit: "8mb" });
  const authLimit = limiter(30);
  const userLimit = limiter(240);

  const auth = async (req: Request, res: Response, next: NextFunction) => {
    const uid = await d.access(req);
    if (!uid || !(await d.directory.user(uid))) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!userLimit(uid)) {
      res.status(429).json({ error: "slow_down" });
      return;
    }
    res.locals.uid = uid;
    next();
  };
  const uidOf = (res: Response) => res.locals.uid as string;

  // ---- launch config (no sign-in needed) ----

  // An app older than `minimumVersion` asks to be updated before it goes on (it can't keep in
  // step with the server any more).
  r.get("/v1/app/config", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      minimumVersion: d.appConfig.minimumVersion ?? null,
      updateUrl: d.appConfig.updateUrl ?? null,
      // The apps show "Continue with Microsoft" only when this is set,
      microsoftClientId: d.microsoftClientId ?? null,
      // and "Continue with Apple" unless this is false (apps before it always show it).
      appleSignIn: d.appleSignIn,
    });
  });

  // ---- sign-in: the OAuth server (/oauth/authorize, then oauth/interactions.ts) ----

  // ---- account ----

  // ---- what changed: the apps fetch only what moved ----

  // The user's revisions now (revisions.forUser): at launch and back in the app, before
  // deciding what to fetch.
  r.get("/v1/app/revisions", auth, async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ revisions: await d.revisions.forUser(uidOf(res)) });
  });

  // The same, live, while the app is open: server-sent events, a `revisions` event at once and
  // another whenever something moves. Closed after `streamMaxMs`, and the app reconnects with a
  // fresh token; a comment every 25 s keeps proxies from closing an idle stream.
  r.get("/v1/app/events", auth, (req, res) => {
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (chunk: string) => {
      if (!res.writableEnded) res.write(chunk);
    };
    send("retry: 5000\n\n");
    const stop = d.events.subscribe(uidOf(res), (revisions) => send(`event: revisions\ndata: ${JSON.stringify(revisions)}\n\n`));
    const ping = setInterval(() => send(": ping\n\n"), 25_000);
    const finish = () => {
      clearInterval(ping);
      clearTimeout(end);
      stop();
    };
    const end = setTimeout(() => {
      finish();
      res.end();
    }, d.streamMaxMs ?? 10 * 60_000);
    req.on("close", finish);
  });

  r.get("/v1/app/me", auth, async (_req, res) => {
    const uid = uidOf(res);
    const [user, teams, record, aiApp] = await Promise.all([
      d.directory.user(uid),
      d.directory.teamsOf(uid),
      d.control.q(api.users.get, { uid }),
      d.control.m(api.users.checkAppConnected, { uid: uid as never, now: Date.now() }),
    ]);
    res.json({
      user,
      teams: teams.map((t) => ({ slug: t.slug, name: t.name, status: t.status, role: t.role, peopleSlug: t.peopleSlug })),
      // Claude upkeep is opt-in: the app asks once (consolidateAsked) and it's off until then.
      prefs: { consolidate: record?.consolidate ?? false, consolidateAsked: record?.consolidateAsked ?? false, digest: record?.digest ?? true },
      // What's left to set up (the app's reminder dot).
      setup: { aiAppConnected: aiApp.connected },
    });
  });

  // Delete the account and everything of it: tokens stop working at once, owned teams pass to the
  // longest-standing admin or member (a team with nobody else is canceled), personal pages,
  // keys, repos, sessions, routines, secrets and AI-app connections are deleted, and Apple's
  // token is revoked when the app sent a fresh authorization code (App Store 5.1.1(v)).
  r.delete("/v1/app/me", auth, json, async (req, res) => {
    const body = DeleteAccount.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const uid = uidOf(res);
    const apple = await d.appleRevoke(body.data.authorizationCode);
    const begun = await d.control.m(api.users.beginDeletion, { uid: uid as never, now: Date.now() });
    d.directory.invalidate(uid);
    if (!begun.ok) {
      res.status(404).json({ error: begun.error });
      return;
    }
    let done = false;
    for (let i = 0; i < 5000 && !done; i++) done = (await d.control.m(api.users.purgeBatch, { uid: uid as never })).done;
    await d.control.m(api.oauth.destroyByAccount, { accountId: uid });
    console.log(`[gateway] account deleted (${begun.teams.length} teams, apple ${apple}${done ? "" : ", purge unfinished"})`);
    res.json({ deleted: done, apple, teams: begun.teams });
  });

  r.post("/v1/app/me/prefs", auth, json, async (req, res) => {
    const consolidate = typeof req.body?.consolidate === "boolean" ? (req.body.consolidate as boolean) : undefined;
    const digest = typeof req.body?.digest === "boolean" ? (req.body.digest as boolean) : undefined;
    if (consolidate === undefined && digest === undefined) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    await d.control.m(api.users.setPrefs, { uid: uidOf(res) as never, consolidate, digest });
    const record = await d.control.q(api.users.get, { uid: uidOf(res) });
    res.json({ prefs: { consolidate: record?.consolidate ?? false, consolidateAsked: record?.consolidateAsked ?? false, digest: record?.digest ?? true } });
  });

  // ---- before a meeting, and what's waiting on you (briefs.ts) ----

  // The app asks when a meeting with others is about to start (it reads the calendar on the
  // device; only the attendees' names come here, to look up their pages).
  r.post("/v1/app/briefs", auth, json, async (req, res) => {
    const body = BriefBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const uid = uidOf(res);
    const stores = await appStores(uid, d);
    res.set("Cache-Control", "no-store").json(await meetingBrief(stores, body.data.attendees, body.data.title ?? null));
  });

  r.get("/v1/app/actions", auth, async (req, res) => {
    const uid = uidOf(res);
    const zone = validZone(typeof req.query.tz === "string" ? req.query.tz : undefined);
    const [stores, user] = await Promise.all([appStores(uid, d), d.directory.user(uid)]);
    res.set("Cache-Control", "no-store").json(await waitingOn(stores, user?.name, localDay(new Date(), zone)));
  });

  // ---- about you: the `me` page every AI app starts from (me.ts) ----

  r.get("/v1/app/me/about", auth, async (_req, res) => {
    const text = await d.personal.readPage(uidOf(res), ME_PATH);
    if (!text) {
      res.json({ about: null, page: null });
      return;
    }
    const page = parsePage(text);
    res.json({
      about: typeof page.frontmatter.about === "string" ? page.frontmatter.about : null,
      page: { title: String(page.frontmatter.title ?? ""), summary: String(page.frontmatter.summary ?? ""), updated: String(page.frontmatter.updated ?? ""), body: page.body.trim() },
    });
  });

  // What they write about themselves, kept word for word; Claude's upkeep writes the rest of
  // the page from it and their notes (when upkeep is on).
  r.put("/v1/app/me/about", auth, json, async (req, res) => {
    const about = typeof req.body?.about === "string" ? req.body.about.trim() : "";
    if (!about || about.length > MAX_ABOUT) {
      res.status(400).json({ error: "bad_request", message: `Write a few sentences, at most ${MAX_ABOUT} characters.` });
      return;
    }
    const uid = uidOf(res);
    const [user, prev] = await Promise.all([d.directory.user(uid), d.personal.readPage(uid, ME_PATH)]);
    const text = writeAbout(prev, about, user?.name ?? "", new Date().toISOString().slice(0, 10));
    await d.personal.serverWrite(uid, [{ path: ME_PATH, content: text }]);
    res.json({ about, path: ME_PATH });
  });

  r.post("/v1/app/me/name", auth, json, async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    if (!name.trim()) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    await d.control.m(api.users.rename, { uid: uidOf(res) as never, name });
    d.directory.invalidate(uidOf(res));
    res.status(204).end();
  });

  // ---- push notifications ----

  // The app's device token, sent at every launch while signed in (it can change).
  r.put("/v1/app/push-device", auth, json, async (req, res) => {
    const body = PushDeviceBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const { token, sandbox, platform, timeZone } = body.data;
    await d.control.m(api.push.registerDevice, { uid: uidOf(res) as never, token: token.toLowerCase(), sandbox, platform, timeZone: validZone(timeZone), now: Date.now() });
    res.status(204).end();
  });

  // Signing out: this install stops getting the account's notifications.
  r.delete("/v1/app/push-device/:token", auth, async (req, res) => {
    const token = PushToken.safeParse(req.params.token);
    if (!token.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    await d.control.m(api.push.removeDevice, { uid: uidOf(res) as never, token: token.data.toLowerCase() });
    res.status(204).end();
  });

  r.post("/v1/app/pairing-codes", auth, async (_req, res) => {
    res.json(await d.pairing.create(uidOf(res)));
  });

  r.post("/v1/app/pats", auth, json, async (req, res) => {
    const body = z.object({ label: z.string().min(1).max(80), team: z.string().optional(), purpose: z.enum(["claude-code"]).optional() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const uid = uidOf(res);
    await d.control.m(api.users.markAppConnected, { uid: uid as never, now: Date.now() });
    if (body.data.team) {
      const team = await d.directory.membership(uid, body.data.team);
      if (!team) {
        res.status(403).json({ error: "not_a_member" });
        return;
      }
      // A team token (a company's Copilot) reads the team wiki and logs finished work to it.
      res.json(await d.pats.create({ uid, scopes: ["team:read", "team:write"], resource: { kind: "team", teamId: team.id }, label: body.data.label }));
      return;
    }
    // The Claude Code plugin's token also sends finished sessions (and serves its MCP connection).
    const scopes = ["personal:read", "personal:write", "team:read", ...(body.data.purpose === "claude-code" ? ["sessions:write"] : [])];
    res.json(await d.pats.create({ uid, scopes, resource: { kind: "personal" }, label: body.data.label }));
  });

  // A token that leaked (a laptop, a dotfile, a CI log) is revoked here; it stops working at once.
  r.get("/v1/app/pats", auth, async (_req, res) => {
    res.json({ tokens: await d.pats.list(uidOf(res)) });
  });

  r.delete("/v1/app/pats/:id", auth, async (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-z0-9]{10,64}$/.test(id) || !(await d.pats.revoke(uidOf(res), id))) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(204).end();
  });

  // ---- work sessions (Claude Code and AI apps) ----

  r.get("/v1/app/sessions", auth, async (_req, res) => {
    const uid = uidOf(res);
    const [rules, pending, teams] = await Promise.all([
      d.control.q(api.sessions.rules, { uid: uid as never }),
      d.control.q(api.sessions.pending, { uid: uid as never }),
      d.directory.teamsOf(uid),
    ]);
    res.json({
      rules,
      pending: pending.map((p) => {
        const team = teams.find((t) => t.id === p.teamId);
        return { sessionId: p.sessionId, title: p.title, tool: p.tool, path: p.path || null, team: team ? { slug: team.slug, name: team.name } : null, dueAt: p.shareDueAt };
      }),
    });
  });

  r.put("/v1/app/sessions/rules", auth, json, async (req, res) => {
    const uid = uidOf(res);
    const body = z.object({ rules: z.array(z.object({ match: z.string().trim().min(2).max(200), team: z.string().min(1).max(80) })).max(50) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Each rule needs a folder or repo and a team." });
      return;
    }
    const mine = new Set((await d.directory.teamsOf(uid)).map((t) => t.slug));
    const unknown = body.data.rules.find((r) => !mine.has(r.team));
    if (unknown) {
      res.status(400).json({ error: "not_a_member", message: `You're not in the team "${unknown.team}".` });
      return;
    }
    await d.control.m(api.sessions.setRules, { uid: uid as never, rules: body.data.rules });
    res.json({ rules: body.data.rules });
  });

  r.post("/v1/app/sessions/:sessionId/keep", auth, async (req, res) => {
    const out = await d.control.m(api.sessions.keepPersonal, { uid: uidOf(res) as never, sessionId: String(req.params.sessionId), now: Date.now() });
    if (!out.ok) {
      res.status(409).json({ error: "already_shared", message: "This session already went to the team." });
      return;
    }
    res.status(204).end();
  });

  // ---- routines (prompts Claude Code runs on a schedule on the user's computers) ----

  routineAppRoutes(r, { routines: d.routines, directory: d.directory, auth, json });

  // ---- teams ----

  r.post("/v1/app/teams/join", auth, json, async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
    if (!code || !authLimit(`join:${uidOf(res)}`)) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const uid = uidOf(res);
    const user = await d.directory.user(uid);
    let out!: Awaited<ReturnType<typeof join>>;
    const join = (codeHash: string) =>
      d.control.m(api.teams.joinWithInvite, { uid: uid as never, codeHash, peopleSlug: `people/${slugify(user?.name ?? "member") || "member"}`, now: Date.now() });
    for (const codeHash of d.codes.candidates("invite", code)) {
      out = await join(codeHash);
      if (out.ok || out.error !== "invalid_code") break;
    }
    d.directory.invalidate(uid);
    if (!out.ok) {
      res.status(400).json({ error: out.error });
      return;
    }
    res.json({ team: { slug: out.team.slug, name: out.team.name, role: out.team.role, peopleSlug: out.team.peopleSlug } });
  });

  // Create a team (the user owns it) on a free server from the pool.
  r.post("/v1/app/teams", auth, json, async (req, res) => {
    const uid = uidOf(res);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 80 || !authLimit(`create:${uid}`)) {
      res.status(400).json({ error: "bad_request", message: "Give the team a name (up to 80 characters)." });
      return;
    }
    const user = await d.directory.user(uid);
    const made = await d.control.m(api.teams.createOwned, {
      uid: uid as never,
      name,
      peopleSlug: `people/${slugify(user?.name ?? "member") || "member"}`,
      now: Date.now(),
    });
    if (!made.ok) {
      if (made.error === "no_server") {
        console.warn("[gateway] team creation refused: the server pool is empty");
        res.status(503).json({ error: "no_server", message: "We're setting up more team servers. Try again in a few hours; we've been told." });
      } else if (made.error === "too_many_teams") {
        res.status(403).json({ error: made.error, message: "You already own three teams. Write to us if you need another." });
      } else {
        res.status(400).json({ error: made.error, message: "Give the team a name." });
      }
      return;
    }
    try {
      await d.teams.claim(made.server, { id: made.team.id, name: made.team.name });
    } catch (err) {
      console.error(`[gateway] claiming pool server ${made.server.serverId} failed: ${(err as Error).message}`);
      await d.control.m(api.teams.abandonCreate, { teamId: made.team.id as never });
      d.directory.invalidate(uid);
      res.status(503).json({ error: "team_unavailable", message: "The team's server didn't answer. Try again in a minute." });
      return;
    }
    d.directory.invalidate(uid);
    // Best effort: the server restarts as the team's; notes queue on the phone until it's up.
    await d.teams.ready(made.server.url);
    const t = made.team;
    res.json({ team: { slug: t.slug, name: t.name, status: t.status, role: t.role, peopleSlug: t.peopleSlug } });
  });

  const managed = async (req: Request, res: Response) => {
    const team = await d.directory.membership(uidOf(res), String(req.params.slug));
    if (!team) res.status(403).json({ error: "not_a_member" });
    return team;
  };
  const refused = (res: Response, error: string) => {
    const messages: Record<string, string> = {
      forbidden: "Only the team's owner and admins can do that.",
      not_a_member: "You're not in this team.",
      owner_cannot_leave: "You own this team. Make someone else the owner first.",
    };
    res.status(error === "not_a_member" ? 403 : error === "forbidden" ? 403 : 400).json({ error, message: messages[error] ?? "That didn't work." });
  };

  r.get("/v1/app/teams/:slug/members", auth, async (req, res) => {
    const team = await managed(req, res);
    if (!team) return;
    const members = await d.control.q(api.teams.members, { uid: uidOf(res) as never, slug: team.slug });
    if (!members) {
      refused(res, "not_a_member");
      return;
    }
    res.json({ team: { slug: team.slug, name: team.name, status: team.status, role: team.role }, members });
  });

  r.post("/v1/app/teams/:slug/invites", auth, json, async (req, res) => {
    const team = await managed(req, res);
    if (!team) return;
    const body = z
      .object({ role: z.enum(["admin", "member"]).optional(), uses: z.number().int().min(1).max(100).optional(), days: z.number().int().min(1).max(90).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const part = () => Array.from({ length: 4 }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join("");
    const prefix = team.slug.replace(/[^a-z0-9]/g, "").slice(0, 4).toUpperCase() || "TEAM";
    const code = `${prefix}-${part()}-${part()}`;
    const uses = body.data.uses ?? 10;
    const out = await d.control.m(api.teams.invite, {
      uid: uidOf(res) as never,
      slug: team.slug,
      codeHash: d.codes.hash("invite", code),
      role: body.data.role,
      uses,
      days: body.data.days ?? 14,
      now: Date.now(),
    });
    if (!out.ok) {
      refused(res, out.error);
      return;
    }
    res.json({ code, role: out.role, uses, expiresAt: out.expiresAt });
  });

  r.delete("/v1/app/teams/:slug/members/:uid", auth, async (req, res) => {
    const team = await managed(req, res);
    if (!team) return;
    const target = String(req.params.uid);
    const out = await d.control.m(api.teams.removeMemberBy, { uid: uidOf(res) as never, slug: team.slug, target });
    d.directory.invalidate(target);
    if (!out.ok) refused(res, out.error);
    else res.status(204).end();
  });

  r.post("/v1/app/teams/:slug/members/:uid/role", auth, json, async (req, res) => {
    const team = await managed(req, res);
    if (!team) return;
    const role = req.body?.role;
    if (role !== "admin" && role !== "member") {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const target = String(req.params.uid);
    const out = await d.control.m(api.teams.setRole, { uid: uidOf(res) as never, slug: team.slug, target, role });
    d.directory.invalidate(target);
    if (!out.ok) refused(res, out.error);
    else res.status(204).end();
  });

  r.post("/v1/app/teams/:slug/leave", auth, async (req, res) => {
    const uid = uidOf(res);
    const out = await d.control.m(api.teams.leaveBySlug, { uid: uid as never, slug: String(req.params.slug) });
    d.directory.invalidate(uid);
    if (!out.ok) refused(res, out.error);
    else res.status(204).end();
  });

  r.post("/v1/app/teams/:slug/notes", auth, json, async (req, res) => {
    const uid = uidOf(res);
    const team = await d.directory.membership(uid, String(req.params.slug));
    if (!team || team.status !== "active") {
      res.status(403).json({ error: "not_a_member" });
      return;
    }
    const user = await d.directory.user(uid);
    const parsed = TeamNoteV1.safeParse({ ...req.body, team_id: team.id, recorded_by: uid, recorded_by_name: user?.name });
    if (!parsed.success) {
      res.status(400).json({ error: "bad_note", issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join(".")) });
      return;
    }
    try {
      res.json(await d.teams.deliver(team, parsed.data, uid, team.peopleSlug ?? null));
    } catch (err) {
      if (err instanceof TeamServerError) {
        // 503: the phone keeps the note in its outbox and retries later.
        res.status(err.status).json({ error: "team_server_unavailable" });
        return;
      }
      throw err;
    }
  });

  r.post("/v1/app/teams/:slug/query", auth, json, async (req, res) => {
    const uid = uidOf(res);
    const team = await d.directory.membership(uid, String(req.params.slug));
    if (!team || team.status !== "active") {
      res.status(403).json({ error: "not_a_member" });
      return;
    }
    const q = QueryRequest.safeParse(req.body);
    if (!q.success) {
      res.status(400).json({ error: "bad_query" });
      return;
    }
    try {
      res.json({ result: await dispatchQuery(d.teams.reader(team, uid), q.data) });
    } catch (err) {
      if (err instanceof TeamServerError) {
        res.status(err.status).json({ error: "team_server_unavailable" });
        return;
      }
      throw err;
    }
  });

  // ---- personal wiki ----

  r.post("/v1/app/personal/sync", auth, json, async (req, res) => {
    const body = SyncRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", issues: body.error.issues.slice(0, 5).map((i) => i.path.join(".")) });
      return;
    }
    res.json(await d.personal.sync(uidOf(res), body.data.ops, body.data.since_seq, body.data.device_id));
  });

  // What the server holds (paths and hashes only): a device removes pages it synced before
  // that are gone here, e.g. deleted on another device before deletions were recorded.
  r.get("/v1/app/personal/paths", auth, async (_req, res) => {
    res.json(await d.control.q(api.personal.paths, { uid: uidOf(res) as never }));
  });

  // A wiki's index.md or a folder's _index.md, exactly as in its git repo (they're generated
  // from the pages, so the app doesn't sync them; the Wiki tab shows them like the repo does).
  r.get("/v1/app/wiki/index", auth, async (req, res) => {
    const uid = uidOf(res);
    const folder = String(req.query.folder ?? "").replace(/^\/+|\/+$/g, "");
    if (!/^[a-z0-9/_.-]*$/.test(folder) || folder.includes("..")) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const slug = typeof req.query.team === "string" ? req.query.team : "";
    let reader: WikiReader;
    let title: string;
    if (slug) {
      const team = await d.directory.membership(uid, slug);
      if (!team || team.status !== "active") {
        res.status(403).json({ error: "not_a_member" });
        return;
      }
      reader = d.teams.reader(team, uid);
      title = `${team.name} wiki`;
    } else {
      reader = await d.personal.reader(uid);
      title = "Ambient wiki";
    }
    try {
      const listing = await reader.listing(folder);
      if (folder && !listing.folders.length && !listing.pages.length) {
        res.status(404).json({ error: "no_such_folder" });
        return;
      }
      res.json({ path: folder ? `${folder}/_index.md` : "index.md", markdown: renderListing(listing, title, fileLinks) });
    } catch (err) {
      if (err instanceof TeamServerError) {
        res.status(err.status).json({ error: "team_server_unavailable" });
        return;
      }
      throw err;
    }
  });

  r.get("/v1/app/personal/pages", auth, async (_req, res) => {
    res.json(await d.personal.pages(uidOf(res)));
  });

  // The personal wiki's own git repo (optional). Errors carry a sentence for the user.
  const repoError = (res: Response, err: unknown) => {
    if (err instanceof GitError) {
      res.status(400).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  };

  r.get("/v1/app/repo", auth, async (_req, res) => {
    res.json({ repo: await d.repos.status(uidOf(res)) });
  });

  r.post("/v1/app/repo", auth, json, async (req, res) => {
    const url = typeof req.body?.url === "string" ? req.body.url : "";
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    try {
      res.json({ repo: await d.repos.connect(uidOf(res), url, token) });
    } catch (err) {
      repoError(res, err);
    }
  });

  r.post("/v1/app/repo/sync", auth, async (_req, res) => {
    try {
      res.json({ result: await d.repos.sync(uidOf(res)), repo: await d.repos.status(uidOf(res)) });
    } catch (err) {
      repoError(res, err);
    }
  });

  r.delete("/v1/app/repo", auth, async (_req, res) => {
    await d.repos.disconnect(uidOf(res));
    res.status(204).end();
  });

  // A team wiki's own repo: any member sees the status; owners and admins connect it.
  const teamRepo = (method: "GET" | "POST" | "DELETE") => async (req: Request, res: Response) => {
    const uid = uidOf(res);
    const team = await d.directory.membership(uid, String(req.params.slug));
    if (!team || team.status !== "active") {
      res.status(403).json({ error: "not_a_member" });
      return;
    }
    if (method !== "GET" && team.role !== "owner" && team.role !== "admin") {
      res.status(403).json({ error: "admins_only", message: "Only team owners and admins can change the team repo." });
      return;
    }
    try {
      const body = method === "POST" ? { url: String(req.body?.url ?? ""), token: String(req.body?.token ?? "") } : undefined;
      const out = await d.teams.repo(team, uid, method, body);
      if (out.status === 204) res.status(204).end();
      else res.status(out.status).json(out.json);
    } catch (err) {
      if (err instanceof TeamServerError) {
        res.status(err.status).json({ error: "team_unavailable", message: "The team server didn't answer. Try again in a minute." });
        return;
      }
      throw err;
    }
  };
  r.get("/v1/app/teams/:slug/repo", auth, teamRepo("GET"));
  r.post("/v1/app/teams/:slug/repo", auth, json, teamRepo("POST"));
  r.delete("/v1/app/teams/:slug/repo", auth, teamRepo("DELETE"));

  return r;
}

