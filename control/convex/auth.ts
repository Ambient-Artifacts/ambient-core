// Credentials the gateway checks: pairing codes (AI-app login), app refresh
// sessions, personal access tokens. Everything secret arrives already hashed.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

// ---- Pairing codes ----

export const createPairingCode = mutation({
  args: { ...secretArg, uid: v.id("users"), codeHash: v.string(), expiresAt: v.number(), now: v.number() },
  handler: async (ctx, { secret, uid, codeHash, expiresAt, now }) => {
    assertService(secret);
    const clash = await ctx.db
      .query("pairingCodes")
      .withIndex("by_code", (q) => q.eq("codeHash", codeHash))
      .collect();
    if (clash.some((c) => !c.usedAt && c.expiresAt > now)) return false;
    // One live code per user: older ones stop working.
    for (const old of await ctx.db.query("pairingCodes").withIndex("by_user", (q) => q.eq("userId", uid)).collect()) {
      await ctx.db.delete(old._id);
    }
    await ctx.db.insert("pairingCodes", { userId: uid, codeHash, expiresAt });
    return true;
  },
});

export const consumePairingCode = mutation({
  args: { ...secretArg, codeHash: v.string(), now: v.number() },
  handler: async (ctx, { secret, codeHash, now }) => {
    assertService(secret);
    const codes = await ctx.db
      .query("pairingCodes")
      .withIndex("by_code", (q) => q.eq("codeHash", codeHash))
      .collect();
    const live = codes.find((c) => !c.usedAt && c.expiresAt > now);
    if (!live) return null;
    await ctx.db.patch(live._id, { usedAt: now });
    const user = await ctx.db.get(live.userId);
    return user && !user.disabled ? user._id : null;
  },
});

// ---- Personal access tokens ----

export const createPat = mutation({
  args: {
    ...secretArg,
    uid: v.id("users"),
    hash: v.string(),
    scopes: v.array(v.string()),
    resourceKind: v.union(v.literal("personal"), v.literal("team")),
    teamId: v.optional(v.id("teams")),
    label: v.string(),
    expiresAt: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, { secret, now, uid, ...rest }) => {
    assertService(secret);
    return ctx.db.insert("pats", { userId: uid, ...rest, createdAt: now });
  },
});

export const findPat = query({
  args: { ...secretArg, hash: v.string(), now: v.number() },
  handler: async (ctx, { secret, hash, now }) => {
    assertService(secret);
    const p = await ctx.db
      .query("pats")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();
    if (!p || p.revokedAt || (p.expiresAt && p.expiresAt < now)) return null;
    return {
      id: p._id,
      uid: p.userId,
      scopes: p.scopes,
      resource: p.resourceKind === "personal" ? { kind: "personal" as const } : { kind: "team" as const, teamId: p.teamId! },
    };
  },
});

export const revokePat = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.id("pats"), now: v.number() },
  handler: async (ctx, { secret, uid, id, now }) => {
    assertService(secret);
    const p = await ctx.db.get(id);
    if (p && p.userId === uid) await ctx.db.patch(id, { revokedAt: now });
  },
});
