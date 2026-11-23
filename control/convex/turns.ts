// Turns in flight (the team wiki's product/conversations.md, "Running"): a turn of Amb's (a person's
// chat, or a team's in a channel thread) is written here before it starts and removed once its
// answer is out, so a gateway that restarts in between picks it up again instead of leaving the
// message unanswered. What the turn needs is sealed by the gateway with its owner's key.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

export const enqueue = mutation({
  args: { ...secretArg, kind: v.string(), ownerKind: v.union(v.literal("user"), v.literal("team")), ownerId: v.string(), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, now, ...a }) => {
    assertService(secret);
    return String(await ctx.db.insert("turns", { ...a, attempts: 0, createdAt: now }));
  },
});

export const done = mutation({
  args: { ...secretArg, id: v.string() },
  handler: async (ctx, { secret, id }) => {
    assertService(secret);
    const key = ctx.db.normalizeId("turns", id);
    if (key && (await ctx.db.get(key))) await ctx.db.delete(key);
  },
});

/** Turns a gateway left behind (started before `before`): one more try each, at most 3. */
export const leftovers = query({
  args: { ...secretArg, before: v.number() },
  handler: async (ctx, { secret, before }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("turns")
      .withIndex("by_created", (q) => q.lt("createdAt", before))
      .take(50);
    return rows.map((r) => ({ id: String(r._id), kind: r.kind, ownerKind: r.ownerKind, ownerId: r.ownerId, iv: r.iv, ct: r.ct, attempts: r.attempts, createdAt: r.createdAt }));
  },
});

/** One more try (or, after 3, given up: removed). Returns whether to try. */
export const attempt = mutation({
  args: { ...secretArg, id: v.string() },
  handler: async (ctx, { secret, id }) => {
    assertService(secret);
    const key = ctx.db.normalizeId("turns", id);
    const row = key ? await ctx.db.get(key) : null;
    if (!row) return false;
    if (row.attempts >= 3) {
      await ctx.db.delete(row._id);
      return false;
    }
    await ctx.db.patch(row._id, { attempts: row.attempts + 1, createdAt: Date.now() });
    return true;
  },
});
