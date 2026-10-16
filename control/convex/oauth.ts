// Storage for oidc-provider (the gateway's OAuth server). Payloads are opaque
// JSON strings; expiry is enforced on read, and expired rows are swept hourly (crons.ts).
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

export const upsert = mutation({
  args: {
    ...secretArg,
    model: v.string(),
    key: v.string(),
    payload: v.string(),
    expiresAt: v.number(),
    grantId: v.optional(v.string()),
    uid: v.optional(v.string()),
    userCode: v.optional(v.string()),
  },
  handler: async (ctx, { secret, model, key, ...rest }) => {
    assertService(secret);
    const existing = await ctx.db
      .query("oauth")
      .withIndex("by_model_key", (q) => q.eq("model", model).eq("key", key))
      .unique();
    if (existing) await ctx.db.replace(existing._id, { model, key, ...rest });
    else await ctx.db.insert("oauth", { model, key, ...rest });
  },
});

export const find = query({
  args: { ...secretArg, model: v.string(), key: v.string(), now: v.number() },
  handler: async (ctx, { secret, model, key, now }) => {
    assertService(secret);
    const d = await ctx.db
      .query("oauth")
      .withIndex("by_model_key", (q) => q.eq("model", model).eq("key", key))
      .unique();
    return d && d.expiresAt > now ? d.payload : null;
  },
});

export const findByUid = query({
  args: { ...secretArg, model: v.string(), uid: v.string(), now: v.number() },
  handler: async (ctx, { secret, model, uid, now }) => {
    assertService(secret);
    const d = await ctx.db
      .query("oauth")
      .withIndex("by_model_uid", (q) => q.eq("model", model).eq("uid", uid))
      .first();
    return d && d.expiresAt > now ? d.payload : null;
  },
});

export const findByUserCode = query({
  args: { ...secretArg, model: v.string(), userCode: v.string(), now: v.number() },
  handler: async (ctx, { secret, model, userCode, now }) => {
    assertService(secret);
    const d = await ctx.db
      .query("oauth")
      .withIndex("by_model_userCode", (q) => q.eq("model", model).eq("userCode", userCode))
      .first();
    return d && d.expiresAt > now ? d.payload : null;
  },
});

export const consume = mutation({
  args: { ...secretArg, model: v.string(), key: v.string(), now: v.number() },
  handler: async (ctx, { secret, model, key, now }) => {
    assertService(secret);
    const d = await ctx.db
      .query("oauth")
      .withIndex("by_model_key", (q) => q.eq("model", model).eq("key", key))
      .unique();
    if (!d) return;
    const payload = JSON.parse(d.payload) as Record<string, unknown>;
    payload.consumed = Math.floor(now / 1000);
    await ctx.db.patch(d._id, { payload: JSON.stringify(payload) });
  },
});

export const destroy = mutation({
  args: { ...secretArg, model: v.string(), key: v.string() },
  handler: async (ctx, { secret, model, key }) => {
    assertService(secret);
    const d = await ctx.db
      .query("oauth")
      .withIndex("by_model_key", (q) => q.eq("model", model).eq("key", key))
      .unique();
    if (d) await ctx.db.delete(d._id);
  },
});

export const revokeByGrantId = mutation({
  args: { ...secretArg, grantId: v.string() },
  handler: async (ctx, { secret, grantId }) => {
    assertService(secret);
    for (const d of await ctx.db.query("oauth").withIndex("by_grant", (q) => q.eq("grantId", grantId)).collect()) {
      await ctx.db.delete(d._id);
    }
  },
});

/** An account's AI-app connections (grants, sessions, tokens, codes), when the account is deleted. */
export const destroyByAccount = mutation({
  args: { ...secretArg, accountId: v.string() },
  handler: async (ctx, { secret, accountId }) => {
    assertService(secret);
    let removed = 0;
    for (const model of ["Grant", "Session", "AccessToken", "RefreshToken", "AuthorizationCode"]) {
      for await (const row of ctx.db.query("oauth").withIndex("by_model_key", (q) => q.eq("model", model))) {
        let owner: unknown;
        try {
          owner = (JSON.parse(row.payload) as { accountId?: unknown }).accountId;
        } catch {
          continue;
        }
        if (owner === accountId) {
          await ctx.db.delete(row._id);
          removed++;
        }
      }
    }
    return { removed };
  },
});

/**
 * Deletes expired rows: codes, sign-in sessions, interactions, refresh tokens, and the ids of
 * DPoP proofs already seen (one per token request). oidc-provider never deletes them itself and
 * no read returns them. A slice per run; a backlog clears over a few hours.
 */
export const sweepExpired = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, { now }) => {
    const rows = await ctx.db
      .query("oauth")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now ?? Date.now()))
      .take(1000);
    for (const row of rows) await ctx.db.delete(row._id);
    return { removed: rows.length };
  },
});
