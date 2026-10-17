// Storage for oidc-provider (the gateway's OAuth server). Payloads are opaque
// JSON strings; expiry is enforced on read, and expired rows are swept hourly (crons.ts).
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

// The gateway hashes keys and seals payloads before they get here (schema.ts, `oauth`). Every
// lookup also takes the raw id as `legacy…`, for rows written before that; those expire within
// 180 days of 2026-10-16, after which the legacy arguments can go.

type Row = { _id: Id<"oauth">; key: string; payload: string; expiresAt: number; consumedAt?: number; grantId?: string };

async function byKey(ctx: QueryCtx, model: string, key: string, legacyKey?: string): Promise<Row | null> {
  const row = await ctx.db.query("oauth").withIndex("by_model_key", (q) => q.eq("model", model).eq("key", key)).unique();
  if (row || !legacyKey) return row;
  return ctx.db.query("oauth").withIndex("by_model_key", (q) => q.eq("model", model).eq("key", legacyKey)).unique();
}

const live = (row: Row | null, now: number) => (row && row.expiresAt > now ? { key: row.key, payload: row.payload, consumedAt: row.consumedAt ?? null } : null);

/** A row from before the gateway sealed them: its payload is plain JSON. */
const plain = (payload: string) => payload.startsWith("{");

export const upsert = mutation({
  args: {
    ...secretArg,
    model: v.string(),
    key: v.string(),
    legacyKey: v.optional(v.string()),
    payload: v.string(),
    expiresAt: v.number(),
    grantId: v.optional(v.string()),
    uid: v.optional(v.string()),
    userCode: v.optional(v.string()),
    accountId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, { secret, model, key, legacyKey, ...rest }) => {
    assertService(secret);
    const existing = await byKey(ctx, model, key);
    const row = { model, key, ...rest, ...(existing?.consumedAt !== undefined ? { consumedAt: existing.consumedAt } : {}) };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("oauth", row);
    // The same record saved again (a session, a grant): the old plain row goes.
    if (legacyKey) {
      const old = await ctx.db.query("oauth").withIndex("by_model_key", (q) => q.eq("model", model).eq("key", legacyKey)).unique();
      if (old) await ctx.db.delete(old._id);
    }
  },
});

export const find = query({
  args: { ...secretArg, model: v.string(), key: v.string(), legacyKey: v.optional(v.string()), now: v.number() },
  handler: async (ctx, { secret, model, key, legacyKey, now }) => {
    assertService(secret);
    return live(await byKey(ctx, model, key, legacyKey), now);
  },
});

export const findByUid = query({
  args: { ...secretArg, model: v.string(), uid: v.string(), legacyUid: v.optional(v.string()), now: v.number() },
  handler: async (ctx, { secret, model, uid, legacyUid, now }) => {
    assertService(secret);
    let d = await ctx.db.query("oauth").withIndex("by_model_uid", (q) => q.eq("model", model).eq("uid", uid)).first();
    if (!d && legacyUid) d = await ctx.db.query("oauth").withIndex("by_model_uid", (q) => q.eq("model", model).eq("uid", legacyUid)).first();
    return live(d, now);
  },
});

export const findByUserCode = query({
  args: { ...secretArg, model: v.string(), userCode: v.string(), legacyUserCode: v.optional(v.string()), now: v.number() },
  handler: async (ctx, { secret, model, userCode, legacyUserCode, now }) => {
    assertService(secret);
    let d = await ctx.db.query("oauth").withIndex("by_model_userCode", (q) => q.eq("model", model).eq("userCode", userCode)).first();
    if (!d && legacyUserCode) d = await ctx.db.query("oauth").withIndex("by_model_userCode", (q) => q.eq("model", model).eq("userCode", legacyUserCode)).first();
    return live(d, now);
  },
});

export const consume = mutation({
  args: { ...secretArg, model: v.string(), key: v.string(), legacyKey: v.optional(v.string()), now: v.number() },
  handler: async (ctx, { secret, model, key, legacyKey, now }) => {
    assertService(secret);
    const d = await byKey(ctx, model, key, legacyKey);
    if (!d) return { reused: false };
    const used = d.consumedAt !== undefined || (plain(d.payload) && !!(JSON.parse(d.payload) as { consumed?: unknown }).consumed);
    // Already used: two requests raced with the same code or refresh token (a stolen copy and the
    // real client, say), both past oidc-provider's own check. That's reuse, so the whole grant
    // goes, as oidc-provider does when it sees reuse itself, and the gateway fails this request.
    // (Returned, not thrown: a throw would roll the deletion back.)
    if (used) {
      if (d.grantId) for (const row of await ctx.db.query("oauth").withIndex("by_grant", (q) => q.eq("grantId", d.grantId)).collect()) await ctx.db.delete(row._id);
      return { reused: true };
    }
    await ctx.db.patch(d._id, { consumedAt: now });
    return { reused: false };
  },
});

export const destroy = mutation({
  args: { ...secretArg, model: v.string(), key: v.string(), legacyKey: v.optional(v.string()) },
  handler: async (ctx, { secret, model, key, legacyKey }) => {
    assertService(secret);
    for (const k of [key, ...(legacyKey ? [legacyKey] : [])]) {
      const d = await ctx.db.query("oauth").withIndex("by_model_key", (q) => q.eq("model", model).eq("key", k)).unique();
      if (d) await ctx.db.delete(d._id);
    }
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

/** The AI apps an account has connected (its grants, the Ambient apps' own sign-in left out). */
export const listGrants = query({
  args: { ...secretArg, accountId: v.string(), now: v.number() },
  handler: async (ctx, { secret, accountId, now }) => {
    assertService(secret);
    const rows = await ctx.db.query("oauth").withIndex("by_model_account", (q) => q.eq("model", "Grant").eq("accountId", accountId)).collect();
    return rows
      .filter((g) => g.expiresAt > now && g.clientId && g.clientId !== "ambient-app" && g.grantId)
      .map((g) => ({ grantId: g.grantId!, clientId: g.clientId!, since: g._creationTime }));
  },
});

/** Disconnect one AI app: everything of that grant goes, if it's the account's. */
export const revokeGrant = mutation({
  args: { ...secretArg, accountId: v.string(), grantId: v.string() },
  handler: async (ctx, { secret, accountId, grantId }) => {
    assertService(secret);
    const rows = await ctx.db.query("oauth").withIndex("by_grant", (q) => q.eq("grantId", grantId)).collect();
    const grant = rows.find((r) => r.model === "Grant");
    if (!grant || grant.accountId !== accountId || grant.clientId === "ambient-app") return { ok: false as const };
    for (const r of rows) await ctx.db.delete(r._id);
    return { ok: true as const };
  },
});

/** An account's AI-app connections (grants, sessions, tokens, codes), when the account is deleted. */
export const destroyByAccount = mutation({
  args: { ...secretArg, accountId: v.string() },
  handler: async (ctx, { secret, accountId }) => {
    assertService(secret);
    let removed = 0;
    for (const model of ["Grant", "Session", "AccessToken", "RefreshToken", "AuthorizationCode"]) {
      for (const row of await ctx.db.query("oauth").withIndex("by_model_account", (q) => q.eq("model", model).eq("accountId", accountId)).collect()) {
        await ctx.db.delete(row._id);
        removed++;
      }
      // Rows from before accountId had a column of its own: only those are read one by one.
      for await (const row of ctx.db.query("oauth").withIndex("by_model_account", (q) => q.eq("model", model).eq("accountId", undefined))) {
        if (!plain(row.payload)) continue;
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
    // A full slice means more are waiting: carry on now rather than an hour from now, so a flood
    // of expired rows can't outgrow the sweep.
    if (rows.length === 1000) await ctx.scheduler.runAfter(0, internal.oauth.sweepExpired, {});
    return { removed: rows.length };
  },
});
