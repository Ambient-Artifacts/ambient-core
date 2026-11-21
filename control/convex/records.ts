// Records (docs/bots.md, "A bot's folder"): small sealed files with a version per change, for a
// person or a team. The gateway seals them and decides who may read and write; these functions
// keep the versions, mark the latest, and drop the oldest past `keep`.
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

const owner = { ownerKind: v.union(v.literal("user"), v.literal("team")), ownerId: v.string() };
const by = v.union(v.literal("user"), v.literal("bot"), v.literal("amb"));
/** One page is enough for a bot's folder (60 files) or a kind's latest handoffs. */
const PAGE = 500;

function shape(r: Doc<"records">) {
  return {
    key: r.key,
    version: r.version,
    iv: r.iv,
    ct: r.ct,
    size: r.size,
    byKind: r.byKind,
    byName: r.byName ?? null,
    deleted: r.deleted ?? false,
    createdAt: r.createdAt,
  };
}

/** The latest version of one key (deleted ones too: the caller says what that means), or a given version. */
export const get = query({
  args: { ...secretArg, ...owner, kind: v.string(), key: v.string(), version: v.optional(v.number()) },
  handler: async (ctx, { secret, ownerKind, ownerId, kind, key, version }) => {
    assertService(secret);
    const q = ctx.db.query("records").withIndex("by_key", (i) => {
      const k = i.eq("ownerKind", ownerKind).eq("ownerId", ownerId).eq("kind", kind).eq("key", key);
      return version === undefined ? k : k.eq("version", version);
    });
    const r = await q.order("desc").first();
    return r ? shape(r) : null;
  },
});

/** The latest version of every key of a kind that starts with `prefix`, deleted ones left out. */
export const list = query({
  args: { ...secretArg, ...owner, kind: v.string(), prefix: v.string() },
  handler: async (ctx, { secret, ownerKind, ownerId, kind, prefix }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("records")
      .withIndex("by_latest", (i) => i.eq("ownerKind", ownerKind).eq("ownerId", ownerId).eq("kind", kind).eq("latest", true).gte("key", prefix).lt("key", `${prefix}￿`))
      .take(PAGE);
    return rows.filter((r) => !r.deleted).map(shape);
  },
});

/** A key's versions, newest first. */
export const history = query({
  args: { ...secretArg, ...owner, kind: v.string(), key: v.string(), limit: v.number() },
  handler: async (ctx, { secret, ownerKind, ownerId, kind, key, limit }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("records")
      .withIndex("by_key", (i) => i.eq("ownerKind", ownerKind).eq("ownerId", ownerId).eq("kind", kind).eq("key", key))
      .order("desc")
      .take(Math.min(Math.max(limit, 1), 100));
    return rows.map(shape);
  },
});

async function latestOf(ctx: MutationCtx, a: { ownerKind: "user" | "team"; ownerId: string; kind: string; key: string }) {
  return ctx.db
    .query("records")
    .withIndex("by_key", (i) => i.eq("ownerKind", a.ownerKind).eq("ownerId", a.ownerId).eq("kind", a.kind).eq("key", a.key))
    .order("desc")
    .first();
}

/**
 * A new version of a key (`deleted`: one that removes it). Keeps the newest `keep` versions.
 * `ifVersion`: only when the latest is still that version (an edit made on an older one loses).
 */
export const put = mutation({
  args: {
    ...secretArg,
    ...owner,
    kind: v.string(),
    key: v.string(),
    iv: v.string(),
    ct: v.string(),
    size: v.number(),
    byKind: by,
    byName: v.optional(v.string()),
    deleted: v.optional(v.boolean()),
    keep: v.number(),
    ifVersion: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, { secret, keep, ifVersion, now, ...a }) => {
    assertService(secret);
    const prev = await latestOf(ctx, a);
    if (ifVersion !== undefined && (prev?.version ?? 0) !== ifVersion) return { ok: false as const, error: "changed", version: prev?.version ?? 0 };
    if (prev) await ctx.db.patch(prev._id, { latest: false });
    const version = (prev?.version ?? 0) + 1;
    const id = await ctx.db.insert("records", { ...a, version, latest: true, createdAt: now });
    const old = await ctx.db
      .query("records")
      .withIndex("by_key", (i) => i.eq("ownerKind", a.ownerKind).eq("ownerId", a.ownerId).eq("kind", a.kind).eq("key", a.key))
      .order("desc")
      .take(Math.max(keep, 1) + 20);
    for (const r of old.slice(Math.max(keep, 1))) await ctx.db.delete(r._id);
    return { ok: true as const, record: shape((await ctx.db.get(id))!) };
  },
});

/** Keeps the newest `keep` keys of a kind under `prefix` (by their latest version's time): handoffs. */
export const prune = mutation({
  args: { ...secretArg, ...owner, kind: v.string(), prefix: v.string(), keep: v.number() },
  handler: async (ctx, { secret, ownerKind, ownerId, kind, prefix, keep }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("records")
      .withIndex("by_latest", (i) => i.eq("ownerKind", ownerKind).eq("ownerId", ownerId).eq("kind", kind).eq("latest", true).gte("key", prefix).lt("key", `${prefix}￿`))
      .take(PAGE);
    const drop = rows.sort((x, y) => y.createdAt - x.createdAt).slice(keep);
    for (const r of drop) {
      const all = await ctx.db
        .query("records")
        .withIndex("by_key", (i) => i.eq("ownerKind", ownerKind).eq("ownerId", ownerId).eq("kind", kind).eq("key", r.key))
        .take(200);
      for (const x of all) await ctx.db.delete(x._id);
    }
    return { removed: drop.length };
  },
});

/** Everything of a kind under `prefix`, every version (a bot is deleted). Call until it says 0. */
export const removeAll = mutation({
  args: { ...secretArg, ...owner, kind: v.string(), prefix: v.string() },
  handler: async (ctx, { secret, ownerKind, ownerId, kind, prefix }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("records")
      .withIndex("by_key", (i) => i.eq("ownerKind", ownerKind).eq("ownerId", ownerId).eq("kind", kind).gte("key", prefix).lt("key", `${prefix}￿`))
      .take(PAGE);
    for (const r of rows) await ctx.db.delete(r._id);
    return { removed: rows.length };
  },
});
