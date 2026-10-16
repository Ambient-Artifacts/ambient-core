// Personal wikis connected to the user's own git repo. Only the gateway calls these; the token
// and sync state arrive encrypted with the user's data key.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";


export const get = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    return await ctx.db.query("repos").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
  },
});

export const connect = mutation({
  args: { ...secretArg, uid: v.id("users"), url: v.string(), branch: v.string(), tokenIv: v.string(), tokenCt: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, url, branch, tokenIv, tokenCt, now }) => {
    assertService(secret);
    const existing = await ctx.db.query("repos").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("repos", { userId: uid, url, branch, tokenIv, tokenCt, status: "ok", createdAt: now });
  },
});

export const disconnect = mutation({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const existing = await ctx.db.query("repos").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

/** After a sync: new encrypted state on success, or the error. */
export const record = mutation({
  args: {
    ...secretArg,
    uid: v.id("users"),
    ok: v.boolean(),
    stateIv: v.optional(v.string()),
    stateCt: v.optional(v.string()),
    error: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, { secret, uid, ok, stateIv, stateCt, error, now }) => {
    assertService(secret);
    const r = await ctx.db.query("repos").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    if (!r) return;
    await ctx.db.patch(r._id, ok ? { status: "ok", lastSyncAt: now, lastError: undefined, ...(stateCt ? { stateIv, stateCt } : {}) } : { status: "error", lastError: error?.slice(0, 300) });
  },
});

/** Every connected user, for the worker's periodic sync and the health check. */
export const connected = query({
  args: { ...secretArg },
  handler: async (ctx, { secret }) => {
    assertService(secret);
    const rows = await ctx.db.query("repos").collect();
    return rows.map((r) => ({ uid: r.userId, status: r.status, lastSyncAt: r.lastSyncAt ?? null, lastError: r.lastError ?? null }));
  },
});
