import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";
import { role } from "./schema.js";

function shape(team: Doc<"teams">, member?: Doc<"members">) {
  return {
    id: team._id,
    slug: team.slug,
    name: team.name,
    status: team.status,
    serverUrl: team.serverUrl ?? null,
    role: member?.role ?? null,
    peopleSlug: member?.peopleSlug ?? null,
  };
}

async function teamsOfUser(ctx: QueryCtx, userId: Id<"users">) {
  const memberships = await ctx.db
    .query("members")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const out = [];
  for (const m of memberships) {
    const team = await ctx.db.get(m.teamId);
    if (team && team.status !== "canceled") out.push(shape(team, m));
  }
  return out;
}

export const bySlug = query({
  args: { ...secretArg, slug: v.string() },
  handler: async (ctx, { secret, slug }) => {
    assertService(secret);
    const team = await ctx.db
      .query("teams")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    return team ? shape(team) : null;
  },
});

/** Active teams with a server, for the health check. */
export const active = query({
  args: { ...secretArg },
  handler: async (ctx, { secret }) => {
    assertService(secret);
    const teams = await ctx.db.query("teams").collect();
    return teams.filter((t) => t.status === "active" && t.serverUrl).map((t) => ({ id: t._id, slug: t.slug, name: t.name, serverUrl: t.serverUrl! }));
  },
});

export const ofUser = query({
  args: { ...secretArg, uid: v.string() },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const id = ctx.db.normalizeId("users", uid);
    return id ? teamsOfUser(ctx, id) : [];
  },
});

/** Accept an invite code (hashed by the gateway). Returns the team or an error code. */
export const joinWithInvite = mutation({
  args: { ...secretArg, uid: v.id("users"), codeHash: v.string(), peopleSlug: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, codeHash, peopleSlug, now }) => {
    assertService(secret);
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_code", (q) => q.eq("codeHash", codeHash))
      .unique();
    if (!invite || invite.usesLeft <= 0 || invite.expiresAt < now) return { ok: false as const, error: "invalid_code" };
    const team = await ctx.db.get(invite.teamId);
    if (!team || team.status !== "active") return { ok: false as const, error: "team_unavailable" };
    const existing = await ctx.db
      .query("members")
      .withIndex("by_team_user", (q) => q.eq("teamId", team._id).eq("userId", uid))
      .unique();
    if (existing) return { ok: true as const, team: shape(team, existing) };
    // Keep people slugs unique inside a team (two "Anna Müller"s get -2).
    const taken = new Set(
      (await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", team._id)).collect()).map((m) => m.peopleSlug),
    );
    let slug = peopleSlug;
    for (let i = 2; taken.has(slug); i++) slug = `${peopleSlug}-${i}`;
    const memberId = await ctx.db.insert("members", { teamId: team._id, userId: uid, role: invite.role, peopleSlug: slug, joinedAt: now });
    await ctx.db.patch(invite._id, { usesLeft: invite.usesLeft - 1 });
    return { ok: true as const, team: shape(team, (await ctx.db.get(memberId))!) };
  },
});

export const leave = mutation({
  args: { ...secretArg, uid: v.id("users"), teamId: v.id("teams") },
  handler: async (ctx, { secret, uid, teamId }) => {
    assertService(secret);
    const m = await ctx.db
      .query("members")
      .withIndex("by_team_user", (q) => q.eq("teamId", teamId).eq("userId", uid))
      .unique();
    if (m) await ctx.db.delete(m._id);
  },
});

// ---- Staff operations: `npx convex run teams:create '{...}'` (internal, no secret) ----

export const create = internalMutation({
  args: { slug: v.string(), name: v.string(), serverUrl: v.optional(v.string()) },
  handler: async (ctx, { slug, name, serverUrl }) => {
    if (!/^[a-z0-9][a-z0-9-]{1,38}$/.test(slug)) throw new ConvexError("slug must be lowercase letters, digits and hyphens");
    const clash = await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (clash) throw new ConvexError(`team ${slug} exists`);
    return ctx.db.insert("teams", { slug, name, status: "active", serverUrl, createdAt: Date.now() });
  },
});

export const setServerUrl = internalMutation({
  args: { slug: v.string(), serverUrl: v.string() },
  handler: async (ctx, { slug, serverUrl }) => {
    const team = await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!team) throw new ConvexError(`no team ${slug}`);
    await ctx.db.patch(team._id, { serverUrl });
  },
});

export const setStatus = internalMutation({
  args: { slug: v.string(), status: v.union(v.literal("active"), v.literal("suspended"), v.literal("canceled")) },
  handler: async (ctx, { slug, status }) => {
    const team = await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!team) throw new ConvexError(`no team ${slug}`);
    await ctx.db.patch(team._id, { status });
  },
});

/** The code itself is generated and hashed by ops/new-invite.mjs; only the hash lands here. */
export const createInvite = internalMutation({
  args: { slug: v.string(), codeHash: v.string(), role: v.optional(role), uses: v.optional(v.number()), days: v.optional(v.number()) },
  handler: async (ctx, { slug, codeHash, role, uses, days }) => {
    const team = await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!team) throw new ConvexError(`no team ${slug}`);
    const now = Date.now();
    await ctx.db.insert("invites", {
      teamId: team._id,
      codeHash,
      role: role ?? "member",
      usesLeft: uses ?? 20,
      expiresAt: now + (days ?? 14) * 86_400_000,
      createdAt: now,
    });
  },
});

export const removeMember = internalMutation({
  args: { slug: v.string(), uid: v.id("users") },
  handler: async (ctx, { slug, uid }) => {
    const team = await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!team) throw new ConvexError(`no team ${slug}`);
    const m = await ctx.db
      .query("members")
      .withIndex("by_team_user", (q) => q.eq("teamId", team._id).eq("userId", uid))
      .unique();
    if (m) await ctx.db.delete(m._id);
  },
});

// ---- Teams managed from the app (the gateway calls these for a signed-in user) ----

async function membership(ctx: QueryCtx, uid: Id<"users">, slug: string) {
  const team = await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
  if (!team || team.status === "canceled") return null;
  const member = await ctx.db
    .query("members")
    .withIndex("by_team_user", (q) => q.eq("teamId", team._id).eq("userId", uid))
    .unique();
  return member ? { team, member } : null;
}

const canManage = (r: string) => r === "owner" || r === "admin";

/**
 * Create a team with the user as owner, on a free server from the pool. Returns the server to
 * claim (the gateway tells it which team it now serves); `no_server` when the pool is empty.
 */
export const createOwned = mutation({
  args: { ...secretArg, uid: v.id("users"), name: v.string(), peopleSlug: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, name, peopleSlug, now }) => {
    assertService(secret);
    const clean = name.trim().slice(0, 80);
    if (!clean) return { ok: false as const, error: "bad_name" };
    const server = await ctx.db.query("teamServers").withIndex("by_status", (q) => q.eq("status", "free")).first();
    if (!server) return { ok: false as const, error: "no_server" };
    const base = clean.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "team";
    let slug = base.length >= 2 ? base : `${base}-team`;
    for (let i = 2; await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(); i++) slug = `${base}-${i}`;
    const teamId = await ctx.db.insert("teams", { slug, name: clean, status: "active", serverUrl: server.url, createdAt: now });
    await ctx.db.insert("members", { teamId, userId: uid, role: "owner", peopleSlug, joinedAt: now });
    await ctx.db.patch(server._id, { status: "claimed", teamId });
    const team = (await ctx.db.get(teamId))!;
    const member = await ctx.db.query("members").withIndex("by_team_user", (q) => q.eq("teamId", teamId).eq("userId", uid)).unique();
    return { ok: true as const, team: shape(team, member ?? undefined), server: { serverId: server.serverId, url: server.url } };
  },
});

/** Undo `createOwned` when the server couldn't be claimed: the team goes, the server is free again. */
export const abandonCreate = mutation({
  args: { ...secretArg, teamId: v.id("teams") },
  handler: async (ctx, { secret, teamId }) => {
    assertService(secret);
    for (const m of await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", teamId)).collect()) await ctx.db.delete(m._id);
    const server = await ctx.db.query("teamServers").filter((q) => q.eq(q.field("teamId"), teamId)).first();
    if (server) await ctx.db.patch(server._id, { status: "free", teamId: undefined });
    await ctx.db.delete(teamId);
  },
});

/** The team's members, for anyone in the team. */
export const members = query({
  args: { ...secretArg, uid: v.id("users"), slug: v.string() },
  handler: async (ctx, { secret, uid, slug }) => {
    assertService(secret);
    const m = await membership(ctx, uid, slug);
    if (!m) return null;
    const all = await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", m.team._id)).collect();
    const out = [];
    for (const x of all) {
      const user = await ctx.db.get(x.userId);
      out.push({ uid: x.userId, name: user?.name ?? "Member", role: x.role, peopleSlug: x.peopleSlug, joinedAt: x.joinedAt });
    }
    const order = { owner: 0, admin: 1, member: 2 } as const;
    return out.sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));
  },
});

/** A new invite code (hashed by the gateway), by an owner or admin. */
export const invite = mutation({
  args: { ...secretArg, uid: v.id("users"), slug: v.string(), codeHash: v.string(), role: v.optional(role), uses: v.number(), days: v.number(), now: v.number() },
  handler: async (ctx, { secret, uid, slug, codeHash, role: r, uses, days, now }) => {
    assertService(secret);
    const m = await membership(ctx, uid, slug);
    if (!m) return { ok: false as const, error: "not_a_member" };
    if (!canManage(m.member.role)) return { ok: false as const, error: "forbidden" };
    const inviteRole = r === "admin" && m.member.role === "owner" ? "admin" : "member";
    const expiresAt = now + Math.min(Math.max(days, 1), 90) * 86_400_000;
    await ctx.db.insert("invites", { teamId: m.team._id, codeHash, role: inviteRole, usesLeft: Math.min(Math.max(uses, 1), 100), expiresAt, createdAt: now });
    return { ok: true as const, expiresAt, role: inviteRole };
  },
});

/** Remove someone: the owner removes anyone else, an admin removes members. Not the owner. */
export const removeMemberBy = mutation({
  args: { ...secretArg, uid: v.id("users"), slug: v.string(), target: v.string() },
  handler: async (ctx, { secret, uid, slug, target: raw }) => {
    assertService(secret);
    const target = ctx.db.normalizeId("users", raw);
    const m = await membership(ctx, uid, slug);
    if (!target) return { ok: false as const, error: "forbidden" };
    if (!m || !canManage(m.member.role) || target === uid) return { ok: false as const, error: "forbidden" };
    const t = await ctx.db.query("members").withIndex("by_team_user", (q) => q.eq("teamId", m.team._id).eq("userId", target)).unique();
    if (!t) return { ok: true as const };
    if (t.role === "owner" || (t.role === "admin" && m.member.role !== "owner")) return { ok: false as const, error: "forbidden" };
    await ctx.db.delete(t._id);
    return { ok: true as const };
  },
});

/** Make someone an admin or a member again (the owner only). */
export const setRole = mutation({
  args: { ...secretArg, uid: v.id("users"), slug: v.string(), target: v.string(), role: v.union(v.literal("admin"), v.literal("member")) },
  handler: async (ctx, { secret, uid, slug, target: raw, role: r }) => {
    assertService(secret);
    const target = ctx.db.normalizeId("users", raw);
    const m = await membership(ctx, uid, slug);
    if (!target) return { ok: false as const, error: "forbidden" };
    if (!m || m.member.role !== "owner" || target === uid) return { ok: false as const, error: "forbidden" };
    const t = await ctx.db.query("members").withIndex("by_team_user", (q) => q.eq("teamId", m.team._id).eq("userId", target)).unique();
    if (!t || t.role === "owner") return { ok: false as const, error: "forbidden" };
    await ctx.db.patch(t._id, { role: r });
    return { ok: true as const };
  },
});

/** Leave a team. The owner can't (someone has to own it); they'd hand it over first. */
export const leaveBySlug = mutation({
  args: { ...secretArg, uid: v.id("users"), slug: v.string() },
  handler: async (ctx, { secret, uid, slug }) => {
    assertService(secret);
    const m = await membership(ctx, uid, slug);
    if (!m) return { ok: true as const };
    if (m.member.role === "owner") return { ok: false as const, error: "owner_cannot_leave" };
    await ctx.db.delete(m.member._id);
    return { ok: true as const };
  },
});

// ---- The server pool (staff: `npx convex run teams:registerServer '{...}'`) ----

/** Add a provisioned, unclaimed team server to the pool. */
export const registerServer = internalMutation({
  args: { serverId: v.string(), url: v.string() },
  handler: async (ctx, { serverId, url }) => {
    const existing = await ctx.db.query("teamServers").withIndex("by_server", (q) => q.eq("serverId", serverId)).unique();
    if (existing) throw new ConvexError(`server ${serverId} is already registered (${existing.status})`);
    await ctx.db.insert("teamServers", { serverId, url: url.replace(/\/+$/, ""), status: "free", createdAt: Date.now() });
  },
});

/** Free servers left in the pool (the health check pings them and warns when none are left). */
export const freeServers = query({
  args: { ...secretArg },
  handler: async (ctx, { secret }) => {
    assertService(secret);
    const free = await ctx.db.query("teamServers").withIndex("by_status", (q) => q.eq("status", "free")).collect();
    return free.map((s) => ({ serverId: s.serverId, url: s.url }));
  },
});
