// Work sessions with AI agents: the inbox the gateway fills, the session notes the worker
// writes, and the hold before a note goes to a team. Content is sealed by the gateway with
// the user's data key; Convex only sees ciphertext, titles and timestamps.
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

const MAX_ATTEMPTS = 5;

// ---- inbox ----

/** A session arrived (or arrived again, longer: a resumed session). Replaces what was waiting. */
export const enqueue = mutation({
  args: { ...secretArg, uid: v.id("users"), sessionId: v.string(), iv: v.string(), ciphertext: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, sessionId, iv, ciphertext, now }) => {
    assertService(secret);
    const row = { userId: uid, sessionId, iv, ciphertext, receivedAt: now, attempts: 0, leaseUntil: 0, lastError: undefined };
    const existing = await ctx.db
      .query("sessionInbox")
      .withIndex("by_user_session", (q) => q.eq("userId", uid).eq("sessionId", sessionId))
      .unique();
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("sessionInbox", row);
  },
});

/** Take up to `limit` waiting sessions for `leaseMs` (another worker skips them meanwhile). */
export const claim = mutation({
  args: { ...secretArg, now: v.number(), limit: v.number(), leaseMs: v.number() },
  handler: async (ctx, { secret, now, limit, leaseMs }) => {
    assertService(secret);
    const free = await ctx.db
      .query("sessionInbox")
      .withIndex("by_lease", (q) => q.lt("leaseUntil", now))
      .take(limit * 4);
    const out = [];
    for (const row of free) {
      if (row.attempts >= MAX_ATTEMPTS) continue;
      await ctx.db.patch(row._id, { leaseUntil: now + leaseMs });
      out.push({ id: row._id, uid: row.userId, sessionId: row.sessionId, iv: row.iv, ciphertext: row.ciphertext, attempts: row.attempts });
      if (out.length >= limit) break;
    }
    return out;
  },
});

export const done = mutation({
  args: { ...secretArg, id: v.id("sessionInbox") },
  handler: async (ctx, { secret, id }) => {
    assertService(secret);
    if (await ctx.db.get(id)) await ctx.db.delete(id);
  },
});

/** Try again later, a little later each time; after MAX_ATTEMPTS the health check flags it. */
export const failed = mutation({
  args: { ...secretArg, id: v.id("sessionInbox"), error: v.string(), now: v.number() },
  handler: async (ctx, { secret, id, error, now }) => {
    assertService(secret);
    const row = await ctx.db.get(id);
    if (!row) return;
    const attempts = row.attempts + 1;
    await ctx.db.patch(id, { attempts, lastError: error.slice(0, 300), leaseUntil: now + attempts * 2 * 60_000 });
  },
});

// ---- session notes ----

function noteShape(n: Doc<"sessionNotes">) {
  return {
    id: n._id,
    uid: n.userId,
    sessionId: n.sessionId,
    noteId: n.noteId,
    path: n.path,
    title: n.title,
    tool: n.tool,
    contentHash: n.contentHash ?? null,
    teamId: n.teamId ?? null,
    share: n.share ?? null,
    shareDueAt: n.shareDueAt ?? null,
  };
}

export const noteFor = query({
  args: { ...secretArg, uid: v.id("users"), sessionId: v.string() },
  handler: async (ctx, { secret, uid, sessionId }) => {
    assertService(secret);
    const n = await ctx.db
      .query("sessionNotes")
      .withIndex("by_user_session", (q) => q.eq("userId", uid).eq("sessionId", sessionId))
      .unique();
    return n ? noteShape(n) : null;
  },
});

/**
 * Record the session's note, and (with `share`) hold it for a team until `dueAt`. A note that
 * already went to the team, or that the user kept personal, isn't shared again: a resumed
 * session updates the personal note only.
 */
export const saveNote = mutation({
  args: {
    ...secretArg,
    uid: v.id("users"),
    sessionId: v.string(),
    noteId: v.string(),
    path: v.string(),
    title: v.string(),
    tool: v.string(),
    contentHash: v.optional(v.string()),
    share: v.optional(v.object({ teamId: v.id("teams"), iv: v.string(), ciphertext: v.string(), dueAt: v.number() })),
    now: v.number(),
  },
  handler: async (ctx, { secret, uid, sessionId, noteId, path, title, tool, contentHash, share, now }) => {
    assertService(secret);
    const existing = await ctx.db
      .query("sessionNotes")
      .withIndex("by_user_session", (q) => q.eq("userId", uid).eq("sessionId", sessionId))
      .unique();
    const settled = existing?.share === "delivered" || existing?.share === "kept";
    const shareFields =
      share && !settled
        ? {
            teamId: share.teamId,
            share: "pending" as const,
            // A resumed session keeps the original deadline: the user already saw it coming.
            shareDueAt: existing?.share === "pending" ? existing.shareDueAt : share.dueAt,
            shareIv: share.iv,
            shareCiphertext: share.ciphertext,
            shareAttempts: 0,
          }
        : {};
    if (existing) {
      await ctx.db.patch(existing._id, { path, title, tool, contentHash, updatedAt: now, ...shareFields });
      return { id: existing._id, share: shareFields.share ?? existing.share ?? null };
    }
    const id = await ctx.db.insert("sessionNotes", { userId: uid, sessionId, noteId, path, title, tool, contentHash, createdAt: now, updatedAt: now, ...shareFields });
    return { id, share: shareFields.share ?? null };
  },
});

/** Shares whose hold is over. */
export const dueShares = query({
  args: { ...secretArg, now: v.number(), limit: v.number() },
  handler: async (ctx, { secret, now, limit }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("sessionNotes")
      .withIndex("by_share_due", (q) => q.eq("share", "pending").lte("shareDueAt", now))
      .take(limit);
    return rows.map((n) => ({ ...noteShape(n), iv: n.shareIv ?? "", ciphertext: n.shareCiphertext ?? "", attempts: n.shareAttempts ?? 0 }));
  },
});

export const shareDelivered = mutation({
  args: { ...secretArg, id: v.id("sessionNotes"), now: v.number() },
  handler: async (ctx, { secret, id, now }) => {
    assertService(secret);
    await ctx.db.patch(id, { share: "delivered", shareIv: undefined, shareCiphertext: undefined, updatedAt: now });
  },
});

/** The team server didn't take it: try again in a few minutes. */
export const shareFailed = mutation({
  args: { ...secretArg, id: v.id("sessionNotes"), now: v.number() },
  handler: async (ctx, { secret, id, now }) => {
    assertService(secret);
    const n = await ctx.db.get(id);
    if (!n || n.share !== "pending") return;
    const attempts = (n.shareAttempts ?? 0) + 1;
    await ctx.db.patch(id, { shareAttempts: attempts, shareDueAt: now + Math.min(attempts, 12) * 5 * 60_000 });
  },
});

/** The user's sessions waiting to go to a team, soonest first (the app's "Sharing soon"). */
export const pending = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("sessionNotes")
      .withIndex("by_user", (q) => q.eq("userId", uid))
      .order("desc")
      .take(200);
    return rows
      .filter((n) => n.share === "pending")
      .map(noteShape)
      .sort((a, b) => (a.shareDueAt ?? 0) - (b.shareDueAt ?? 0));
  },
});

/** "Keep personal": the share is dropped and the note stays in the personal wiki. */
export const keepPersonal = mutation({
  args: { ...secretArg, uid: v.id("users"), sessionId: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, sessionId, now }) => {
    assertService(secret);
    const n = await ctx.db
      .query("sessionNotes")
      .withIndex("by_user_session", (q) => q.eq("userId", uid).eq("sessionId", sessionId))
      .unique();
    if (!n || n.share !== "pending") return { ok: false as const };
    await ctx.db.patch(n._id, { share: "kept", shareIv: undefined, shareCiphertext: undefined, updatedAt: now });
    return { ok: true as const };
  },
});

/** Session notes still filed under wiki/notes/ (before work sessions had their own folder). */
export const legacyNotes = query({
  args: { ...secretArg, limit: v.number() },
  handler: async (ctx, { secret, limit }) => {
    assertService(secret);
    const out = [];
    for await (const n of ctx.db.query("sessionNotes")) {
      if (n.path.startsWith("wiki/notes/")) out.push({ id: n._id, uid: n.userId, path: n.path });
      if (out.length >= limit) break;
    }
    return out;
  },
});

export const setPath = mutation({
  args: { ...secretArg, id: v.id("sessionNotes"), path: v.string(), now: v.number() },
  handler: async (ctx, { secret, id, path, now }) => {
    assertService(secret);
    await ctx.db.patch(id, { path, updatedAt: now });
  },
});

// ---- rules ----

export const rules = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    return (await ctx.db.get(uid))?.sessionRules ?? [];
  },
});

export const setRules = mutation({
  args: { ...secretArg, uid: v.id("users"), rules: v.array(v.object({ match: v.string(), team: v.string() })) },
  handler: async (ctx, { secret, uid, rules }) => {
    assertService(secret);
    await ctx.db.patch(uid, { sessionRules: rules.slice(0, 50) });
  },
});

// ---- health ----

/** Sessions stuck in the inbox and shares overdue, for the health check. */
export const backlog = query({
  args: { ...secretArg, now: v.number() },
  handler: async (ctx, { secret, now }) => {
    assertService(secret);
    let stuck = 0;
    let failedForGood = 0;
    let lastError: string | null = null;
    for await (const row of ctx.db.query("sessionInbox")) {
      if (row.attempts >= MAX_ATTEMPTS) {
        failedForGood++;
        lastError = row.lastError ?? lastError;
      } else if (row.receivedAt < now - 30 * 60_000) stuck++;
    }
    // Overdue: past the hold by 30 minutes, or refused by the team server three times or more.
    const pendingShares = await ctx.db
      .query("sessionNotes")
      .withIndex("by_share_due", (q) => q.eq("share", "pending"))
      .take(1000);
    const overdue = pendingShares.filter((n) => (n.shareDueAt ?? 0) < now - 30 * 60_000 || (n.shareAttempts ?? 0) >= 3).length;
    return { stuck, failed: failedForGood, lastError, overdueShares: overdue };
  },
});
