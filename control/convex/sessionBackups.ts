// A lane's Claude Code session, backed up (the team wiki's product/conversations.md, "Sessions move
// with the lane"): the session's transcript file, gzipped and sealed by the gateway with its
// owner's key, so a wiped or replaced computer, or another one, resumes the conversation where it
// was. One per lane (the newest replaces the one before); Convex only ever holds ciphertext.
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { action, internalMutation, internalQuery, mutation } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

const lane = { ownerKind: v.union(v.literal("user"), v.literal("team")), ownerId: v.string(), lane: v.string() };

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Keeps a lane's sealed session (base64 ciphertext of the gzipped file), in place of the one before. */
export const put = action({
  args: { ...secretArg, ...lane, session: v.string(), iv: v.string(), data: v.string(), size: v.number(), now: v.number() },
  handler: async (ctx, { secret, data, ...a }): Promise<{ ok: true }> => {
    assertService(secret);
    const storageId = await ctx.storage.store(new Blob([fromBase64(data) as BlobPart]));
    const old: string | null = await ctx.runMutation(internal.sessionBackups.record, { ...a, storageId });
    if (old) await ctx.storage.delete(old as never);
    return { ok: true };
  },
});

export const record = internalMutation({
  args: { ...lane, session: v.string(), storageId: v.id("_storage"), iv: v.string(), size: v.number(), now: v.number() },
  handler: async (ctx, { now, ...a }): Promise<string | null> => {
    const row = await ctx.db
      .query("sessionBackups")
      .withIndex("by_lane", (q) => q.eq("ownerKind", a.ownerKind).eq("ownerId", a.ownerId).eq("lane", a.lane))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, { session: a.session, storageId: a.storageId, iv: a.iv, size: a.size, updatedAt: now });
      return row.storageId;
    }
    await ctx.db.insert("sessionBackups", { ...a, updatedAt: now });
    return null;
  },
});

export const row = internalQuery({
  args: lane,
  handler: async (ctx, a) =>
    ctx.db
      .query("sessionBackups")
      .withIndex("by_lane", (q) => q.eq("ownerKind", a.ownerKind).eq("ownerId", a.ownerId).eq("lane", a.lane))
      .unique(),
});

/** A lane's sealed session and its id, for the gateway to open; null when there's none. */
export const get = action({
  args: { ...secretArg, ...lane },
  handler: async (ctx, { secret, ...a }): Promise<{ session: string; iv: string; data: string } | null> => {
    assertService(secret);
    const r = await ctx.runQuery(internal.sessionBackups.row, a);
    if (!r) return null;
    const blob = await ctx.storage.get(r.storageId);
    if (!blob) return null;
    return { session: r.session, iv: r.iv, data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
  },
});

/** An owner's backups go (Forget chat, a lane taken out): a page at a time, until 0. */
export const forget = mutation({
  args: { ...secretArg, ownerKind: lane.ownerKind, ownerId: v.string(), lane: v.optional(v.string()) },
  handler: async (ctx, { secret, ownerKind, ownerId, lane: one }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("sessionBackups")
      .withIndex("by_lane", (q) => (one ? q.eq("ownerKind", ownerKind).eq("ownerId", ownerId).eq("lane", one) : q.eq("ownerKind", ownerKind).eq("ownerId", ownerId)))
      .take(50);
    for (const r of rows) {
      await ctx.storage.delete(r.storageId);
      await ctx.db.delete(r._id);
    }
    return { removed: rows.length };
  },
});
