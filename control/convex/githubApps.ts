// GitHub Apps besides the gateway's configured one (docs/bots.md, "GitHub Apps"): the template
// roles' and bots' own. The gateway seals their keys with its master key before they get here.
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

function shape(a: Doc<"githubApps">) {
  return {
    key: a.key,
    role: a.role,
    slug: a.slug,
    appId: a.appId,
    name: a.name,
    account: a.account,
    hookId: a.hookId,
    routineId: a.routineId ?? null,
    keyIv: a.keyIv,
    keyCt: a.keyCt,
    secretIv: a.secretIv,
    secretCt: a.secretCt,
    createdAt: a.createdAt,
  };
}

export const list = query({
  args: { ...secretArg },
  handler: async (ctx, { secret }) => {
    assertService(secret);
    return (await ctx.db.query("githubApps").take(1000)).map(shape);
  },
});

/** A new App; one with the same key (a role's app made again) is replaced. */
export const add = mutation({
  args: {
    ...secretArg,
    key: v.string(),
    role: v.union(v.literal("builder"), v.literal("reviewer"), v.literal("wiki_keeper"), v.literal("bot")),
    slug: v.string(),
    appId: v.string(),
    name: v.string(),
    account: v.string(),
    hookId: v.string(),
    routineId: v.optional(v.string()),
    keyIv: v.string(),
    keyCt: v.string(),
    secretIv: v.string(),
    secretCt: v.string(),
    now: v.number(),
  },
  handler: async (ctx, { secret, routineId, now, ...a }) => {
    assertService(secret);
    const rid = routineId ? ctx.db.normalizeId("routines", routineId) : null;
    if (routineId && !rid) return { ok: false as const, error: "no_such_bot" };
    for (const old of await ctx.db.query("githubApps").withIndex("by_key", (q) => q.eq("key", a.key)).take(10)) await ctx.db.delete(old._id);
    const id = await ctx.db.insert("githubApps", { ...a, ...(rid ? { routineId: rid } : {}), createdAt: now });
    return { ok: true as const, app: shape((await ctx.db.get(id))!) };
  },
});
