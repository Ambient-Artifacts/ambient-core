// Routines: prompts Claude Code runs on a schedule. A personal routine runs on one of the
// user's computers, or on their team's computer; a team's runs on the team's computer. The gateway seals prompts, run
// summaries and secrets with the owner's data key, and decides who may do what: it passes the
// user's id and the teams they may read (or, for changes, manage), and these functions only
// touch rows owned by one of those. The computer (a "host") reads its routines and reports
// runs through the gateway with its own token.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";
import { botSettings, modelChoice, routineSchedule, runStatus } from "./schema.js";
import { emailVouched } from "./admin.js";

const MAX_ROUTINES = 50;
const MAX_HOSTS = 10;
const MAX_SECRETS = 30;
const KEEP_RUNS = 50;

const access = { uid: v.id("users"), teamIds: v.array(v.id("teams")) };
const hostInfo = v.object({
  hostname: v.string(),
  os: v.string(),
  runner: v.string(),
  claude: v.string(),
  codex: v.optional(v.string()),
  codexLogin: v.optional(v.union(v.literal("chatgpt"), v.literal("api_key"), v.literal("none"))),
});

function routineShape(r: Doc<"routines">) {
  return {
    id: r._id,
    teamId: r.teamId ?? null,
    createdBy: r.userId,
    name: r.name,
    promptIv: r.promptIv,
    promptCt: r.promptCt,
    schedule: r.schedule,
    hostId: r.hostId ?? null,
    folder: r.folder ?? null,
    enabled: r.enabled,
    runRequestedAt: r.runRequestedAt ?? null,
    source: r.source,
    lastRun: r.lastRun ?? null,
    bot: r.bot ?? null,
    openQuestionId: r.openQuestionId ?? null,
    seenAt: r.seenAt ?? null,
    nextWakeAt: r.nextWakeAt ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function hostShape(h: Doc<"routineHosts">) {
  return {
    id: h._id,
    teamId: h.teamId ?? null,
    /** The person whose computer it is; set on a person's computer also when it's their team's (null: a team's own). */
    ownerUid: h.userId ?? null,
    /**
     * Who runs a team's own computer: whoever connected it, while they're in the team (`list`
     * checks that). Their personal space runs there as on a computer of their own.
     */
    runByUid: h.userId ? null : ((h.runBy as string | undefined) ?? null),
    name: h.name,
    ready: Boolean(h.tokenHash),
    codeExpiresAt: h.tokenHash ? null : (h.codeExpiresAt ?? null),
    info: h.info ?? null,
    lastSeenAt: h.lastSeenAt ?? null,
    // Who stored what and when; never the sealed values.
    claude: h.claude
      ? {
          use: h.claude.use,
          plan: h.claude.plan ? { by: h.claude.plan.by ?? null, at: h.claude.plan.at } : null,
          key: h.claude.key ? { by: h.claude.key.by ?? null, at: h.claude.key.at } : null,
        }
      : null,
    openai: { use: h.openai?.use ?? ("plan" as const), key: h.openai?.key ? { by: h.openai.key.by ?? null, at: h.openai.key.at } : null },
    model: h.model ?? null,
    access: h.access ?? "standard",
    allowed: h.allowed ?? [],
    createdAt: h.createdAt,
  };
}

function runShape(r: Doc<"routineRuns">) {
  return {
    id: r._id,
    routineId: r.routineId,
    trigger: r.trigger,
    status: r.status,
    startedByName: r.startedByName ?? null,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt ?? null,
    exitCode: r.exitCode ?? null,
    summaryIv: r.summaryIv ?? null,
    summaryCt: r.summaryCt ?? null,
    costUsd: r.costUsd ?? null,
    turns: r.turns ?? null,
    sessionId: r.sessionId ?? null,
  };
}

/**
 * Whether `uid` owns or administers `teamId` right now. Read here, for every team write: the
 * gateway's view of roles is cached for up to a minute, and an admin who was just demoted or
 * removed mustn't change what runs on the team's server in that minute.
 */
export async function manages(ctx: { db: QueryCtx["db"] }, uid: Id<"users">, teamId: Id<"teams">): Promise<boolean> {
  const m = await ctx.db.query("members").withIndex("by_team_user", (q) => q.eq("teamId", teamId).eq("userId", uid)).unique();
  return !!m && (m.role === "owner" || m.role === "admin");
}

/** A routine the user may see (reads) or change (writes): theirs, or one of the given teams'. */
export async function routineFor(ctx: { db: QueryCtx["db"] }, uid: Id<"users">, teamIds: Id<"teams">[], id: string) {
  const routineId = ctx.db.normalizeId("routines", id);
  const r = routineId ? await ctx.db.get(routineId) : null;
  if (!r) return null;
  return (r.teamId ? teamIds.includes(r.teamId) : r.userId === uid) ? r : null;
}

/** Whether `uid` is in `teamId` right now (any role). */
async function isMember(ctx: { db: QueryCtx["db"] }, teamId: Id<"teams">, uid: Id<"users">): Promise<boolean> {
  return !!(await ctx.db.query("members").withIndex("by_team_user", (q) => q.eq("teamId", teamId).eq("userId", uid)).unique());
}

async function activeTeam(ctx: { db: QueryCtx["db"] }, teamId: Id<"teams"> | undefined): Promise<boolean> {
  return !!teamId && (await ctx.db.get(teamId))?.status === "active";
}

/** One of the user's own computers (also one that is their team's computer too). */
async function ownHost(ctx: { db: QueryCtx["db"] }, uid: Id<"users">, id: string) {
  const hostId = ctx.db.normalizeId("routineHosts", id);
  const h = hostId ? await ctx.db.get(hostId) : null;
  return h && h.userId === uid ? h : null;
}

/**
 * Whether a personal bot of `uid` may run on `h` (docs/bots.md, "Personal bots on the team's
 * computer"): their own computer, or a computer of a team they're in, while they're in it.
 */
async function mayRunOn(ctx: { db: QueryCtx["db"] }, h: Doc<"routineHosts">, uid: Id<"users">): Promise<boolean> {
  if (h.userId === uid) return true;
  return !!h.teamId && Boolean(h.tokenHash) && (await activeTeam(ctx, h.teamId)) && (await isMember(ctx, h.teamId, uid));
}

/** A computer the user may put a bot of their own on, by id: theirs, or their team's. */
async function usableHost(ctx: { db: QueryCtx["db"] }, uid: Id<"users">, id: string) {
  const hostId = ctx.db.normalizeId("routineHosts", id);
  const h = hostId ? await ctx.db.get(hostId) : null;
  return h && (await mayRunOn(ctx, h, uid)) ? h : null;
}

/**
 * Where a bot of `uid`'s own goes when nobody picked a computer: their only computer, or with
 * none of their own, their team's computer. With several of their own it's theirs to pick
 * (`any`: the one seen last, for bots whose computer was just removed). `exclude`: not that one.
 */
export async function defaultHost(ctx: { db: QueryCtx["db"] }, uid: Id<"users">, opts: { exclude?: Id<"routineHosts">; any?: boolean } = {}): Promise<Doc<"routineHosts"> | null> {
  const own = (await ctx.db.query("routineHosts").withIndex("by_user", (q) => q.eq("userId", uid)).take(MAX_HOSTS * 2)).filter((h) => h.tokenHash && h._id !== opts.exclude);
  if (own.length === 1 || (own.length > 1 && opts.any)) return own.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0]!;
  if (own.length) return null;
  for (const m of await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", uid)).take(20)) {
    if (!(await activeTeam(ctx, m.teamId))) continue;
    const h = await teamComputer(ctx, m.teamId);
    if (h && h._id !== opts.exclude) return h;
  }
  return null;
}

async function personalRoutines(ctx: { db: QueryCtx["db"] }, uid: Id<"users">) {
  return (await ctx.db.query("routines").withIndex("by_user", (q) => q.eq("userId", uid)).take(MAX_ROUTINES * 4)).filter((r) => !r.teamId);
}

async function teamRoutines(ctx: { db: QueryCtx["db"] }, teamId: Id<"teams">) {
  return ctx.db.query("routines").withIndex("by_team", (q) => q.eq("teamId", teamId)).take(MAX_ROUTINES * 2);
}

// ---- the user's side (app and MCP, through the gateway) ----

/** The user's routines and computers, and those of the given teams. */
export const list = query({
  args: { ...secretArg, ...access },
  handler: async (ctx, { secret, uid, teamIds }) => {
    assertService(secret);
    const routines = await personalRoutines(ctx, uid);
    // Their own computers (one may be their team's too), and their teams' (each once).
    const hosts = await ctx.db.query("routineHosts").withIndex("by_user", (q) => q.eq("userId", uid)).take(MAX_HOSTS * 2);
    for (const teamId of teamIds) {
      routines.push(...(await teamRoutines(ctx, teamId)));
      for (const h of await ctx.db.query("routineHosts").withIndex("by_team", (q) => q.eq("teamId", teamId)).take(5)) if (!hosts.some((x) => x._id === h._id)) hosts.push(h);
    }
    // A team bot's thread is a group chat: read is each person's own (`botReads`).
    const shapes = [];
    for (const r of routines.sort((a, b) => a.createdAt - b.createdAt)) {
      const shape = routineShape(r);
      if (r.teamId && r.bot) {
        const read = await ctx.db.query("botReads").withIndex("by_routine_user", (q) => q.eq("routineId", r._id).eq("userId", uid)).unique();
        shape.seenAt = read?.at ?? null;
      }
      shapes.push(shape);
    }
    const shaped = [];
    for (const h of hosts.sort((a, b) => a.createdAt - b.createdAt)) shaped.push({ ...hostShape(h), runByUid: await runByOf(ctx, h) });
    return { routines: shapes, hosts: shaped };
  },
});

/**
 * Who runs a team's own computer (docs/bots.md, "Every computer has a person"): whoever connected
 * it, while they're in the team. Null on a person's computer (its owner is `userId`), on rows from
 * before (nobody knows who has root there) and once that person left: nobody's personal space goes
 * there then without saying yes, the owner's included, since whoever has root may not be them.
 */
export async function runByOf(ctx: { db: QueryCtx["db"] }, h: Doc<"routineHosts">): Promise<string | null> {
  if (h.userId || !h.teamId || !h.runBy) return null;
  return (await isMember(ctx, h.teamId, h.runBy)) ? h.runBy : null;
}

/**
 * The computer a team's bots run on: one set up (with a token) among the team's. A code still
 * waiting for setup isn't one, whichever row comes first. A computer connected for the team
 * wins over its owner's computer that serves the team too (docs/bots.md, "Personal bots on the
 * team's computer"): picking a different one for the team moves the team's bots there.
 */
export async function teamComputer(ctx: { db: QueryCtx["db"] }, teamId: Id<"teams">): Promise<Doc<"routineHosts"> | null> {
  const ready = (await ctx.db.query("routineHosts").withIndex("by_team", (q) => q.eq("teamId", teamId)).take(MAX_HOSTS * 2)).filter((h) => h.tokenHash);
  return ready.find((h) => !h.userId) ?? ready[0] ?? null;
}

export const create = mutation({
  args: {
    ...secretArg,
    uid: v.id("users"),
    /** A team routine (the gateway checked the user manages the team); runs on the team's server. */
    teamId: v.optional(v.id("teams")),
    name: v.string(),
    promptIv: v.string(),
    promptCt: v.string(),
    schedule: routineSchedule,
    hostId: v.optional(v.string()),
    folder: v.optional(v.string()),
    enabled: v.boolean(),
    /** A bot (the gateway checked bots are on for this owner). */
    bot: v.optional(botSettings),
    source: v.string(),
    now: v.number(),
  },
  handler: async (ctx, { secret, uid, teamId, hostId, now, ...fields }) => {
    assertService(secret);
    if (teamId && !(await manages(ctx, uid, teamId))) return { ok: false as const, error: "admins_only" };
    const count = teamId ? (await teamRoutines(ctx, teamId)).length : (await personalRoutines(ctx, uid)).length;
    if (count >= MAX_ROUTINES) return { ok: false as const, error: "too_many_routines" };
    let host: Doc<"routineHosts"> | null = null;
    if (hostId && !teamId) {
      host = await usableHost(ctx, uid, hostId);
      if (!host) return { ok: false as const, error: "no_such_computer" };
    }
    // A bot of one's own that nobody gave a computer: their only one, or their team's.
    if (!teamId && !host && fields.bot) {
      host = await defaultHost(ctx, uid);
      if (!host) return { ok: false as const, error: "bot_needs_computer" };
    }
    // A team's bot without a computer for the team's bots would only ever sit there asleep (as a
    // personal one without a computer, bot_needs_computer): refused up front.
    if (teamId && fields.bot && !(await teamComputer(ctx, teamId))) return { ok: false as const, error: "team_needs_computer" };
    const id = await ctx.db.insert("routines", { userId: uid, teamId, ...fields, hostId: host?._id, createdAt: now, updatedAt: now });
    return { ok: true as const, routine: routineShape((await ctx.db.get(id))!) };
  },
});

export const update = mutation({
  args: {
    ...secretArg,
    ...access,
    id: v.string(),
    name: v.optional(v.string()),
    promptIv: v.optional(v.string()),
    promptCt: v.optional(v.string()),
    schedule: v.optional(routineSchedule),
    /** null: no computer (a personal routine stops running). Ignored for team routines. */
    hostId: v.optional(v.union(v.string(), v.null())),
    /** null: the runner's own folder. */
    folder: v.optional(v.union(v.string(), v.null())),
    enabled: v.optional(v.boolean()),
    /** null: a plain loop again. */
    bot: v.optional(v.union(botSettings, v.null())),
    source: v.string(),
    now: v.number(),
  },
  handler: async (ctx, { secret, uid, teamIds, id, hostId, folder, bot, now, ...fields }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r) return { ok: false as const, error: "no_such_routine" };
    if (r.teamId && !(await manages(ctx, uid, r.teamId))) return { ok: false as const, error: "admins_only" };
    const patch: Partial<Doc<"routines">> = { updatedAt: now, source: fields.source };
    if (fields.name !== undefined) patch.name = fields.name;
    if (fields.promptIv !== undefined && fields.promptCt !== undefined) {
      patch.promptIv = fields.promptIv;
      patch.promptCt = fields.promptCt;
    }
    if (fields.schedule !== undefined) patch.schedule = fields.schedule;
    if (fields.enabled !== undefined) patch.enabled = fields.enabled;
    if (folder !== undefined) patch.folder = folder ?? undefined;
    if (bot !== undefined) {
      patch.bot = bot ?? undefined;
      if (bot === null) Object.assign(patch, { openQuestionId: undefined, pendingMessageId: undefined });
    }
    if (hostId !== undefined && !r.teamId) {
      if (hostId === null) patch.hostId = undefined;
      else {
        const host = await usableHost(ctx, uid, hostId);
        if (!host) return { ok: false as const, error: "no_such_computer" };
        patch.hostId = host._id;
      }
      // Its conversation lives on the computer it ran on: on another one it starts afresh.
      if (patch.hostId !== r.hostId) patch.lastSessionId = undefined;
    }
    await ctx.db.patch(r._id, patch);
    return { ok: true as const, routine: routineShape((await ctx.db.get(r._id))!) };
  },
});

export const remove = mutation({
  args: { ...secretArg, ...access, id: v.string() },
  handler: async (ctx, { secret, uid, teamIds, id }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r) return { ok: false as const, error: "no_such_routine" };
    if (r.teamId && !(await manages(ctx, uid, r.teamId))) return { ok: false as const, error: "admins_only" };
    const runs = await ctx.db.query("routineRuns").withIndex("by_routine", (q) => q.eq("routineId", r._id)).take(KEEP_RUNS * 4);
    for (const run of runs) await ctx.db.delete(run._id);
    const messages = await ctx.db.query("botMessages").withIndex("by_routine", (q) => q.eq("routineId", r._id)).take(1000);
    for (const m of messages) await ctx.db.delete(m._id);
    for (const w of await ctx.db.query("botWakes").withIndex("by_routine", (q) => q.eq("routineId", r._id)).take(500)) await ctx.db.delete(w._id);
    for (const read of await ctx.db.query("botReads").withIndex("by_routine_user", (q) => q.eq("routineId", r._id)).take(500)) await ctx.db.delete(read._id);
    // Its own GitHub App's record (the App itself stays on GitHub until someone deletes it there).
    for (const g of await ctx.db.query("githubApps").withIndex("by_routine", (q) => q.eq("routineId", r._id)).take(10)) await ctx.db.delete(g._id);
    // The files sent in its thread go with it.
    for (const f of await ctx.db.query("attachments").withIndex("by_routine", (q) => q.eq("routineId", r._id)).take(500)) {
      await ctx.storage.delete(f.storageId);
      await ctx.db.delete(f._id);
    }
    await ctx.db.delete(r._id);
    return { ok: true as const, name: r.name };
  },
});

/** "Run now": the routine's computer starts it on its next check (within a minute). */
export const requestRun = mutation({
  args: { ...secretArg, ...access, id: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, teamIds, id, now }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r) return { ok: false as const, error: "no_such_routine" };
    if (r.teamId && !(await manages(ctx, uid, r.teamId))) return { ok: false as const, error: "admins_only" };
    if (r.teamId) {
      if (!(await teamComputer(ctx, r.teamId))) return { ok: false as const, error: "no_team_server" };
    } else if (!r.hostId) return { ok: false as const, error: "no_computer" };
    const userId = ctx.db.normalizeId("users", uid);
    const user = userId ? await ctx.db.get(userId) : null;
    await ctx.db.patch(r._id, { runRequestedAt: now, runRequestedBy: user?.name });
    return { ok: true as const, routine: routineShape((await ctx.db.get(r._id))!) };
  },
});

export const runs = query({
  args: { ...secretArg, ...access, id: v.string(), limit: v.number() },
  handler: async (ctx, { secret, uid, teamIds, id, limit }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r) return null;
    const rows = await ctx.db
      .query("routineRuns")
      .withIndex("by_routine", (q) => q.eq("routineId", r._id))
      .order("desc")
      .take(Math.min(Math.max(limit, 1), KEEP_RUNS));
    return { teamId: r.teamId ?? null, runs: rows.map(runShape) };
  },
});

/** One of the user's own computers, waiting for `ambient-runner setup <code>`. */
export const addHost = mutation({
  args: { ...secretArg, uid: v.id("users"), name: v.string(), codeHash: v.string(), expiresAt: v.number(), now: v.number() },
  handler: async (ctx, { secret, uid, name, codeHash, expiresAt, now }) => {
    assertService(secret);
    const hosts = (await ctx.db.query("routineHosts").withIndex("by_user", (q) => q.eq("userId", uid)).take(MAX_HOSTS * 2)).filter((h) => !h.teamId);
    // Computers that were never set up don't count against the limit; they're replaced.
    for (const h of hosts) if (!h.tokenHash && (h.codeExpiresAt ?? 0) < now) await ctx.db.delete(h._id);
    if (hosts.filter((h) => h.tokenHash).length >= MAX_HOSTS) return { ok: false as const, error: "too_many_computers" };
    const id = await ctx.db.insert("routineHosts", { userId: uid, name, codeHash, codeExpiresAt: expiresAt, createdAt: now });
    return { ok: true as const, host: hostShape((await ctx.db.get(id))!) };
  },
});

/**
 * A computer for a team (its owner or an admin adds it): it runs the team's brain when the team has
 * no server of its own (docs/architecture.md, "A team on its own computer"), and the team's bots.
 */
export const addTeamHost = mutation({
  args: { ...secretArg, uid: v.id("users"), teamId: v.id("teams"), name: v.string(), codeHash: v.string(), expiresAt: v.number(), now: v.number() },
  handler: async (ctx, { secret, uid, teamId, name, codeHash, expiresAt, now }) => {
    assertService(secret);
    if (!(await manages(ctx, uid, teamId))) return { ok: false as const, error: "admins_only" };
    const hosts = await ctx.db.query("routineHosts").withIndex("by_team", (q) => q.eq("teamId", teamId)).take(MAX_HOSTS * 2);
    for (const h of hosts) if (!h.tokenHash && (h.codeExpiresAt ?? 0) < now) await ctx.db.delete(h._id);
    if (hosts.filter((h) => h.tokenHash).length >= MAX_HOSTS) return { ok: false as const, error: "too_many_computers" };
    // Whoever connects it runs it: it's their computer too (docs/bots.md, "Every computer has a person").
    const id = await ctx.db.insert("routineHosts", { teamId, runBy: uid, name, codeHash, codeExpiresAt: expiresAt, createdAt: now });
    return { ok: true as const, host: hostShape((await ctx.db.get(id))!) };
  },
});

/**
 * Remove one of the user's computers (also one that was their team's too). Its bots move to their
 * owner's other computer, or their team's (`defaultHost`); without one they stay, asleep, until
 * they're given one.
 */
export const removeHost = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, id, now }) => {
    assertService(secret);
    const h = await ownHost(ctx, uid, id);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    await rehome(ctx, h._id, now);
    await ctx.db.delete(h._id);
    return { ok: true as const };
  },
});

/** The personal bots on a computer that is going away, each to its owner's next computer (or none). */
async function rehome(ctx: MutationCtx, hostId: Id<"routineHosts">, now: number) {
  const routines = await ctx.db.query("routines").withIndex("by_host", (q) => q.eq("hostId", hostId)).take(MAX_ROUTINES * 20);
  for (const r of routines) {
    if (r.teamId) continue;
    const next = await defaultHost(ctx, r.userId, { exclude: hostId, any: true });
    // Its conversation stayed on the computer that's going: it starts afresh on the next one.
    await ctx.db.patch(r._id, { hostId: next?._id, lastSessionId: undefined, updatedAt: now });
  }
}

/**
 * A team's computer was just set up: the bots of its people that have no computer (theirs was
 * removed) and no computer of their own go there, as a bot made now would.
 */
async function adoptHomeless(ctx: MutationCtx, teamId: Id<"teams">, now: number) {
  const host = await teamComputer(ctx, teamId);
  if (!host) return;
  for (const m of await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", teamId)).take(200)) {
    const homeless = (await personalRoutines(ctx, m.userId)).filter((r) => r.bot && !r.hostId);
    if (!homeless.length || (await defaultHost(ctx, m.userId))?._id !== host._id) continue;
    for (const r of homeless) await ctx.db.patch(r._id, { hostId: host._id, lastSessionId: undefined, updatedAt: now });
  }
}

/**
 * A person's computer serves their team too (docs/bots.md, "Personal bots on the team's
 * computer"): when they own a team that has no computer of its own yet. Called when they connect
 * one and when they create the team.
 */
export async function shareWithOwnedTeam(ctx: MutationCtx, h: Doc<"routineHosts">, now: number): Promise<Id<"teams"> | null> {
  if (!h.userId || h.teamId || !h.tokenHash) return null;
  const uid = h.userId;
  for (const m of await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", uid)).take(20)) {
    if (m.role !== "owner" || !(await activeTeam(ctx, m.teamId)) || (await teamComputer(ctx, m.teamId))) continue;
    await ctx.db.patch(h._id, { teamId: m.teamId });
    await adoptHomeless(ctx, m.teamId, now);
    return m.teamId;
  }
  return null;
}

/**
 * Staff: a computer waiting for setup, for a user found by email or for a team's server by slug
 * (ops/new-computer.mjs). A team has one server: a new code replaces the old one's row.
 */
export const staffAddHost = internalMutation({
  args: { email: v.optional(v.string()), team: v.optional(v.string()), name: v.string(), codeHash: v.string(), expiresAt: v.number() },
  handler: async (ctx, { email, team, name, codeHash, expiresAt }) => {
    if (team) {
      const t = await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", team)).unique();
      if (!t) throw new Error(`no team ${team}`);
      // Its owner's computer that served the team stays theirs; the team's own rows go.
      for (const old of await ctx.db.query("routineHosts").withIndex("by_team", (q) => q.eq("teamId", t._id)).collect()) {
        if (old.userId) await ctx.db.patch(old._id, { teamId: undefined });
        else {
          await rehome(ctx, old._id, Date.now());
          await ctx.db.delete(old._id);
        }
      }
      const id = await ctx.db.insert("routineHosts", { teamId: t._id, name, codeHash, codeExpiresAt: expiresAt, createdAt: Date.now() });
      return { id, team: t.slug };
    }
    const want = (email ?? "").trim().toLowerCase();
    // Emails someone vouches for only (see admin.ts emailVouched).
    const users = (await ctx.db.query("users").collect()).filter((u) => emailVouched(u) && u.email?.toLowerCase() === want && !u.disabled);
    if (users.length !== 1) throw new Error(users.length ? `${users.length} users have ${email}` : `no user with ${email}`);
    const id = await ctx.db.insert("routineHosts", { userId: users[0]!._id, name, codeHash, codeExpiresAt: expiresAt, createdAt: Date.now() });
    return { id, uid: users[0]!._id };
  },
});

// ---- secrets (environment variables for runs) ----

function ownerMatches(row: { userId?: Id<"users">; teamId?: Id<"teams"> }, uid: Id<"users">, teamId: Id<"teams"> | undefined) {
  return teamId ? row.teamId === teamId : row.userId === uid && !row.teamId;
}

async function secretRows(ctx: { db: QueryCtx["db"] }, uid: Id<"users">, teamId: Id<"teams"> | undefined) {
  const rows = teamId
    ? await ctx.db.query("routineSecrets").withIndex("by_team", (q) => q.eq("teamId", teamId)).take(MAX_SECRETS * 2)
    : await ctx.db.query("routineSecrets").withIndex("by_user", (q) => q.eq("userId", uid)).take(MAX_SECRETS * 4);
  return rows.filter((r) => ownerMatches(r, uid, teamId));
}

/** Names only: values are never read back. `teamId`: a team the user may read. */
export const secretNames = query({
  args: { ...secretArg, uid: v.id("users"), teamId: v.optional(v.id("teams")) },
  handler: async (ctx, { secret, uid, teamId }) => {
    assertService(secret);
    return (await secretRows(ctx, uid, teamId)).map((r) => ({ name: r.name, updatedAt: r.updatedAt })).sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Set a secret (`teamId`: a team the user manages). */
export const setSecret = mutation({
  args: {
    ...secretArg,
    uid: v.id("users"),
    teamId: v.optional(v.id("teams")),
    name: v.string(),
    valueIv: v.string(),
    valueCt: v.string(),
    // Set by an AI app: the owner's loops that are on pause, in the same step (see pauseOwned).
    pauseLoops: v.optional(v.boolean()),
    source: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, { secret, uid, teamId, name, valueIv, valueCt, pauseLoops, source, now }) => {
    assertService(secret);
    if (teamId && !(await manages(ctx, uid, teamId))) return { ok: false as const, error: "admins_only" };
    const rows = await secretRows(ctx, uid, teamId);
    const existing = rows.find((r) => r.name === name);
    if (existing) {
      await ctx.db.patch(existing._id, { valueIv, valueCt, updatedBy: uid, updatedAt: now });
    } else {
      if (rows.length >= MAX_SECRETS) return { ok: false as const, error: "too_many_secrets" };
      await ctx.db.insert("routineSecrets", { ...(teamId ? { teamId } : { userId: uid }), name, valueIv, valueCt, updatedBy: uid, updatedAt: now });
    }
    const paused = pauseLoops ? await pauseOwned(ctx, uid, teamId, source ?? "mcp", now) : [];
    return { ok: true as const, paused };
  },
});

/**
 * Pauses the loops of one owner (a user's own, or a team's) that are on; returns their names.
 * Every run gets all of its owner's secrets, so a secret an AI app sets changes what loops the user
 * turned on do: a token swapped for someone else's, or a variable a tool reads on its own (a proxy,
 * a base URL). Only the user turns a loop on, so those loops wait for them again.
 */
async function pauseOwned(ctx: MutationCtx, uid: Id<"users">, teamId: Id<"teams"> | undefined, source: string, now: number): Promise<string[]> {
  const names: string[] = [];
  for (const r of teamId ? await teamRoutines(ctx, teamId) : await personalRoutines(ctx, uid)) {
    if (!r.enabled) continue;
    await ctx.db.patch(r._id, { enabled: false, updatedAt: now, source });
    names.push(r.name);
  }
  return names;
}

export const removeSecret = mutation({
  args: { ...secretArg, uid: v.id("users"), teamId: v.optional(v.id("teams")), name: v.string() },
  handler: async (ctx, { secret, uid, teamId, name }) => {
    assertService(secret);
    if (teamId && !(await manages(ctx, uid, teamId))) return { ok: false as const, error: "admins_only" };
    const row = (await secretRows(ctx, uid, teamId)).find((r) => r.name === name);
    if (!row) return { ok: false as const, error: "no_such_secret" };
    await ctx.db.delete(row._id);
    return { ok: true as const };
  },
});

// ---- team data keys ----

export const teamKey = query({
  args: { ...secretArg, teamId: v.id("teams") },
  handler: async (ctx, { secret, teamId }) => {
    assertService(secret);
    const k = await ctx.db.query("teamKeys").withIndex("by_team", (q) => q.eq("teamId", teamId)).first();
    return k ? { masterKeyId: k.masterKeyId, wrapped: k.wrapped } : null;
  },
});

/** Store a new team key, unless another request stored one first (that one wins). */
export const putTeamKey = mutation({
  args: { ...secretArg, teamId: v.id("teams"), masterKeyId: v.string(), wrapped: v.string(), now: v.number() },
  handler: async (ctx, { secret, teamId, masterKeyId, wrapped, now }) => {
    assertService(secret);
    const k = await ctx.db.query("teamKeys").withIndex("by_team", (q) => q.eq("teamId", teamId)).first();
    if (k) return { masterKeyId: k.masterKeyId, wrapped: k.wrapped };
    await ctx.db.insert("teamKeys", { teamId, masterKeyId, wrapped, createdAt: now });
    return { masterKeyId, wrapped };
  },
});

// ---- the computer's side (ambient-runner, through the gateway) ----

/** Trade a one-time setup code for the computer's token. */
export const claimHost = mutation({
  args: { ...secretArg, codeHash: v.string(), tokenHash: v.string(), info: hostInfo, now: v.number() },
  handler: async (ctx, { secret, codeHash, tokenHash, info, now }) => {
    assertService(secret);
    const h = await ctx.db.query("routineHosts").withIndex("by_code", (q) => q.eq("codeHash", codeHash)).unique();
    if (!h || h.tokenHash) return { ok: false as const, error: "invalid_code" };
    if ((h.codeExpiresAt ?? 0) < now) return { ok: false as const, error: "expired_code" };
    await ctx.db.patch(h._id, { tokenHash, codeHash: undefined, codeExpiresAt: undefined, info, lastSeenAt: now });
    const claimed = (await ctx.db.get(h._id))!;
    // A person's computer serves the team they own while it has none; a team's computer takes in
    // its people's bots that lost theirs.
    const shared = await shareWithOwnedTeam(ctx, claimed, now);
    if (claimed.teamId) await adoptHomeless(ctx, claimed.teamId, now);
    return { ok: true as const, host: { id: h._id, uid: h.userId ?? null, teamId: shared ?? h.teamId ?? null, name: h.name } };
  },
});

export const hostByToken = query({
  args: { ...secretArg, tokenHash: v.string() },
  handler: async (ctx, { secret, tokenHash }) => {
    assertService(secret);
    const h = await ctx.db.query("routineHosts").withIndex("by_token", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!h) return null;
    // A team's own computer goes with its team; a person's computer that served it stays theirs.
    const teamOk = !h.teamId || (await activeTeam(ctx, h.teamId));
    if (!teamOk && !h.userId) return null;
    return { id: h._id, uid: h.userId ?? null, teamId: teamOk ? (h.teamId ?? null) : null, name: h.name };
  },
});

/** Whether `h` is the computer its team's bots run on now. */
async function runsTeamBots(ctx: { db: QueryCtx["db"] }, h: Doc<"routineHosts">): Promise<boolean> {
  return !!h.teamId && (await activeTeam(ctx, h.teamId)) && (await teamComputer(ctx, h.teamId))?._id === h._id;
}

/**
 * The routines a computer runs: the personal bots placed on it whose owners may still use it
 * (its owner's; on a team's computer, its people's), and all of its team's when it is the
 * computer the team's bots run on.
 */
async function hostRoutines(ctx: { db: QueryCtx["db"] }, h: Doc<"routineHosts">) {
  const placed = await ctx.db.query("routines").withIndex("by_host", (q) => q.eq("hostId", h._id)).take(MAX_ROUTINES * 20);
  const allowed = new Map<string, boolean>();
  const personal: Doc<"routines">[] = [];
  for (const r of placed) {
    if (r.teamId) continue;
    const key = String(r.userId);
    if (!allowed.has(key)) allowed.set(key, await mayRunOn(ctx, h, r.userId));
    if (allowed.get(key)) personal.push(r);
  }
  return (await runsTeamBots(ctx, h)) ? [...(await teamRoutines(ctx, h.teamId!)), ...personal] : personal;
}

async function runsOn(ctx: { db: QueryCtx["db"] }, h: Doc<"routineHosts">, r: Doc<"routines">) {
  if (r.teamId) return r.teamId === h.teamId && (await runsTeamBots(ctx, h));
  return r.hostId === h._id && (await mayRunOn(ctx, h, r.userId));
}

/** The computer's routines (with their run requests); records that it checked in. */
export const hostSync = mutation({
  args: { ...secretArg, hostId: v.id("routineHosts"), info: v.optional(hostInfo), now: v.number() },
  handler: async (ctx, { secret, hostId, info, now }) => {
    assertService(secret);
    const h = await ctx.db.get(hostId);
    if (!h) return null;
    await ctx.db.patch(hostId, { lastSeenAt: now, ...(info ? { info } : {}) });
    return { routines: (await hostRoutines(ctx, h)).map(routineShape), model: h.model ?? null };
  },
});

async function pruneRuns(ctx: MutationCtx, routineId: Id<"routines">) {
  const old = await ctx.db
    .query("routineRuns")
    .withIndex("by_routine", (q) => q.eq("routineId", routineId))
    .order("desc")
    .take(KEEP_RUNS + 20);
  for (const run of old.slice(KEEP_RUNS)) await ctx.db.delete(run._id);
}

/**
 * A run starts. It's "manual" when a run was requested (the request is cleared). systemd runs
 * one instance per routine, so an earlier run still marked running was cut off (a reboot).
 * Returns the routine and its owner's secrets (both sealed) for the run.
 */
export const startRun = mutation({
  args: { ...secretArg, hostId: v.id("routineHosts"), id: v.string(), runTokenHash: v.optional(v.string()), now: v.number() },
  handler: async (ctx, { secret, hostId, id, runTokenHash, now }) => {
    assertService(secret);
    const h = await ctx.db.get(hostId);
    const routineId = ctx.db.normalizeId("routines", id);
    const r = routineId ? await ctx.db.get(routineId) : null;
    if (!h || !r || !(await runsOn(ctx, h, r))) return { ok: false as const, error: "no_such_routine" };
    const stale = await ctx.db
      .query("routineRuns")
      .withIndex("by_routine", (q) => q.eq("routineId", r._id))
      .order("desc")
      .take(5);
    for (const run of stale) if (run.status === "running") await ctx.db.patch(run._id, { status: "failed", finishedAt: now });
    const trigger = r.runRequestedAt ? ("manual" as const) : ("schedule" as const);
    const startedByName = trigger === "manual" ? r.runRequestedBy : undefined;
    const runId = await ctx.db.insert("routineRuns", {
      routineId: r._id,
      userId: r.userId,
      hostId,
      trigger,
      status: "running",
      startedByName,
      startedAt: now,
      ...(r.bot && runTokenHash ? { runTokenHash } : {}),
    });
    // A bot's run that starts with an answer or a message continues its last session with it.
    const pending = r.bot && r.pendingMessageId ? await ctx.db.get(r.pendingMessageId) : null;
    // What the gateway needs to wake a bot (docs/bots.md, "How a bot wakes up"): its last session,
    // and when its last run started and ended (what's new in its thread since).
    const previous = r.bot ? { session: r.lastSessionId ?? null, startedAt: r.lastRun?.startedAt ?? null, finishedAt: r.lastRun?.finishedAt ?? null, status: r.lastRun?.status ?? null } : null;
    await ctx.db.patch(r._id, { runRequestedAt: undefined, runRequestedBy: undefined, pendingMessageId: undefined, lastRun: { status: "running", startedAt: now } });
    await pruneRuns(ctx, r._id);
    // A bot gets only the secrets granted to it; a loop (or a bot from before grants) all of its owner's.
    const granted = r.bot?.secrets ? new Set(r.bot.secrets) : null;
    const secrets = (await secretRows(ctx, r.userId, r.teamId)).filter((s) => !granted || granted.has(s.name)).map((s) => ({ name: s.name, iv: s.valueIv, ct: s.valueCt }));
    const resume = pending ? { id: pending._id, sessionId: r.lastSessionId ?? null, kind: pending.kind, iv: pending.iv, ct: pending.ct, authorName: pending.authorName ?? null, authorId: pending.authorId ?? null } : null;
    return { ok: true as const, runId, trigger, routine: routineShape(r), secrets, resume, previous };
  },
});

export const finishRun = mutation({
  args: {
    ...secretArg,
    hostId: v.id("routineHosts"),
    runId: v.string(),
    status: runStatus,
    exitCode: v.optional(v.number()),
    summaryIv: v.optional(v.string()),
    summaryCt: v.optional(v.string()),
    costUsd: v.optional(v.number()),
    turns: v.optional(v.number()),
    sessionId: v.optional(v.string()),
    /** A bot's run: what its thread gets (the gateway sealed it), and a hash to tell news from a repeat. */
    /**
     * `keep`: a result with substance of its own (a draft, a report), shown even when the run also
     * asked something: the question may well be about it (2026-11-19: "the draft is in my last
     * message", and that message was held back).
     */
    message: v.optional(v.object({ iv: v.string(), ct: v.string(), hash: v.string(), keep: v.optional(v.boolean()) })),
    now: v.number(),
  },
  handler: async (ctx, { secret, hostId, runId, now, message, ...fields }) => {
    assertService(secret);
    const id = ctx.db.normalizeId("routineRuns", runId);
    const run = id ? await ctx.db.get(id) : null;
    if (!run || run.hostId !== hostId) return { ok: false as const, error: "no_such_run" };
    await ctx.db.patch(run._id, { ...fields, finishedAt: now });
    const r = await ctx.db.get(run.routineId);
    if (r?.lastRun && r.lastRun.startedAt === run.startedAt) {
      await ctx.db.patch(r._id, { lastRun: { status: fields.status, startedAt: run.startedAt, finishedAt: now } });
    }
    const replied = r?.bot ? await botRunMessage(ctx, r, run, fields.status, fields.sessionId, message, now) : null;
    const notice = fields.status === "failed" && r ? await failureNotice(ctx, run, r, now) : null;
    return { ok: true as const, notice, replied };
  },
});

/** Mid-run progress: the runner sends the summary, cost and turns while the run is still going. */
export const updateRunProgress = mutation({
  args: {
    ...secretArg,
    hostId: v.id("routineHosts"),
    runId: v.string(),
    summaryIv: v.optional(v.string()),
    summaryCt: v.optional(v.string()),
    costUsd: v.optional(v.number()),
    turns: v.optional(v.number()),
  },
  handler: async (ctx, { secret, hostId, runId, ...fields }) => {
    assertService(secret);
    const id = ctx.db.normalizeId("routineRuns", runId);
    const run = id ? await ctx.db.get(id) : null;
    if (!run || run.hostId !== hostId || run.status !== "running") return { ok: false as const };
    await ctx.db.patch(run._id, fields);
    return { ok: true as const };
  },
});

/**
 * What a bot's finished run puts in its thread: a failure always; a result when the bot reports
 * every run, or when it says something new and isn't waiting for an answer (its question is the
 * news then). Keeps the session to continue the conversation with.
 */
async function botRunMessage(
  ctx: MutationCtx,
  r: Doc<"routines">,
  run: Doc<"routineRuns">,
  status: "running" | "succeeded" | "failed",
  sessionId: string | undefined,
  message: { iv: string; ct: string; hash: string; keep?: boolean } | undefined,
  now: number,
) {
  const patch: Partial<Doc<"routines">> = {};
  const failed = status === "failed";
  if (sessionId) patch.lastSessionId = sessionId;
  // A run that failed without a session (its session to resume was gone, say) starts the next one afresh.
  else if (failed) patch.lastSessionId = undefined;
  // Held back only for a question this run asked, and only when it's short (the question is the
  // news then). A result with substance (`keep`) shows; a question left open from an earlier run
  // must not swallow what this run did.
  const question = r.openQuestionId ? await ctx.db.get(r.openQuestionId) : null;
  const asked = Boolean(question && !question.answeredAt && question.runId === run._id);
  const fresh = message && message.hash !== r.lastResultHash;
  if (message && (failed || r.bot?.report === "every_run" || (fresh && (!asked || message.keep)))) {
    // Before the question it may be about, in the thread's order.
    const at = asked && question ? Math.min(now, question.createdAt - 1) : now;
    await ctx.db.insert("botMessages", { routineId: r._id, teamId: r.teamId, role: "bot", kind: failed ? "failure" : "result", iv: message.iv, ct: message.ct, runId: run._id, createdAt: at });
    if (!failed) patch.lastResultHash = message.hash;
    if (Object.keys(patch).length) await ctx.db.patch(r._id, patch);
    // A team bot's answer, in its group chat: whoever wrote to it since it last said something hears it.
    if (r.teamId && !failed) {
      const since = await ctx.db
        .query("botMessages")
        .withIndex("by_routine", (q) => q.eq("routineId", r._id).lt("createdAt", at))
        .order("desc")
        .take(50);
      const waiting = new Set<string>();
      for (const m of since) {
        if (m.role === "bot") break;
        if (m.role === "user" && m.authorId) waiting.add(String(m.authorId));
      }
      const team = await ctx.db.get(r.teamId);
      return waiting.size ? { to: [...waiting], routineId: r._id, name: r.name, team: team?.name ?? null, face: r.bot?.face ?? "classic", color: r.bot?.color ?? null, wear: r.bot?.wear ?? null } : null;
    }
    return null;
  }
  if (Object.keys(patch).length) await ctx.db.patch(r._id, patch);
  return null;
}

/** A routine that keeps failing is pushed about again after this long. */
const NOTICE_REPEAT_MS = 24 * 3600_000;

/**
 * Whether a failed run is worth a push to the routine's owner (who made it, for a team's): when
 * it's news. The routine worked last time (or never ran), someone pressed Run Now, or it has kept
 * failing for a day since the last push. An hourly routine that broke pushes once, not every
 * hour. Records the push it decides on.
 */
async function failureNotice(ctx: MutationCtx, run: Doc<"routineRuns">, r: Doc<"routines">, now: number) {
  const recent = await ctx.db
    .query("routineRuns")
    .withIndex("by_routine", (q) => q.eq("routineId", r._id).lt("startedAt", run.startedAt))
    .order("desc")
    .take(10);
  const previous = recent.find((x) => x.status !== "running");
  const news = run.trigger === "manual" || previous?.status !== "failed" || !r.failureNoticeAt || now - r.failureNoticeAt >= NOTICE_REPEAT_MS;
  if (!news) return null;
  // A team routine's notice goes to whoever started the run only while they're still in the team.
  if (r.teamId) {
    const teamId = r.teamId;
    const member = await ctx.db.query("members").withIndex("by_team_user", (q) => q.eq("teamId", teamId).eq("userId", run.userId)).unique();
    if (!member) return null;
  }
  await ctx.db.patch(r._id, { failureNoticeAt: now });
  const team = r.teamId ? await ctx.db.get(r.teamId) : null;
  return { uid: run.userId, routineId: r._id, runId: run._id, name: r.name, team: team?.name ?? null };
}

/** Which owner a run's summary is sealed for (the gateway seals before finishRun). */
export const runOwner = query({
  args: { ...secretArg, hostId: v.id("routineHosts"), runId: v.string() },
  handler: async (ctx, { secret, hostId, runId }) => {
    assertService(secret);
    const id = ctx.db.normalizeId("routineRuns", runId);
    const run = id ? await ctx.db.get(id) : null;
    if (!run || run.hostId !== hostId) return null;
    const r = await ctx.db.get(run.routineId);
    return { uid: run.userId, teamId: r?.teamId ?? null, bot: Boolean(r?.bot), routineId: run.routineId, startedAt: run.startedAt, name: r?.name ?? "" };
  },
});

// ---- whose Claude a computer uses (docs/bots.md) ----

/** A computer the user may set Claude for: their own (also one serving their team), or the computer of a team they manage. */
async function claudeHost(ctx: { db: QueryCtx["db"] }, uid: Id<"users">, id: string) {
  const hostId = ctx.db.normalizeId("routineHosts", id);
  const h = hostId ? await ctx.db.get(hostId) : null;
  if (!h) return null;
  if (h.userId === uid) return h;
  if (h.teamId) return (await manages(ctx, uid, h.teamId)) ? h : null;
  return null;
}

/** Store a plan token or an API key (sealed by the gateway) and use it. */
export const setClaude = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), kind: v.union(v.literal("plan"), v.literal("key")), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, id, kind, iv, ct, now }) => {
    assertService(secret);
    const h = await claudeHost(ctx, uid, id);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    const user = await ctx.db.get(uid);
    const stored = { iv, ct, by: user?.name, at: now };
    await ctx.db.patch(h._id, { claude: { ...(h.claude ?? {}), use: kind, [kind]: stored } });
    return { ok: true as const, host: hostShape((await ctx.db.get(h._id))!) };
  },
});

/**
 * The computer stores its own Claude plan (install.sh signed Claude in there with `claude
 * setup-token`): sealed by the gateway, and used. For a team's server, whose sign-in only its
 * owner and admins change in the app; a person's computer goes through setClaude as its owner.
 */
export const setClaudeByHost = mutation({
  args: { ...secretArg, hostId: v.id("routineHosts"), kind: v.union(v.literal("plan"), v.literal("key")), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, hostId, kind, iv, ct, now }) => {
    assertService(secret);
    const h = await ctx.db.get(hostId);
    if (!h?.tokenHash) return { ok: false as const, error: "no_such_computer" };
    const stored = { iv, ct, by: "the computer's setup", at: now };
    await ctx.db.patch(h._id, { claude: { ...(h.claude ?? {}), use: kind, [kind]: stored } });
    return { ok: true as const, host: hostShape((await ctx.db.get(h._id))!) };
  },
});

/** Switch which sign-in the computer uses. */
export const useClaude = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), use: v.union(v.literal("plan"), v.literal("key"), v.literal("computer")) },
  handler: async (ctx, { secret, uid, id, use }) => {
    assertService(secret);
    const h = await claudeHost(ctx, uid, id);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    if (use === "plan" && !h.claude?.plan) return { ok: false as const, error: "no_plan" };
    if (use === "key" && !h.claude?.key) return { ok: false as const, error: "no_key" };
    await ctx.db.patch(h._id, { claude: { ...(h.claude ?? {}), use } });
    return { ok: true as const, host: hostShape((await ctx.db.get(h._id))!) };
  },
});

/** Remove a stored plan or key; the computer falls back to the other, or its own sign-in. */
export const removeClaude = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), kind: v.union(v.literal("plan"), v.literal("key")) },
  handler: async (ctx, { secret, uid, id, kind }) => {
    assertService(secret);
    const h = await claudeHost(ctx, uid, id);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    const rest = { ...(h.claude ?? { use: "computer" as const }) };
    delete rest[kind];
    const other = kind === "plan" ? "key" : "plan";
    const use = rest.use === kind ? (rest[other] ? other : "computer") : rest.use;
    await ctx.db.patch(h._id, { claude: { ...rest, use } });
    return { ok: true as const, host: hostShape((await ctx.db.get(h._id))!) };
  },
});

/** The computer's chosen sign-in (sealed), for the computer itself; null: its own. */
export const hostClaude = query({
  args: { ...secretArg, hostId: v.id("routineHosts") },
  handler: async (ctx, { secret, hostId }) => {
    assertService(secret);
    const h = await ctx.db.get(hostId);
    if (!h?.claude || h.claude.use === "computer") return null;
    const c = h.claude[h.claude.use];
    if (!c) return null;
    return { kind: h.claude.use, iv: c.iv, ct: c.ct, at: c.at, uid: h.userId ?? null, teamId: h.teamId ?? null };
  },
});

// ---- how a computer's Codex bots sign in to OpenAI (docs/bots.md, "Codex next to Claude Code") ----

/** Store an OpenAI API key (sealed) and use it. */
export const setOpenAI = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, id, iv, ct, now }) => {
    assertService(secret);
    const h = await claudeHost(ctx, uid, id);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    const user = await ctx.db.get(uid);
    await ctx.db.patch(h._id, { openai: { use: "key", key: { iv, ct, by: user?.name, at: now } } });
    return { ok: true as const, host: hostShape((await ctx.db.get(h._id))!) };
  },
});

/** Use the stored key, or the computer's own Codex sign-in (its ChatGPT plan). */
export const useOpenAI = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), use: v.union(v.literal("plan"), v.literal("key")) },
  handler: async (ctx, { secret, uid, id, use }) => {
    assertService(secret);
    const h = await claudeHost(ctx, uid, id);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    if (use === "key" && !h.openai?.key) return { ok: false as const, error: "no_openai_key" };
    await ctx.db.patch(h._id, { openai: { ...(h.openai ?? {}), use } });
    return { ok: true as const, host: hostShape((await ctx.db.get(h._id))!) };
  },
});

/** Remove the stored key; the computer's own sign-in is used. */
export const removeOpenAI = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string() },
  handler: async (ctx, { secret, uid, id }) => {
    assertService(secret);
    const h = await claudeHost(ctx, uid, id);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    await ctx.db.patch(h._id, { openai: { use: "plan" } });
    return { ok: true as const, host: hostShape((await ctx.db.get(h._id))!) };
  },
});

/** The computer's stored key (sealed) when it uses one, for the computer itself; null: its own sign-in. */
export const hostOpenAI = query({
  args: { ...secretArg, hostId: v.id("routineHosts") },
  handler: async (ctx, { secret, hostId }) => {
    assertService(secret);
    const h = await ctx.db.get(hostId);
    if (h?.openai?.use !== "key" || !h.openai.key) return null;
    return { iv: h.openai.key.iv, ct: h.openai.key.ct, at: h.openai.key.at, uid: h.userId ?? null, teamId: h.teamId ?? null };
  },
});

// ---- a computer's model, Ambient's access there, and root commands waiting for approval ----

/** The default model for the computer's runs and Ambient there (null: Claude Code's own). */
export const setModel = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), model: v.union(modelChoice, v.null()) },
  handler: async (ctx, { secret, uid, id, model }) => {
    assertService(secret);
    const h = await claudeHost(ctx, uid, id);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    await ctx.db.patch(h._id, { model: model ?? undefined });
    return { ok: true as const, host: hostShape((await ctx.db.get(h._id))!) };
  },
});

/** What Ambient may do there. `onlyLower`: an AI app asked, which may only take access away. */
export const setAccess = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), access: v.union(v.literal("standard"), v.literal("admin"), v.literal("full")), onlyLower: v.boolean() },
  handler: async (ctx, { secret, uid, id, access, onlyLower }) => {
    assertService(secret);
    const h = await claudeHost(ctx, uid, id);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    const rank = { standard: 0, admin: 1, full: 2 } as const;
    if (onlyLower && rank[access] > rank[h.access ?? "standard"]) return { ok: false as const, error: "raise_in_app" };
    await ctx.db.patch(h._id, { access });
    return { ok: true as const, host: hostShape((await ctx.db.get(h._id))!) };
  },
});

export const removeAllowed = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), command: v.string() },
  handler: async (ctx, { secret, uid, id, command }) => {
    assertService(secret);
    const h = await claudeHost(ctx, uid, id);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    await ctx.db.patch(h._id, { allowed: (h.allowed ?? []).filter((c) => c !== command) });
    return { ok: true as const, host: hostShape((await ctx.db.get(h._id))!) };
  },
});

/** The computer as Ambient's root commands see it: may this person act there, and how. */
export const hostForAdmin = query({
  args: { ...secretArg, uid: v.id("users"), id: v.string() },
  handler: async (ctx, { secret, uid, id }) => {
    assertService(secret);
    const h = await claudeHost(ctx, uid, id);
    if (!h) return null;
    return { id: h._id, name: h.name, teamId: h.teamId ?? null, ownerUid: h.userId ?? null, access: h.access ?? "standard", allowed: h.allowed ?? [] };
  },
});

const APPROVAL_TTL_MS = 10 * 60_000;

export const requestApproval = mutation({
  args: { ...secretArg, uid: v.id("users"), hostId: v.id("routineHosts"), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, hostId, iv, ct, now }) => {
    assertService(secret);
    const id = await ctx.db.insert("approvals", { hostId, uid, iv, ct, status: "pending", createdAt: now, expiresAt: now + APPROVAL_TTL_MS });
    return { id, expiresAt: now + APPROVAL_TTL_MS };
  },
});

function approvalShape(a: Doc<"approvals">, now: number) {
  const status = a.status === "pending" && a.expiresAt < now ? ("expired" as const) : a.status;
  return { id: a._id, hostId: a.hostId, iv: a.iv, ct: a.ct, status, decision: a.decision ?? null, createdAt: a.createdAt, expiresAt: a.expiresAt };
}

/** The person's pending approvals, newest first. */
export const approvals = query({
  args: { ...secretArg, uid: v.id("users"), now: v.number() },
  handler: async (ctx, { secret, uid, now }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("approvals")
      .withIndex("by_user", (q) => q.eq("uid", uid))
      .order("desc")
      .take(50);
    return rows.map((a) => approvalShape(a, now)).filter((a) => a.status === "pending");
  },
});

export const approval = query({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, id, now }) => {
    assertService(secret);
    const aid = ctx.db.normalizeId("approvals", id);
    const a = aid ? await ctx.db.get(aid) : null;
    return a && a.uid === uid ? approvalShape(a, now) : null;
  },
});

/** The person decides; "always" also adds the command to the computer's always-allowed list. */
export const decide = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), decision: v.union(v.literal("once"), v.literal("session"), v.literal("always"), v.literal("deny")), command: v.optional(v.string()), now: v.number() },
  handler: async (ctx, { secret, uid, id, decision, command, now }) => {
    assertService(secret);
    const aid = ctx.db.normalizeId("approvals", id);
    const a = aid ? await ctx.db.get(aid) : null;
    if (!a || a.uid !== uid) return { ok: false as const, error: "no_such_approval" };
    if (a.status !== "pending" || a.expiresAt < now) return { ok: false as const, error: "already_decided" };
    // Whoever decides must still be allowed to change the computer.
    const h = await claudeHost(ctx, uid, a.hostId);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    await ctx.db.patch(a._id, { status: decision === "deny" ? "denied" : "approved", decision, decidedAt: now });
    if (decision === "always" && command) await ctx.db.patch(h._id, { allowed: [...new Set([...(h.allowed ?? []), command])].slice(-100) });
    return { ok: true as const, approval: approvalShape((await ctx.db.get(a._id))!, now) };
  },
});
