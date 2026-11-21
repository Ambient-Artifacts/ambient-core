// Files sent with a message in Ambient's chat or a bot's thread (docs/bots.md, "Files in the chat"):
// the gateway seals each with its owner's key and keeps the ciphertext in Convex file storage, so
// the message shows it again, on every device. Convex only ever holds ciphertext. File storage is
// reached from actions (`store`, `read`); the rest are mutations and queries as everywhere.
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

const owner = {
  userId: v.optional(v.id("users")),
  teamId: v.optional(v.id("teams")),
  routineId: v.optional(v.id("routines")),
};

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

/** Stores one sealed file (base64 ciphertext) and its sealed name and type; returns its id. */
export const store = action({
  args: { ...secretArg, ...owner, iv: v.string(), data: v.string(), metaIv: v.string(), metaCt: v.string(), size: v.number(), now: v.number() },
  handler: async (ctx, { secret, data, ...a }): Promise<{ id: string }> => {
    assertService(secret);
    if (!a.userId && !a.teamId) throw new Error("an attachment needs an owner");
    const storageId = await ctx.storage.store(new Blob([fromBase64(data) as BlobPart]));
    const id: string = await ctx.runMutation(internal.attachments.record, { ...a, storageId });
    return { id };
  },
});

export const record = internalMutation({
  args: { ...owner, storageId: v.id("_storage"), iv: v.string(), metaIv: v.string(), metaCt: v.string(), size: v.number(), now: v.number() },
  handler: async (ctx, { now, ...a }) => ctx.db.insert("attachments", { ...a, createdAt: now }),
});

/** One file's record, without its bytes (for the gateway's check of who may read it). */
export const get = query({
  args: { ...secretArg, id: v.string() },
  handler: async (ctx, { secret, id }) => {
    assertService(secret);
    const key = ctx.db.normalizeId("attachments", id);
    const row = key ? await ctx.db.get(key) : null;
    return row
      ? { id: row._id, userId: row.userId ?? null, teamId: row.teamId ?? null, routineId: row.routineId ?? null, iv: row.iv, metaIv: row.metaIv, metaCt: row.metaCt, size: row.size }
      : null;
  },
});

export const getRow = internalQuery({
  args: { id: v.id("attachments") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

/** One file's sealed bytes (base64), for the gateway to open; null once it's gone. */
export const read = action({
  args: { ...secretArg, id: v.string() },
  handler: async (ctx, { secret, id }): Promise<{ data: string } | null> => {
    assertService(secret);
    const row = await ctx.runQuery(internal.attachments.getRow, { id: id as never });
    if (!row) return null;
    const blob = await ctx.storage.get(row.storageId);
    if (!blob) return null;
    return { data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
  },
});

/** A person's chat files go with its history (Forget chat, the account): a page at a time, until 0. */
export const forgetChat = mutation({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const rows = await ctx.db.query("attachments").withIndex("by_user", (q) => q.eq("userId", uid).eq("routineId", undefined)).take(200);
    for (const r of rows) {
      await ctx.storage.delete(r.storageId);
      await ctx.db.delete(r._id);
    }
    return { removed: rows.length };
  },
});
