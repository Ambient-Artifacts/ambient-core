// Push notifications: where each user's go (their app installs' APNs device tokens). The gateway
// registers devices for the apps and sends the notifications itself (gateway/src/push.ts); which
// events are worth one is decided next to the event (routines.finishRun), so the decision and
// what it records happen together.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

/** Installs per user; the longest-unseen goes first. */
const MAX_DEVICES = 20;

const platform = v.union(v.literal("ios"), v.literal("macos"));

/** An app install's token for `uid`. A token another account had moves here (signed in anew). */
export const registerDevice = mutation({
  args: { ...secretArg, uid: v.id("users"), token: v.string(), sandbox: v.boolean(), platform, timeZone: v.optional(v.string()), now: v.number() },
  handler: async (ctx, { secret, uid, token, sandbox, platform, timeZone, now }) => {
    assertService(secret);
    const zone = timeZone ? { timeZone } : {};
    const existing = await ctx.db.query("pushDevices").withIndex("by_token", (q) => q.eq("token", token)).unique();
    if (existing) {
      await ctx.db.patch(existing._id, { userId: uid, sandbox, platform, ...zone, updatedAt: now });
      return;
    }
    await ctx.db.insert("pushDevices", { userId: uid, token, sandbox, platform, ...zone, updatedAt: now });
    const all = await ctx.db.query("pushDevices").withIndex("by_user", (q) => q.eq("userId", uid)).collect();
    const oldest = all.sort((a, b) => b.updatedAt - a.updatedAt).slice(MAX_DEVICES);
    for (const d of oldest) await ctx.db.delete(d._id);
  },
});

/** Signing out (`uid`: only if it's still theirs), or Apple refusing the token (no `uid`). */
export const removeDevice = mutation({
  args: { ...secretArg, uid: v.optional(v.id("users")), token: v.string() },
  handler: async (ctx, { secret, uid, token }) => {
    assertService(secret);
    const d = await ctx.db.query("pushDevices").withIndex("by_token", (q) => q.eq("token", token)).unique();
    if (d && (!uid || d.userId === uid)) await ctx.db.delete(d._id);
  },
});

/** Apple took the token in the other environment (a build that isn't what it said it was). */
export const setSandbox = mutation({
  args: { ...secretArg, token: v.string(), sandbox: v.boolean() },
  handler: async (ctx, { secret, token, sandbox }) => {
    assertService(secret);
    const d = await ctx.db.query("pushDevices").withIndex("by_token", (q) => q.eq("token", token)).unique();
    if (d) await ctx.db.patch(d._id, { sandbox });
  },
});

export const devices = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const rows = await ctx.db.query("pushDevices").withIndex("by_user", (q) => q.eq("userId", uid)).take(MAX_DEVICES * 2);
    return rows.map((d) => ({ token: d.token, sandbox: d.sandbox, platform: d.platform }));
  },
});

/**
 * Who could get the morning push of open action items: users with an app install, in the time
 * zone of the install they used last, with the day it last went and whether they turned it off.
 */
export const digestCandidates = query({
  args: { ...secretArg, limit: v.optional(v.number()) },
  handler: async (ctx, { secret, limit }) => {
    assertService(secret);
    const latest = new Map<string, { timeZone: string | null; at: number }>();
    for (const d of await ctx.db.query("pushDevices").take(limit ?? 5000)) {
      const have = latest.get(d.userId);
      if (!have || d.updatedAt > have.at) latest.set(d.userId, { timeZone: d.timeZone ?? have?.timeZone ?? null, at: d.updatedAt });
    }
    const out: { uid: string; timeZone: string | null; sentOn: string | null; off: boolean }[] = [];
    for (const [uid, d] of latest) {
      const user = await ctx.db.get(uid as never);
      const u = user as { disabled?: boolean; deletingAt?: number; digest?: boolean; digestSentOn?: string } | null;
      if (!u || u.disabled || u.deletingAt) continue;
      out.push({ uid, timeZone: d.timeZone, sentOn: u.digestSentOn ?? null, off: u.digest === false });
    }
    return out;
  },
});

/** The morning push was considered for the user's local `day`. */
export const markDigest = mutation({
  args: { ...secretArg, uid: v.id("users"), day: v.string() },
  handler: async (ctx, { secret, uid, day }) => {
    assertService(secret);
    await ctx.db.patch(uid, { digestSentOn: day });
  },
});
