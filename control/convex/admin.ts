// A self-hosted server's admin tasks, for servers run without the apps (no Sign in with Apple
// or Microsoft): accounts by email, team members, team servers. Called by the gateway's admin
// CLI (gateway/src/admin.ts) with the service secret, like every other gateway function.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";
import { role } from "./schema.js";
import { recordRemoval } from "./teams.js";

const user = (u: Doc<"users">) => ({
  uid: u._id,
  name: u.name,
  email: u.email ?? null,
  signIn: u.appleSub ? "apple" : u.microsoftId ? "microsoft" : u.googleSub ? "google" : u.localId ? "local" : "unknown",
  upkeep: u.consolidate === true,
  disabled: u.disabled === true || u.deletingAt !== undefined,
  createdAt: u.createdAt,
});

/** Find or create the local account for this email. */
export const upsertLocalUser = mutation({
  args: { ...secretArg, email: v.string(), name: v.optional(v.string()), now: v.number() },
  handler: async (ctx, { secret, email, name, now }) => {
    assertService(secret);
    const localId = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(localId)) return { ok: false as const, error: "bad_email" };
    const existing = await ctx.db
      .query("users")
      .withIndex("by_localId", (q) => q.eq("localId", localId))
      .unique();
    if (existing) {
      if (name?.trim() && name.trim() !== existing.name) await ctx.db.patch(existing._id, { name: name.trim().slice(0, 80) });
      return { ok: true as const, created: false, user: user((await ctx.db.get(existing._id))!) };
    }
    const uid = await ctx.db.insert("users", {
      localId,
      email: localId,
      name: name?.trim().slice(0, 80) || localId.split("@")[0]!,
      personalSeq: 0,
      createdAt: now,
    });
    return { ok: true as const, created: true, user: user((await ctx.db.get(uid))!) };
  },
});

async function lookup(ctx: QueryCtx, ref: string) {
  const id = ctx.db.normalizeId("users", ref);
  if (id) {
    const u = await ctx.db.get(id);
    return u ? [u] : [];
  }
  const want = ref.trim().toLowerCase();
  const local = await ctx.db
    .query("users")
    .withIndex("by_localId", (q) => q.eq("localId", want))
    .unique();
  if (local) return [local];
  // Accounts from the apps carry the email they signed in with (Apple's may be a relay address).
  // Only emails someone vouches for: Apple's, or one an admin entered. Microsoft's `email` claim is
  // whatever the account's tenant says, so a stranger's tenant could claim anyone's address and
  // receive their codes, tokens or team role; those accounts are found by id.
  return (await ctx.db.query("users").collect()).filter((u) => emailVouched(u) && u.email?.toLowerCase() === want);
}

/** Whether a user's email can identify them: from Sign in with Apple, or entered by an admin. */
export function emailVouched(u: Doc<"users">): boolean {
  return u.appleSub !== undefined || u.localId !== undefined;
}

/** One user by id or email: `matches` > 1 when the email belongs to more than one account. */
export const findUser = query({
  args: { ...secretArg, ref: v.string() },
  handler: async (ctx, { secret, ref }) => {
    assertService(secret);
    const found = (await lookup(ctx, ref)).filter((u) => !u.disabled && u.deletingAt === undefined);
    return { matches: found.length, user: found.length === 1 ? user(found[0]!) : null };
  },
});

/** Everything an admin wants to see at once: accounts, teams, team servers. */
export const overview = query({
  args: { ...secretArg },
  handler: async (ctx, { secret }) => {
    assertService(secret);
    const users = (await ctx.db.query("users").collect()).map(user);
    const teams = [];
    for (const t of await ctx.db.query("teams").collect()) {
      const members = await ctx.db
        .query("members")
        .withIndex("by_team", (q) => q.eq("teamId", t._id))
        .collect();
      teams.push({ id: t._id, slug: t.slug, name: t.name, status: t.status, serverUrl: t.serverUrl ?? null, members: members.length });
    }
    const servers = (await ctx.db.query("teamServers").collect()).map((s) => ({ serverId: s.serverId, url: s.url, status: s.status, teamId: s.teamId ?? null }));
    return { users, teams, servers };
  },
});

/** Add a team server to the pool, or move a known one to a new URL. Safe to repeat. */
export const registerServer = mutation({
  args: { ...secretArg, serverId: v.string(), url: v.string(), now: v.number() },
  handler: async (ctx, { secret, serverId, url, now }) => {
    assertService(secret);
    const clean = url.replace(/\/+$/, "");
    const existing = await ctx.db
      .query("teamServers")
      .withIndex("by_server", (q) => q.eq("serverId", serverId))
      .unique();
    if (existing) {
      if (existing.url !== clean) {
        await ctx.db.patch(existing._id, { url: clean });
        if (existing.teamId) await ctx.db.patch(existing.teamId, { serverUrl: clean });
      }
      return { created: false, status: existing.status };
    }
    await ctx.db.insert("teamServers", { serverId, url: clean, status: "free", createdAt: now });
    return { created: true, status: "free" as const };
  },
});

/** Put a user in a team with this role (or change their role). */
export const setMember = mutation({
  args: { ...secretArg, slug: v.string(), uid: v.id("users"), role, peopleSlug: v.string(), now: v.number() },
  handler: async (ctx, { secret, slug, uid, role, peopleSlug, now }) => {
    assertService(secret);
    const team = await ctx.db
      .query("teams")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!team || team.status === "canceled") return { ok: false as const, error: "no_team" };
    const existing = await ctx.db
      .query("members")
      .withIndex("by_team_user", (q) => q.eq("teamId", team._id).eq("userId", uid))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { role });
      return { ok: true as const, created: false, teamId: team._id as Id<"teams"> };
    }
    await ctx.db.insert("members", { teamId: team._id, userId: uid, role, peopleSlug, joinedAt: now });
    return { ok: true as const, created: true, teamId: team._id as Id<"teams"> };
  },
});

/** Take a user out of a team. The owner stays: give the team another owner first. */
export const removeMember = mutation({
  args: { ...secretArg, slug: v.string(), uid: v.id("users") },
  handler: async (ctx, { secret, slug, uid }) => {
    assertService(secret);
    const team = await ctx.db
      .query("teams")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!team) return { ok: false as const, error: "no_team" };
    const m = await ctx.db
      .query("members")
      .withIndex("by_team_user", (q) => q.eq("teamId", team._id).eq("userId", uid))
      .unique();
    if (!m) return { ok: true as const, removed: false };
    if (m.role === "owner") {
      const owners = (await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", team._id)).collect()).filter((x) => x.role === "owner");
      if (owners.length === 1) return { ok: false as const, error: "last_owner" };
    }
    await ctx.db.delete(m._id);
    await recordRemoval(ctx, team._id, uid, m.peopleSlug);
    return { ok: true as const, removed: true };
  },
});
