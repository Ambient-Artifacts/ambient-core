// What changed, for the apps: one small, live answer per user that says which of their things
// moved since they last looked. The gateway subscribes to `forUser` for every open app and
// streams it on; apps compare it with what they have and fetch only what moved, so a tab never
// reloads what didn't change and a change made elsewhere shows up while the app is open.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";

async function bump(ctx: MutationCtx, key: string, head?: string): Promise<number> {
  const doc = await ctx.db.query("revisions").withIndex("by_key", (q) => q.eq("key", key)).unique();
  const now = Date.now();
  if (!doc) {
    await ctx.db.insert("revisions", { key, rev: 1, updatedAt: now, ...(head ? { head } : {}) });
    return 1;
  }
  await ctx.db.patch(doc._id, { rev: doc.rev + 1, updatedAt: now, ...(head ? { head } : {}) });
  return doc.rev + 1;
}

/** A team's wiki changed (the gateway delivered a note or a work session to it). */
export const bumpTeam = mutation({
  args: { ...secretArg, teamId: v.id("teams") },
  handler: async (ctx, { secret, teamId }) => {
    assertService(secret);
    return await bump(ctx, `team:${teamId}`);
  },
});

/**
 * What the health check saw on a team's server: its git head. A head that moved (the nightly
 * run, edits pulled from the team's repo) counts as a change; the first one seen is recorded.
 */
export const noteTeamHead = mutation({
  args: { ...secretArg, teamId: v.id("teams"), head: v.string() },
  handler: async (ctx, { secret, teamId, head }) => {
    assertService(secret);
    const key = `team:${teamId}`;
    const doc = await ctx.db.query("revisions").withIndex("by_key", (q) => q.eq("key", key)).unique();
    // The first head seen for a team is only recorded: nothing to tell the apps yet.
    if (!doc) {
      await ctx.db.insert("revisions", { key, rev: 0, head, updatedAt: Date.now() });
      return { changed: false, rev: 0 };
    }
    if (doc.head === undefined) {
      await ctx.db.patch(doc._id, { head });
      return { changed: false, rev: doc.rev };
    }
    if (doc.head === head) return { changed: false, rev: doc.rev };
    return { changed: true, rev: await bump(ctx, key, head) };
  },
});

/** FNV-1a over a string, as a short hex fingerprint (queries can't use async crypto). */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length.toString(36)}-${h.toString(16)}`;
}

function routineLine(r: Doc<"routines">): string {
  const last = r.lastRun;
  return `r:${r._id}:${r.updatedAt}:${r.enabled ? 1 : 0}:${r.runRequestedAt ?? 0}:${r.hostId ?? ""}:${last?.status ?? ""}:${last?.startedAt ?? 0}:${last?.finishedAt ?? 0}`;
}

function hostLine(h: Doc<"routineHosts">): string {
  // Not lastSeenAt: computers check in every minute, and that alone changes nothing shown.
  return `h:${h._id}:${h.name}:${h.tokenHash ? 1 : 0}:${h.codeExpiresAt ?? 0}:${h.info?.claude ?? ""}:${h.info?.runner ?? ""}:${h.info?.hostname ?? ""}`;
}

/**
 * The user's revisions: their personal pages (`users.personalSeq`), a fingerprint of their
 * routines and computers and their teams', and each team's wiki revision. Live: Convex
 * re-runs it when any of those change, joining or leaving a team included.
 */
export const forUser = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const user = await ctx.db.get(uid);
    if (!user || user.deletingAt) return null;
    const lines: string[] = [];
    const seen = new Set<Id<"routines">>();
    const addRoutines = (rs: Doc<"routines">[]) => {
      for (const r of rs) {
        if (seen.has(r._id)) continue;
        seen.add(r._id);
        lines.push(routineLine(r));
      }
    };
    addRoutines(await ctx.db.query("routines").withIndex("by_user", (q) => q.eq("userId", uid)).collect());
    for (const h of await ctx.db.query("routineHosts").withIndex("by_user", (q) => q.eq("userId", uid)).collect()) lines.push(hostLine(h));

    const teams: { slug: string; wiki: number }[] = [];
    for (const m of await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", uid)).collect()) {
      const team = await ctx.db.get(m.teamId);
      if (!team || team.status === "canceled") continue;
      const rev = await ctx.db.query("revisions").withIndex("by_key", (q) => q.eq("key", `team:${team._id}`)).unique();
      teams.push({ slug: team.slug, wiki: rev?.rev ?? 0 });
      addRoutines(await ctx.db.query("routines").withIndex("by_team", (q) => q.eq("teamId", team._id)).collect());
      for (const h of await ctx.db.query("routineHosts").withIndex("by_team", (q) => q.eq("teamId", team._id)).collect()) lines.push(hostLine(h));
    }
    lines.sort();
    teams.sort((a, b) => a.slug.localeCompare(b.slug));
    return { personal: user.personalSeq, routines: fingerprint(lines.join("|")), teams };
  },
});
