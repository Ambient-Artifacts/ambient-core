import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

/**
 * Who may make a new account on a server whose sign-ups aren't open (a self-hosted one): exact
 * emails and "@domain" entries. Absent: anyone (Ambient Cloud).
 */
const signupsArg = v.optional(v.object({ allow: v.array(v.string()) }));

function allowed(email: string, allow: string[]): boolean {
  const e = email.toLowerCase();
  return allow.some((a) => (a.startsWith("@") ? e.endsWith(a) : e === a));
}

/** Sign in with Apple: find or create the user for this Apple subject. */
export const upsertApple = mutation({
  args: {
    ...secretArg,
    appleSub: v.string(),
    email: v.optional(v.string()),
    /** Apple confirmed the email belongs to the person (a "Hide My Email" relay address counts too). */
    emailVerified: v.optional(v.boolean()),
    name: v.optional(v.string()),
    signups: signupsArg,
    now: v.number(),
  },
  handler: async (ctx, { secret, appleSub, email, emailVerified, name, signups, now }) => {
    assertService(secret);
    const existing = await ctx.db
      .query("users")
      .withIndex("by_appleSub", (q) => q.eq("appleSub", appleSub))
      .unique();
    if (existing) {
      // Apple sends name and email only on the first sign-in; keep what we have.
      const patch: { email?: string; name?: string } = {};
      if (email && !existing.email) patch.email = email;
      if (name && (existing.name === "Ambient user" || existing.name === "Brain user")) patch.name = name;
      if (existing.deletingAt) return null;  // being deleted; a new account once it's gone
      if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
      if (existing.disabled) return null;
      return { uid: existing._id, name: patch.name ?? existing.name, email: patch.email ?? existing.email ?? null, created: false };
    }
    if (signups) {
      // Sign-ups aren't open: the admin's account for this (Apple-verified) email takes the Apple
      // sign-in from now on, or the email is on the allow list, or there's no account.
      const verified = emailVerified && email ? email.toLowerCase() : null;
      const local = verified
        ? await ctx.db
            .query("users")
            .withIndex("by_localId", (q) => q.eq("localId", verified))
            .unique()
        : null;
      if (local && verified && !local.appleSub) {
        if (local.disabled || local.deletingAt) return null;
        // Apple's name replaces the placeholder `admin user add` made from the email.
        const better = name?.trim() && local.name === verified.split("@")[0] ? name.trim().slice(0, 80) : undefined;
        await ctx.db.patch(local._id, better ? { appleSub, name: better } : { appleSub });
        return { uid: local._id, name: better ?? local.name, email: local.email ?? verified, created: false };
      }
      if (!verified || !allowed(verified, signups.allow)) throw new ConvexError({ code: "not_invited" });
    }
    const uid = await ctx.db.insert("users", {
      appleSub,
      email,
      name: name?.trim() || "Ambient user",
      personalSeq: 0,
      createdAt: now,
    });
    return { uid, name: name?.trim() || "Ambient user", email: email ?? null, created: true };
  },
});

/**
 * Sign in with Microsoft: find or create the user for this Microsoft account ("tid:oid").
 * Separate from an Apple sign-in of the same person: accounts aren't joined by email, which
 * Microsoft doesn't guarantee is verified or stable.
 */
export const upsertMicrosoft = mutation({
  args: { ...secretArg, microsoftId: v.string(), email: v.optional(v.string()), name: v.optional(v.string()), signups: signupsArg, now: v.number() },
  handler: async (ctx, { secret, microsoftId, email, name, signups, now }) => {
    assertService(secret);
    const existing = await ctx.db
      .query("users")
      .withIndex("by_microsoftId", (q) => q.eq("microsoftId", microsoftId))
      .unique();
    if (existing) {
      // Microsoft sends name and email every time; fill gaps, never overwrite what the user set.
      const patch: { email?: string; name?: string } = {};
      if (email && !existing.email) patch.email = email;
      if (name?.trim() && (existing.name === "Ambient user" || existing.name === "Brain user")) patch.name = name.trim();
      if (existing.deletingAt) return null;  // being deleted; a new account once it's gone
      if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
      if (existing.disabled) return null;
      return { uid: existing._id, name: patch.name ?? existing.name, email: patch.email ?? existing.email ?? null, created: false };
    }
    // Microsoft doesn't vouch for the email in every tenant, so it can't match an allow list or
    // the admin's accounts: on a server whose sign-ups aren't open, no new Microsoft accounts.
    if (signups) throw new ConvexError({ code: "not_invited" });
    const uid = await ctx.db.insert("users", {
      microsoftId,
      email,
      name: name?.trim() || "Ambient user",
      personalSeq: 0,
      createdAt: now,
    });
    return { uid, name: name?.trim() || "Ambient user", email: email ?? null, created: true };
  },
});

export const get = query({
  args: { ...secretArg, uid: v.string() },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const id = ctx.db.normalizeId("users", uid);
    if (!id) return null;
    const u = await ctx.db.get(id);
    if (!u || u.disabled || u.deletingAt) return null;
    return {
      uid: u._id,
      name: u.name,
      email: u.email ?? null,
      personalSeq: u.personalSeq,
      consolidate: u.consolidate === true,
      consolidateAsked: u.consolidate !== undefined,
      digest: u.digest !== false,
    };
  },
});

/** The user's switches. `consolidate`: let Claude keep the personal wiki current (opt-in); `digest`: the morning push of open action items (on unless turned off). */
export const setPrefs = mutation({
  args: { ...secretArg, uid: v.id("users"), consolidate: v.optional(v.boolean()), digest: v.optional(v.boolean()) },
  handler: async (ctx, { secret, uid, consolidate, digest }) => {
    assertService(secret);
    await ctx.db.patch(uid, { ...(consolidate !== undefined ? { consolidate } : {}), ...(digest !== undefined ? { digest } : {}) });
  },
});

export const rename = mutation({
  args: { ...secretArg, uid: v.id("users"), name: v.string() },
  handler: async (ctx, { secret, uid, name }) => {
    assertService(secret);
    const trimmed = name.trim().slice(0, 80);
    if (trimmed) await ctx.db.patch(uid, { name: trimmed });
  },
});

// ---- Setup: has the user connected an AI app? ----

/** An AI app was approved or a personal token made: the app's setup reminder goes away. */
export const markAppConnected = mutation({
  args: { ...secretArg, uid: v.id("users"), now: v.number() },
  handler: async (ctx, { secret, uid, now }) => {
    assertService(secret);
    const u = await ctx.db.get(uid);
    if (u && !u.aiAppConnectedAt) await ctx.db.patch(uid, { aiAppConnectedAt: now });
  },
});

/**
 * Whether the user has connected an AI app. Accounts from before the field are checked once
 * against their tokens and grants; after that the answer is the field.
 */
export const checkAppConnected = mutation({
  args: { ...secretArg, uid: v.id("users"), now: v.number() },
  handler: async (ctx, { secret, uid, now }) => {
    assertService(secret);
    const u = await ctx.db.get(uid);
    if (!u) return { connected: false };
    if (u.aiAppConnectedAt) return { connected: true };
    if (u.aiAppCheckedAt) return { connected: false };
    const pats = await ctx.db.query("pats").withIndex("by_user", (q) => q.eq("userId", uid)).collect();
    let connected = pats.some((p) => !p.revokedAt);
    if (!connected) {
      // The Ambient apps' own sign-in is a grant too ("ambient-app", gateway oauth/provider.ts).
      const grants = await ctx.db.query("oauth").withIndex("by_model_account", (q) => q.eq("model", "Grant").eq("accountId", uid)).collect();
      connected = grants.some((g) => g.clientId !== "ambient-app");
    }
    if (!connected) {
      // Grants from before accountId had a column of its own: only those are read one by one.
      for await (const row of ctx.db.query("oauth").withIndex("by_model_account", (q) => q.eq("model", "Grant").eq("accountId", undefined))) {
        if (!row.payload.startsWith("{")) continue;
        try {
          const grant = JSON.parse(row.payload) as { accountId?: string; clientId?: string };
          if (grant.accountId === uid && grant.clientId !== "ambient-app") {
            connected = true;
            break;
          }
        } catch {
          // not ours to judge
        }
      }
    }
    await ctx.db.patch(uid, connected ? { aiAppConnectedAt: now } : { aiAppCheckedAt: now });
    return { connected };
  },
});

// ---- Deleting an account ----
//
// In two steps, so a big wiki never hits a mutation's limits: `beginDeletion` shuts the account
// (every token and query refuses it from then on) and settles its teams; `purgeBatch` then
// deletes its data a slice at a time until the user row itself goes. Signing in with the same
// Apple account afterwards starts a new, empty account.

/** Teams the user owns pass to their longest-standing admin, or member; a team with nobody else is canceled. */
export const beginDeletion = mutation({
  args: { ...secretArg, uid: v.id("users"), now: v.number() },
  handler: async (ctx, { secret, uid, now }) => {
    assertService(secret);
    const user = await ctx.db.get(uid);
    if (!user) return { ok: false as const, error: "not_found" };
    if (!user.deletingAt) await ctx.db.patch(uid, { deletingAt: now });
    const teams: { slug: string; outcome: "left" | "handed_over" | "canceled" }[] = [];
    const memberships = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", uid)).collect();
    for (const m of memberships) {
      const team = await ctx.db.get(m.teamId);
      let outcome: "left" | "handed_over" | "canceled" = "left";
      if (m.role === "owner") {
        const others = (await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", m.teamId)).collect())
          .filter((o) => o.userId !== uid)
          .sort((a, b) => a.joinedAt - b.joinedAt);
        const heir = others.find((o) => o.role === "admin") ?? others[0];
        if (heir) {
          // A co-owner already keeps the team; otherwise the heir becomes its owner.
          if (!others.some((o) => o.role === "owner")) await ctx.db.patch(heir._id, { role: "owner" });
          outcome = "handed_over";
        } else if (team) {
          await ctx.db.patch(team._id, { status: "canceled" });
          outcome = "canceled";
        }
      }
      await ctx.db.delete(m._id);
      if (team) teams.push({ slug: team.slug, outcome });
    }
    return { ok: true as const, teams };
  },
});

const PURGE_BATCH = 200;

/** Deletes up to `PURGE_BATCH` of the user's rows; the user row last. Call until `done`. */
export const purgeBatch = mutation({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const user = await ctx.db.get(uid);
    if (!user) return { done: true };
    if (!user.deletingAt) throw new Error("purgeBatch before beginDeletion");
    let left = PURGE_BATCH;
    const drop = async (ids: Id<any>[]) => {
      for (const id of ids) await ctx.db.delete(id);
      left -= ids.length;
    };
    const take = PURGE_BATCH;
    const byUser = (table: "personalWork" | "userKeys" | "repos" | "pairingCodes" | "appSessions" | "pats" | "routineHosts" | "pushDevices") =>
      ctx.db.query(table).withIndex("by_user", (q) => q.eq("userId", uid)).take(take);

    await drop((await ctx.db.query("personalPages").withIndex("by_user_path", (q) => q.eq("userId", uid)).take(left)).map((r) => r._id));
    if (left > 0) await drop((await ctx.db.query("personalTombstones").withIndex("by_user_path", (q) => q.eq("userId", uid)).take(left)).map((r) => r._id));
    if (left > 0) await drop((await ctx.db.query("sessionInbox").withIndex("by_user_session", (q) => q.eq("userId", uid)).take(left)).map((r) => r._id));
    if (left > 0) await drop((await ctx.db.query("sessionNotes").withIndex("by_user", (q) => q.eq("userId", uid)).take(left)).map((r) => r._id));
    for (const table of ["personalWork", "userKeys", "repos", "pairingCodes", "appSessions", "pats", "routineHosts", "pushDevices"] as const) {
      if (left <= 0) break;
      await drop((await byUser(table)).slice(0, left).map((r) => r._id));
    }
    if (left > 0) await purgeRoutines(ctx, uid, (n) => (left -= n), () => left);
    if (left <= 0) return { done: false };

    // Nothing of theirs is left: the user row goes too.
    await ctx.db.delete(uid);
    return { done: true };
  },
});

/** Their personal routines with their runs, and their personal secrets. A team's routines stay the team's. */
async function purgeRoutines(ctx: MutationCtx, uid: Id<"users">, spent: (n: number) => void, left: () => number) {
  const routines = await ctx.db.query("routines").withIndex("by_user", (q) => q.eq("userId", uid)).collect();
  for (const r of routines) {
    if (r.teamId) continue;
    const runs = await ctx.db.query("routineRuns").withIndex("by_routine", (q) => q.eq("routineId", r._id)).take(left());
    for (const run of runs) await ctx.db.delete(run._id);
    spent(runs.length);
    if (left() <= 0) return;
    await ctx.db.delete(r._id);
    spent(1);
    if (left() <= 0) return;
  }
  const secrets = await ctx.db.query("routineSecrets").withIndex("by_user", (q) => q.eq("userId", uid)).collect();
  for (const s of secrets) {
    if (s.teamId) continue;
    await ctx.db.delete(s._id);
    spent(1);
    if (left() <= 0) return;
  }
}
