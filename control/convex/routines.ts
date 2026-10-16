// Routines: prompts Claude Code runs on a schedule. A personal routine runs on one of the
// user's computers; a team's runs on the team's server. The gateway seals prompts, run
// summaries and secrets with the owner's data key, and decides who may do what: it passes the
// user's id and the teams they may read (or, for changes, manage), and these functions only
// touch rows owned by one of those. The computer (a "host") reads its routines and reports
// runs through the gateway with its own token.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";
import { routineSchedule, runStatus } from "./schema.js";

const MAX_ROUTINES = 50;
const MAX_HOSTS = 10;
const MAX_SECRETS = 30;
const KEEP_RUNS = 50;

const access = { uid: v.id("users"), teamIds: v.array(v.id("teams")) };
const hostInfo = v.object({ hostname: v.string(), os: v.string(), runner: v.string(), claude: v.string() });

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
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function hostShape(h: Doc<"routineHosts">) {
  return {
    id: h._id,
    teamId: h.teamId ?? null,
    name: h.name,
    ready: Boolean(h.tokenHash),
    codeExpiresAt: h.tokenHash ? null : (h.codeExpiresAt ?? null),
    info: h.info ?? null,
    lastSeenAt: h.lastSeenAt ?? null,
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

/** A routine the user may see (reads) or change (writes): theirs, or one of the given teams'. */
async function routineFor(ctx: { db: QueryCtx["db"] }, uid: Id<"users">, teamIds: Id<"teams">[], id: string) {
  const routineId = ctx.db.normalizeId("routines", id);
  const r = routineId ? await ctx.db.get(routineId) : null;
  if (!r) return null;
  return (r.teamId ? teamIds.includes(r.teamId) : r.userId === uid) ? r : null;
}

async function ownHost(ctx: { db: QueryCtx["db"] }, uid: Id<"users">, id: string) {
  const hostId = ctx.db.normalizeId("routineHosts", id);
  const h = hostId ? await ctx.db.get(hostId) : null;
  return h && h.userId === uid && !h.teamId ? h : null;
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
    const hosts = (await ctx.db.query("routineHosts").withIndex("by_user", (q) => q.eq("userId", uid)).take(MAX_HOSTS * 2)).filter((h) => !h.teamId);
    for (const teamId of teamIds) {
      routines.push(...(await teamRoutines(ctx, teamId)));
      hosts.push(...(await ctx.db.query("routineHosts").withIndex("by_team", (q) => q.eq("teamId", teamId)).take(5)));
    }
    return {
      routines: routines.sort((a, b) => a.createdAt - b.createdAt).map(routineShape),
      hosts: hosts.sort((a, b) => a.createdAt - b.createdAt).map(hostShape),
    };
  },
});

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
    source: v.string(),
    now: v.number(),
  },
  handler: async (ctx, { secret, uid, teamId, hostId, now, ...fields }) => {
    assertService(secret);
    const count = teamId ? (await teamRoutines(ctx, teamId)).length : (await personalRoutines(ctx, uid)).length;
    if (count >= MAX_ROUTINES) return { ok: false as const, error: "too_many_routines" };
    let host: Doc<"routineHosts"> | null = null;
    if (hostId && !teamId) {
      host = await ownHost(ctx, uid, hostId);
      if (!host) return { ok: false as const, error: "no_such_computer" };
    }
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
    source: v.string(),
    now: v.number(),
  },
  handler: async (ctx, { secret, uid, teamIds, id, hostId, folder, now, ...fields }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r) return { ok: false as const, error: "no_such_routine" };
    const patch: Partial<Doc<"routines">> = { updatedAt: now, source: fields.source };
    if (fields.name !== undefined) patch.name = fields.name;
    if (fields.promptIv !== undefined && fields.promptCt !== undefined) {
      patch.promptIv = fields.promptIv;
      patch.promptCt = fields.promptCt;
    }
    if (fields.schedule !== undefined) patch.schedule = fields.schedule;
    if (fields.enabled !== undefined) patch.enabled = fields.enabled;
    if (folder !== undefined) patch.folder = folder ?? undefined;
    if (hostId !== undefined && !r.teamId) {
      if (hostId === null) patch.hostId = undefined;
      else {
        const host = await ownHost(ctx, uid, hostId);
        if (!host) return { ok: false as const, error: "no_such_computer" };
        patch.hostId = host._id;
      }
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
    const runs = await ctx.db.query("routineRuns").withIndex("by_routine", (q) => q.eq("routineId", r._id)).take(KEEP_RUNS * 4);
    for (const run of runs) await ctx.db.delete(run._id);
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
    if (r.teamId) {
      const server = await ctx.db.query("routineHosts").withIndex("by_team", (q) => q.eq("teamId", r.teamId)).first();
      if (!server?.tokenHash) return { ok: false as const, error: "no_team_server" };
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

/** Remove one of the user's computers. Its routines stay, without a computer, until they're given another. */
export const removeHost = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, id, now }) => {
    assertService(secret);
    const h = await ownHost(ctx, uid, id);
    if (!h) return { ok: false as const, error: "no_such_computer" };
    const routines = await ctx.db.query("routines").withIndex("by_host", (q) => q.eq("hostId", h._id)).take(MAX_ROUTINES * 2);
    for (const r of routines) await ctx.db.patch(r._id, { hostId: undefined, updatedAt: now });
    await ctx.db.delete(h._id);
    return { ok: true as const };
  },
});

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
      for (const old of await ctx.db.query("routineHosts").withIndex("by_team", (q) => q.eq("teamId", t._id)).collect()) await ctx.db.delete(old._id);
      const id = await ctx.db.insert("routineHosts", { teamId: t._id, name, codeHash, codeExpiresAt: expiresAt, createdAt: Date.now() });
      return { id, team: t.slug };
    }
    const want = (email ?? "").trim().toLowerCase();
    const users = (await ctx.db.query("users").collect()).filter((u) => u.email?.toLowerCase() === want && !u.disabled);
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
  args: { ...secretArg, uid: v.id("users"), teamId: v.optional(v.id("teams")), name: v.string(), valueIv: v.string(), valueCt: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, teamId, name, valueIv, valueCt, now }) => {
    assertService(secret);
    const rows = await secretRows(ctx, uid, teamId);
    const existing = rows.find((r) => r.name === name);
    if (existing) {
      await ctx.db.patch(existing._id, { valueIv, valueCt, updatedBy: uid, updatedAt: now });
      return { ok: true as const };
    }
    if (rows.length >= MAX_SECRETS) return { ok: false as const, error: "too_many_secrets" };
    await ctx.db.insert("routineSecrets", { ...(teamId ? { teamId } : { userId: uid }), name, valueIv, valueCt, updatedBy: uid, updatedAt: now });
    return { ok: true as const };
  },
});

export const removeSecret = mutation({
  args: { ...secretArg, uid: v.id("users"), teamId: v.optional(v.id("teams")), name: v.string() },
  handler: async (ctx, { secret, uid, teamId, name }) => {
    assertService(secret);
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
    return { ok: true as const, host: { id: h._id, uid: h.userId ?? null, teamId: h.teamId ?? null, name: h.name } };
  },
});

export const hostByToken = query({
  args: { ...secretArg, tokenHash: v.string() },
  handler: async (ctx, { secret, tokenHash }) => {
    assertService(secret);
    const h = await ctx.db.query("routineHosts").withIndex("by_token", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!h) return null;
    if (h.teamId) {
      const team = await ctx.db.get(h.teamId);
      if (!team || team.status !== "active") return null;
    }
    return { id: h._id, uid: h.userId ?? null, teamId: h.teamId ?? null, name: h.name };
  },
});

/** The routines a computer runs: its user's that name it, or all of its team's. */
async function hostRoutines(ctx: { db: QueryCtx["db"] }, h: Doc<"routineHosts">) {
  return h.teamId ? teamRoutines(ctx, h.teamId) : ctx.db.query("routines").withIndex("by_host", (q) => q.eq("hostId", h._id)).take(MAX_ROUTINES * 2);
}

function runsOn(h: Doc<"routineHosts">, r: Doc<"routines">) {
  return h.teamId ? r.teamId === h.teamId : r.hostId === h._id && !r.teamId;
}

/** The computer's routines (with their run requests); records that it checked in. */
export const hostSync = mutation({
  args: { ...secretArg, hostId: v.id("routineHosts"), info: v.optional(hostInfo), now: v.number() },
  handler: async (ctx, { secret, hostId, info, now }) => {
    assertService(secret);
    const h = await ctx.db.get(hostId);
    if (!h) return null;
    await ctx.db.patch(hostId, { lastSeenAt: now, ...(info ? { info } : {}) });
    return { routines: (await hostRoutines(ctx, h)).map(routineShape) };
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
  args: { ...secretArg, hostId: v.id("routineHosts"), id: v.string(), now: v.number() },
  handler: async (ctx, { secret, hostId, id, now }) => {
    assertService(secret);
    const h = await ctx.db.get(hostId);
    const routineId = ctx.db.normalizeId("routines", id);
    const r = routineId ? await ctx.db.get(routineId) : null;
    if (!h || !r || !runsOn(h, r)) return { ok: false as const, error: "no_such_routine" };
    const stale = await ctx.db
      .query("routineRuns")
      .withIndex("by_routine", (q) => q.eq("routineId", r._id))
      .order("desc")
      .take(5);
    for (const run of stale) if (run.status === "running") await ctx.db.patch(run._id, { status: "failed", finishedAt: now });
    const trigger = r.runRequestedAt ? ("manual" as const) : ("schedule" as const);
    const startedByName = trigger === "manual" ? r.runRequestedBy : undefined;
    const runId = await ctx.db.insert("routineRuns", { routineId: r._id, userId: r.userId, hostId, trigger, status: "running", startedByName, startedAt: now });
    await ctx.db.patch(r._id, { runRequestedAt: undefined, runRequestedBy: undefined, lastRun: { status: "running", startedAt: now } });
    await pruneRuns(ctx, r._id);
    const secrets = (await secretRows(ctx, r.userId, r.teamId)).map((s) => ({ name: s.name, iv: s.valueIv, ct: s.valueCt }));
    return { ok: true as const, runId, trigger, routine: routineShape(r), secrets };
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
    now: v.number(),
  },
  handler: async (ctx, { secret, hostId, runId, now, ...fields }) => {
    assertService(secret);
    const id = ctx.db.normalizeId("routineRuns", runId);
    const run = id ? await ctx.db.get(id) : null;
    if (!run || run.hostId !== hostId) return { ok: false as const, error: "no_such_run" };
    await ctx.db.patch(run._id, { ...fields, finishedAt: now });
    const r = await ctx.db.get(run.routineId);
    if (r?.lastRun && r.lastRun.startedAt === run.startedAt) {
      await ctx.db.patch(r._id, { lastRun: { status: fields.status, startedAt: run.startedAt, finishedAt: now } });
    }
    const notice = fields.status === "failed" && r ? await failureNotice(ctx, run, r, now) : null;
    return { ok: true as const, notice };
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
    return { uid: run.userId, teamId: r?.teamId ?? null };
  },
});
