// Voice fingerprints. The gateway seals the embedding with the user's data key before calling;
// nothing here can read the numbers. A fingerprint goes to every active team its owner is in:
// `ofTeam` is the one read a member's app needs to name the people speaking in a recording.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

export const get = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const row = await ctx.db.query("voices").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    return row ? { model: row.model, iv: row.iv, ciphertext: row.ciphertext, updatedAt: row.updatedAt } : null;
  },
});

/** Replace the user's fingerprint. Refused once their account is being deleted, so none outlives it. */
export const put = mutation({
  args: { ...secretArg, uid: v.id("users"), model: v.string(), iv: v.string(), ciphertext: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, model, iv, ciphertext, now }) => {
    assertService(secret);
    const user = await ctx.db.get(uid);
    if (!user || user.disabled || user.deletingAt) return { ok: false as const };
    const row = await ctx.db.query("voices").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    if (row) await ctx.db.patch(row._id, { model, iv, ciphertext, updatedAt: now });
    else await ctx.db.insert("voices", { userId: uid, model, iv, ciphertext, updatedAt: now });
    return { ok: true as const };
  },
});

export const remove = mutation({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const rows = await ctx.db.query("voices").withIndex("by_user", (q) => q.eq("userId", uid)).collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return { removed: rows.length };
  },
});

/**
 * The fingerprints of everyone in an active team, for a member of it (null for anyone else).
 * Membership is read here, not from the gateway's cache: someone removed or gone stops being
 * returned, and stops getting the others', at once. Each row carries its owner's wrapped data key,
 * so the gateway opens a whole team's without a key lookup per member.
 */
export const ofTeam = query({
  args: { ...secretArg, uid: v.id("users"), slug: v.string() },
  handler: async (ctx, { secret, uid, slug }) => {
    assertService(secret);
    const team = await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!team || team.status !== "active") return null;
    const me = await ctx.db.query("members").withIndex("by_team_user", (q) => q.eq("teamId", team._id).eq("userId", uid)).unique();
    if (!me) return null;
    const members = await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", team._id)).collect();
    const rows = await Promise.all(
      members.map(async (m) => {
        const [user, voice, key] = await Promise.all([
          ctx.db.get(m.userId),
          ctx.db.query("voices").withIndex("by_user", (q) => q.eq("userId", m.userId)).unique(),
          ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", m.userId)).unique(),
        ]);
        if (!user || user.disabled || user.deletingAt || !voice || !key) return null;
        return {
          uid: m.userId as string,
          name: user.name,
          model: voice.model,
          iv: voice.iv,
          ciphertext: voice.ciphertext,
          updatedAt: voice.updatedAt,
          key: { masterKeyId: key.masterKeyId, wrapped: key.wrapped },
        };
      }),
    );
    return rows.filter((r) => r !== null).sort((a, b) => a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
  },
});
