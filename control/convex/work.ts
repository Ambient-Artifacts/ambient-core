// The personal worker's bookkeeping: who has new, settled input, and what each run did.
// The worker itself runs on the core VM (it needs the master key to decrypt pages).
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

/** Users with Claude upkeep on, new pages since the last run, and no phone write for `quietMs`. */
export const due = query({
  args: { ...secretArg, now: v.number(), quietMs: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { secret, now, quietMs, limit = 50 }) => {
    assertService(secret);
    const out: { uid: string; seq: number }[] = [];
    for await (const u of ctx.db.query("users")) {
      if (u.disabled || u.deletingAt || u.consolidate !== true || u.personalSeq === 0) continue;
      if ((u.personalWriteAt ?? 0) > now - quietMs) continue;
      const w = await ctx.db.query("personalWork").withIndex("by_user", (q) => q.eq("userId", u._id)).unique();
      if (w && w.lastSeq >= u.personalSeq) continue;
      out.push({ uid: u._id, seq: u.personalSeq });
      if (out.length >= limit) break;
    }
    return out;
  },
});

export const get = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const w = await ctx.db.query("personalWork").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    return w ? { done: w.done, lastSeq: w.lastSeq, lastRunAt: w.lastRunAt, lastStatus: w.lastStatus, lintHistory: w.lintHistory } : null;
  },
});

export const save = mutation({
  args: {
    ...secretArg,
    uid: v.id("users"),
    done: v.array(v.string()),
    lastSeq: v.number(),
    status: v.string(),
    result: v.optional(v.string()),
    lint: v.optional(v.record(v.string(), v.number())),
    now: v.number(),
  },
  handler: async (ctx, { secret, uid, done, lastSeq, status, result, lint, now }) => {
    assertService(secret);
    const w = await ctx.db.query("personalWork").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    const lintHistory = [...(w?.lintHistory ?? []), ...(lint ? [{ at: now, counts: lint }] : [])].slice(-30);
    const doc = { userId: uid, done: done.slice(-5000), lastSeq, lastRunAt: now, lastStatus: status, lastResult: result, lintHistory };
    if (w) await ctx.db.replace(w._id, doc);
    else await ctx.db.insert("personalWork", doc);
  },
});

/** For the health check: the worker's most recent runs (no note content, just status). */
export const recent = query({
  args: { ...secretArg, limit: v.optional(v.number()) },
  handler: async (ctx, { secret, limit = 100 }) => {
    assertService(secret);
    const rows = await ctx.db.query("personalWork").order("desc").take(limit);
    return rows.map((w) => ({ uid: w.userId, lastRunAt: w.lastRunAt, lastStatus: w.lastStatus, lastResult: w.lastResult ?? null }));
  },
});
