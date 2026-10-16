// Encrypted personal wiki. The gateway encrypts before calling and decrypts
// after reading; nothing here can read note text.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

export const getKey = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const k = await ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    return k ? { masterKeyId: k.masterKeyId, wrapped: k.wrapped } : null;
  },
});

/** Store a wrapped key unless one exists; always returns the key that is now on record. */
export const putKeyIfAbsent = mutation({
  args: { ...secretArg, uid: v.id("users"), masterKeyId: v.string(), wrapped: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, masterKeyId, wrapped, now }) => {
    assertService(secret);
    const k = await ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    if (k) return { masterKeyId: k.masterKeyId, wrapped: k.wrapped };
    await ctx.db.insert("userKeys", { userId: uid, masterKeyId, wrapped, createdAt: now });
    return { masterKeyId, wrapped };
  },
});

export const seq = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    return (await ctx.db.get(uid))?.personalSeq ?? 0;
  },
});

export const list = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const user = await ctx.db.get(uid);
    const pages = await ctx.db
      .query("personalPages")
      .withIndex("by_user_path", (q) => q.eq("userId", uid))
      .collect();
    return {
      seq: user?.personalSeq ?? 0,
      pages: pages.map((p) => ({ path: p.path, hash: p.hash, iv: p.iv, ciphertext: p.ciphertext, updated: p.updated, origin: p.origin ?? "phone" })),
    };
  },
});

/** Every page's path and hash, no content: a device checks what it has against this. */
export const paths = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const user = await ctx.db.get(uid);
    const pages = await ctx.db
      .query("personalPages")
      .withIndex("by_user_path", (q) => q.eq("userId", uid))
      .collect();
    return { seq: user?.personalSeq ?? 0, paths: pages.map((p) => ({ path: p.path, hash: p.hash })) };
  },
});

const op = v.union(
  v.object({ op: v.literal("upsert"), path: v.string(), hash: v.string(), iv: v.string(), ciphertext: v.string(), updated: v.string() }),
  v.object({ op: v.literal("delete"), path: v.string() }),
);

/**
 * Apply a batch of page writes. Idempotent on (path, hash). `origin` says who wrote them:
 * a device ("device:<id>"; "phone" from older app builds, the default; both also mark when the
 * user last synced) or the server (Claude upkeep, overview, captures, merges). Other devices
 * pull these writes, and deletes leave a tombstone so they delete the page too.
 */
export const apply = mutation({
  args: { ...secretArg, uid: v.id("users"), ops: v.array(op), origin: v.optional(v.string()) },
  handler: async (ctx, { secret, uid, ops, origin = "phone" }) => {
    assertService(secret);
    const user = await ctx.db.get(uid);
    if (!user) throw new Error("no such user");
    let seq = user.personalSeq;
    let applied = 0;
    for (const o of ops) {
      const existing = await ctx.db
        .query("personalPages")
        .withIndex("by_user_path", (q) => q.eq("userId", uid).eq("path", o.path))
        .unique();
      const tomb = await ctx.db
        .query("personalTombstones")
        .withIndex("by_user_path", (q) => q.eq("userId", uid).eq("path", o.path))
        .unique();
      if (o.op === "delete") {
        if (existing) {
          await ctx.db.delete(existing._id);
          seq++;
          applied++;
          const t = { userId: uid, path: o.path, seq, origin, at: Date.now() };
          if (tomb) await ctx.db.replace(tomb._id, t);
          else await ctx.db.insert("personalTombstones", t);
        }
        continue;
      }
      if (existing?.hash === o.hash) continue;
      if (tomb) await ctx.db.delete(tomb._id);
      seq++;
      applied++;
      const doc = { userId: uid, path: o.path, hash: o.hash, iv: o.iv, ciphertext: o.ciphertext, updated: o.updated, seq, origin };
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("personalPages", doc);
    }
    if (seq !== user.personalSeq) {
      await ctx.db.patch(uid, origin !== "server" ? { personalSeq: seq, personalWriteAt: Date.now() } : { personalSeq: seq });
    }
    return { seq, applied };
  },
});

/** Current versions of some pages (encrypted), to merge a phone upload with the server's version. */
export const getMany = query({
  args: { ...secretArg, uid: v.id("users"), paths: v.array(v.string()) },
  handler: async (ctx, { secret, uid, paths }) => {
    assertService(secret);
    const out = [];
    for (const path of paths.slice(0, 200)) {
      const p = await ctx.db
        .query("personalPages")
        .withIndex("by_user_path", (q) => q.eq("userId", uid).eq("path", path))
        .unique();
      if (p) out.push({ path: p.path, hash: p.hash, iv: p.iv, ciphertext: p.ciphertext, updated: p.updated, origin: p.origin ?? "phone" });
    }
    return out;
  },
});

/**
 * What changed after `since` (a device's last seen seq), oldest first, for that device to pull:
 * pages and deletions by anyone but `device` itself. Without `device` (app builds before
 * per-device ids) only the server's writes, as before. At most 500 of each per call; `through`
 * is then the seq the device has fully caught up to, and it asks again from there.
 */
export const changedSince = query({
  args: { ...secretArg, uid: v.id("users"), since: v.number(), device: v.optional(v.string()) },
  handler: async (ctx, { secret, uid, since, device }) => {
    assertService(secret);
    const LIMIT = 500;
    const pages = await ctx.db
      .query("personalPages")
      .withIndex("by_user_seq", (q) => q.eq("userId", uid).gt("seq", since))
      .take(LIMIT);
    const tombs = device
      ? await ctx.db
          .query("personalTombstones")
          .withIndex("by_user_seq", (q) => q.eq("userId", uid).gt("seq", since))
          .take(LIMIT)
      : [];
    const mine = (origin: string | undefined) => (device ? (origin ?? "phone") === device : (origin ?? "phone") !== "server");
    const full = [pages.length === LIMIT ? pages[pages.length - 1]!.seq : Infinity, tombs.length === LIMIT ? tombs[tombs.length - 1]!.seq : Infinity];
    const through = Math.min(...full);
    const within = (seq: number) => seq <= through;
    return {
      pages: pages
        .filter((p) => !mine(p.origin) && within(p.seq))
        .map((p) => ({ path: p.path, hash: p.hash, iv: p.iv, ciphertext: p.ciphertext, updated: p.updated, seq: p.seq })),
      deleted: tombs.filter((t) => !mine(t.origin) && within(t.seq)).map((t) => ({ path: t.path, seq: t.seq })),
      through: Number.isFinite(through) ? through : null,
    };
  },
});
