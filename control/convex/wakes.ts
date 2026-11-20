// Wake-ups (docs/bots.md, "Wake-ups"): times a bot books for itself ("draft the post Tuesday at
// 09:00 so my owner can review it before Thursday"). At its time a wake-up writes its note into the
// bot's thread (author "Wake-up") and starts a run with it, the way a message does. The gateway's
// ticker fires what's due (gateway/src/bots/wakes.ts); the note is sealed there.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { runByToken } from "./bots.js";
import { assertService, secretArg } from "./lib/service.js";
import { manages, routineFor, teamComputer } from "./routines.js";

const access = { uid: v.id("users"), teamIds: v.array(v.id("teams")) };

/** At most this many booked at once, per bot. */
export const MAX_PENDING = 5;
/** Not sooner than this from now: what's due sooner it does in this run. */
export const MIN_AHEAD_MS = 10 * 60_000;
/** Not further ahead than this. */
export const MAX_AHEAD_MS = 30 * 24 * 3_600_000;
/** Two wake-ups at least this far apart (one wake-up does everything due then). */
export const MIN_GAP_MS = 60 * 60_000;

function wakeShape(w: Doc<"botWakes">) {
  return { id: w._id, routineId: w.routineId, at: w.at, iv: w.iv, ct: w.ct, byRun: Boolean(w.runId), createdAt: w.createdAt };
}

async function pendingOf(ctx: { db: QueryCtx["db"] }, routineId: Id<"routines">) {
  return ctx.db
    .query("botWakes")
    .withIndex("by_routine", (q) => q.eq("routineId", routineId).eq("status", "pending"))
    .take(MAX_PENDING * 4);
}

/** The routine's nextWakeAt, from what's still booked. */
async function keepNext(ctx: MutationCtx, routineId: Id<"routines">) {
  const next = (await pendingOf(ctx, routineId))[0];
  const r = await ctx.db.get(routineId);
  if (r && r.nextWakeAt !== next?.at) await ctx.db.patch(routineId, { nextWakeAt: next?.at });
}

type Refusal = "run_over" | "too_soon" | "too_far" | "too_many" | "too_close";

async function book(ctx: MutationCtx, r: Doc<"routines">, at: number, iv: string, ct: string, now: number, runId?: Id<"routineRuns">) {
  const refuse = (error: Refusal, extra: Record<string, unknown> = {}) => ({ ok: false as const, error, ...extra });
  if (at < now + MIN_AHEAD_MS) return refuse("too_soon");
  if (at > now + MAX_AHEAD_MS) return refuse("too_far");
  const pending = await pendingOf(ctx, r._id);
  if (pending.length >= MAX_PENDING) return refuse("too_many", { pending: pending.map(wakeShape) });
  const near = pending.find((w) => Math.abs(w.at - at) < MIN_GAP_MS);
  if (near) return refuse("too_close", { near: wakeShape(near) });
  const id = await ctx.db.insert("botWakes", { routineId: r._id, teamId: r.teamId, at, iv, ct, status: "pending", ...(runId ? { runId } : {}), createdAt: now });
  await keepNext(ctx, r._id);
  return { ok: true as const, wake: wakeShape((await ctx.db.get(id))!) };
}

async function cancel(ctx: MutationCtx, r: Doc<"routines">, wakeId: string, by: string) {
  const id = ctx.db.normalizeId("botWakes", wakeId);
  const w = id ? await ctx.db.get(id) : null;
  if (!w || w.routineId !== r._id || w.status !== "pending") return { ok: false as const, error: "no_such_wake" as const };
  await ctx.db.patch(w._id, { status: "cancelled", cancelledBy: by });
  await keepNext(ctx, r._id);
  return { ok: true as const, wake: wakeShape(w) };
}

// ---- a run's side (its run token: the runner's wake_me tools) ----

export const bookForRun = mutation({
  args: { ...secretArg, runTokenHash: v.string(), at: v.number(), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, runTokenHash, at, iv, ct, now }) => {
    assertService(secret);
    const found = await runByToken(ctx, runTokenHash);
    if (!found) return { ok: false as const, error: "run_over" as const };
    return book(ctx, found.r, at, iv, ct, now, found.run._id);
  },
});

export const forRun = query({
  args: { ...secretArg, runTokenHash: v.string() },
  handler: async (ctx, { secret, runTokenHash }) => {
    assertService(secret);
    const found = await runByToken(ctx, runTokenHash);
    if (!found) return null;
    return { routineId: found.r._id, timezone: found.r.schedule.timezone, wakes: (await pendingOf(ctx, found.r._id)).map(wakeShape) };
  },
});

export const cancelForRun = mutation({
  args: { ...secretArg, runTokenHash: v.string(), wakeId: v.string() },
  handler: async (ctx, { secret, runTokenHash, wakeId }) => {
    assertService(secret);
    const found = await runByToken(ctx, runTokenHash);
    if (!found) return { ok: false as const, error: "run_over" as const };
    return cancel(ctx, found.r, wakeId, "bot");
  },
});

// ---- the owner's side (the app, MCP): whoever sees a bot sees its wake-ups; whoever may change it books and cancels ----

export const list = query({
  args: { ...secretArg, ...access, id: v.string() },
  handler: async (ctx, { secret, uid, teamIds, id }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r?.bot) return null;
    return { timezone: r.schedule.timezone, wakes: (await pendingOf(ctx, r._id)).map(wakeShape) };
  },
});

export const bookForOwner = mutation({
  args: { ...secretArg, ...access, id: v.string(), at: v.number(), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, teamIds, id, at, iv, ct, now }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r?.bot) return { ok: false as const, error: "no_such_bot" as const };
    if (r.teamId && !(await manages(ctx, uid, r.teamId))) return { ok: false as const, error: "admins_only" as const };
    return book(ctx, r, at, iv, ct, now);
  },
});

export const cancelForOwner = mutation({
  args: { ...secretArg, ...access, id: v.string(), wakeId: v.string(), by: v.string() },
  handler: async (ctx, { secret, uid, teamIds, id, wakeId, by }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r?.bot) return { ok: false as const, error: "no_such_bot" as const };
    if (r.teamId && !(await manages(ctx, uid, r.teamId))) return { ok: false as const, error: "admins_only" as const };
    return cancel(ctx, r, wakeId, by);
  },
});

// ---- firing (the gateway's ticker) ----

/** Wake-ups whose time has come, oldest first. */
export const due = query({
  args: { ...secretArg, now: v.number(), limit: v.number() },
  handler: async (ctx, { secret, now, limit }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("botWakes")
      .withIndex("by_due", (q) => q.eq("status", "pending").lte("at", now))
      .take(Math.min(Math.max(limit, 1), 100));
    return rows.map(wakeShape);
  },
});

/**
 * A wake-up's time came: its note into the thread (author "Wake-up") and, when the bot is on, a run
 * that starts with it (the same as bots.wake). A paused bot only gets the note. Once only.
 */
export const fire = mutation({
  args: { ...secretArg, wakeId: v.string(), now: v.number() },
  handler: async (ctx, { secret, wakeId, now }) => {
    assertService(secret);
    const id = ctx.db.normalizeId("botWakes", wakeId);
    const w = id ? await ctx.db.get(id) : null;
    if (!w || w.status !== "pending" || w.at > now) return { ok: false as const, error: "not_due" as const };
    await ctx.db.patch(w._id, { status: "fired", firedAt: now });
    const r = await ctx.db.get(w.routineId);
    if (!r?.bot) return { ok: false as const, error: "no_such_bot" as const };
    const messageId = await ctx.db.insert("botMessages", { routineId: r._id, teamId: r.teamId, role: "user", kind: "message", iv: w.iv, ct: w.ct, authorName: "Wake-up", createdAt: now });
    let hostId: string | null = r.hostId ?? null;
    if (r.teamId) {
      hostId = (await teamComputer(ctx, r.teamId))?._id ?? null;
    }
    if (r.enabled) {
      const pending = r.pendingMessageId ? await ctx.db.get(r.pendingMessageId) : null;
      await ctx.db.patch(r._id, { ...(pending ? {} : { pendingMessageId: messageId }), runRequestedAt: now, runRequestedBy: "Wake-up", updatedAt: now });
    }
    await keepNext(ctx, r._id);
    return { ok: true as const, routineId: r._id, hostId, enabled: r.enabled, name: r.name, owner: r.userId };
  },
});
